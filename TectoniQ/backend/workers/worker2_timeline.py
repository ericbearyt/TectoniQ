"""
Worker 2 — 1D Timeline Mapper
==============================
Consumes the output of Worker 1 (sections + term_frequency) and produces
a chronological event timeline for each term, recording every position
(section_id, page) where it appears, as well as first_seen, last_seen,
and a recurrence_gap (number of sections between first and last mention).

Performance
-----------
Builds an **inverted index** once: each section is tokenized a single time
(using the same tokenizer Worker 1 used to build term_frequency), mapping
``token -> [section refs in document order]``. Single-word term lookups are
then O(1) dict hits instead of a regex scan of every section's full text per
term. Complexity drops from O(terms × sections × content_length) to
roughly O(sections × content_length + terms). Multi-word terms (rare — Worker 1
emits single tokens) fall back to a substring scan over each section's
once-normalized content.

Output contract
---------------
{
    "timeline": [
        {
            "term": "tamoxifen",
            "count": 8,
            "first_seen": { "section_id": "s1", "section_header": "Assessment", "page": 2 },
            "last_seen":  { "section_id": "s6", "section_header": "Plan", "page": 9 },
            "occurrences": [
                { "section_id": "s1", "section_header": "Assessment", "page": 2 },
                { "section_id": "s4", "section_header": "Medications", "page": 6 }
            ],
            "recurrence_gap": 3,
            "sections_present": ["s1", "s4", "s6"]
        }
    ]
}
"""

import re
from collections import defaultdict

from ._text import normalize, tokenize


# 1. MM/DD/YYYY or M/D/YY  →  groups: month, day, year
_DATE_PATTERN_NUMERIC = re.compile(r"\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})\b")
# 2. Month DD, YYYY or Month YYYY  →  groups: month, day (optional), year
_DATE_PATTERN_ALPHA = re.compile(
    r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(\d{1,2})?(?:st|nd|rd|th)?,?\s*(\d{4})\b",
    re.IGNORECASE,
)

_MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _format_date(mon: str, day: str | None, year: str) -> str:
    """Render a date as 'Mon DD, YYYY', or 'Mon YYYY' when no day is known."""
    if day:
        return f"{mon} {int(day)}, {year}"
    return f"{mon} {year}"


def _dates_in(text: str) -> list[str]:
    """Pull every Month/Day/Year and MM/DD/YYYY date out of a string, in order."""
    found = []
    for m in _DATE_PATTERN_ALPHA.finditer(text):
        mon = m.group(1)[:3].title()
        day = m.group(2)
        year = m.group(3)
        found.append(_format_date(mon, day, year))
    for m in _DATE_PATTERN_NUMERIC.finditer(text):
        try:
            mon_idx = int(m.group(1))
            day = m.group(2)
            year = m.group(3)
            if len(year) == 2:
                year = "20" + year
            if 1 <= mon_idx <= 12:
                found.append(_format_date(_MONTH_NAMES[mon_idx], day, year))
        except Exception:
            pass
    return found


def extract_dates_near_term(term: str, content: str) -> list[str]:
    """Extract dates (Month Day, Year / Month Year / MM/DD/YYYY) near the term.

    Keeps the day-of-month so distinct visits in the same month stay distinct
    (e.g. two hospital admissions in March 2024 do not collapse to 'Mar 2024').
    """
    term_escaped = re.escape(term)

    dates = []
    # Scan a ±60-char window around *every* mention of the term. Matching the
    # term itself (not the whole window) keeps windows independent, so adjacent
    # mentions don't get swallowed and later visit dates aren't lost.
    pattern = re.compile(term_escaped, re.IGNORECASE)
    for match in pattern.finditer(content):
        start = max(0, match.start() - 60)
        end = min(len(content), match.end() + 60)
        dates.extend(_dates_in(content[start:end]))

    # Fallback to whole section if no dates were found near the term
    if not dates:
        dates = _dates_in(content)

    # Deduplicate and preserve order
    seen = set()
    unique_dates = []
    for d in dates:
        if d not in seen:
            seen.add(d)
            unique_dates.append(d)
    return unique_dates


def run(worker1_output: dict) -> dict:
    """
    Main entry point for Worker 2.

    Parameters
    ----------
    worker1_output : dict
        Output from worker1_frequency.run()
        Must contain: sections[], term_frequency{}

    Returns
    -------
    dict
        { "timeline": [ ... ] }
    """
    sections = worker1_output["sections"]
    term_frequency = worker1_output["term_frequency"]

    # Section position lookup, used for recurrence_gap and final sort.
    section_index = {s["id"]: i for i, s in enumerate(sections)}

    # ---- Build the inverted index once (single tokenize pass per section) ----
    postings: dict[str, list[dict]] = defaultdict(list)
    for section in sections:
        ref = {
            "section_id": section["id"],
            "section_header": section["header"],
            "page": section["page"],
        }
        for token in set(tokenize(section["content"])):
            postings[token].append(ref)

    # Sort each postings list by section position so occurrences stay in order.
    for token in postings:
        postings[token].sort(key=lambda r: section_index.get(r["section_id"], 0))

    def _occurrences_for(term: str) -> list[dict]:
        normalized_term = normalize(term).strip()
        matching_sections = []
        if " " in normalized_term:
            # Multi-word: substring scan over each section's content.
            for section in sections:
                if normalized_term in normalize(section["content"]):
                    matching_sections.append(section)
        else:
            # Single-word: direct postings hit.
            matching_refs = postings.get(normalized_term, [])
            matching_ids = {r["section_id"] for r in matching_refs}
            matching_sections = [s for s in sections if s["id"] in matching_ids]

        occurrences = []
        for sec in matching_sections:
            dates = extract_dates_near_term(term, sec["content"])
            occurrences.append({
                "section_id": sec["id"],
                "section_header": sec["header"],
                "page": sec["page"],
                "dates": dates
            })
        return occurrences

    timeline = []
    for term, count in term_frequency.items():
        occurrences = _occurrences_for(term)
        if not occurrences:
            continue

        first_seen = occurrences[0]
        last_seen = occurrences[-1]

        first_idx = section_index.get(first_seen["section_id"], 0)
        last_idx = section_index.get(last_seen["section_id"], 0)
        recurrence_gap = last_idx - first_idx

        # Gather all unique dates for this term across all occurrences
        all_dates = []
        date_seen = set()
        for occ in occurrences:
            for d in occ["dates"]:
                if d not in date_seen:
                    date_seen.add(d)
                    all_dates.append(d)

        timeline.append({
            "term": term,
            "count": count,
            "first_seen": first_seen,
            "last_seen": last_seen,
            "occurrences": occurrences,
            "recurrence_gap": recurrence_gap,
            "sections_present": [o["section_id"] for o in occurrences],
            "dates": all_dates,
        })

    # Sort timeline by first appearance (section order); stable on ties.
    timeline.sort(key=lambda e: section_index.get(e["first_seen"]["section_id"], 0))

    return {"timeline": timeline}

