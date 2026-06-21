"""
Worker 7 — Clinical Term Filter / Vocabulary Linker
====================================================
Two modes, selected by the USE_CLINICAL_LINKER env flag (rollout: flag-gated,
legacy path stays the safe default):

LEGACY (flag off, or linker unavailable):
    The original behaviour — filter term_frequency against the local
    medical_terminology.json allowlist + a curated blacklist. Downstream
    Workers 2 → 3 run unchanged. Surface-string keyed.

LINKER (flag on AND scispaCy/UMLS available):
    The agreed vocabulary-linking engine. scispaCy NER + UMLS linker provide the
    allowlist (a span survives only if it links to a clinical concept), medspaCy
    ConText flags negation, TUIs map to categories, and spans are grouped BY CUI
    into a concept-keyed timeline. "MI" and "myocardial infarction" collapse to
    one concept. Worker 2 (string search) is bypassed — this worker emits the
    timeline itself, since grouping linked spans by CUI *is* the timeline.

    Each concept is also flagged needs_adjudication when its category is a soft
    guess (Worker 3 / Gemini then adjudicates a capped subset — see app.py).

Output adds: linker_used (bool), concepts[] (when linker_used), and either a
filtered term_frequency (legacy) or a concept-keyed timeline[] (linker).
"""

from __future__ import annotations

import os
import json

from . import clinical_linker
from .worker2_timeline import extract_dates_near_term

# ── Feature flag ──────────────────────────────────────────────────────────
def _linker_enabled() -> bool:
    return os.getenv("USE_CLINICAL_LINKER", "0").strip().lower() in ("1", "true", "yes", "on")

# Accept ceiling shared with the linker module (concepts below this, or with a
# soft category, get routed to Gemini adjudication).
LINK_ACCEPT = clinical_linker.LINK_ACCEPT


# ───────────────────────────────────────────────────────────────────────────
# LEGACY path (unchanged behaviour)
# ───────────────────────────────────────────────────────────────────────────
_DB_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "medical_terminology.json")
)

BLACKLIST = {
    "doctor", "hospital", "patient", "clinic", "facility", "attending", "resident", "physician", "nurse",
    "practitioner", "provider", "md", "do", "rn", "staff", "attending's", "resident's", "physician's",
    "history", "present", "illness", "chief", "complaint", "assessment", "plan", "follow", "followup",
    "visit", "visits", "admission", "discharge", "disposition", "status", "summary", "progress",
    "report", "information", "confidential", "record", "records", "note", "notes", "chart", "charts",
    "date", "time", "page", "pages", "telephone", "phone", "fax", "email", "address", "name",
    "mrn", "dob", "age", "sex", "gender", "female", "male", "patient's", "years", "months", "weeks",
    "days", "year", "month", "week", "day", "hour", "minute", "hours", "minutes",
    "daily", "twice", "bedtime", "morning", "evening", "night", "every", "each", "prior", "emergency", "department",
    "normal", "abnormal", "stable", "worsening", "elevated", "lowered", "increase", "decrease",
    "start", "stop", "continue", "recommended", "recommendations", "instructions", "education",
    "counseling", "support", "services", "general", "appearance", "system", "systems", "review",
    "exam", "examination", "social", "family", "surgical", "medical", "clinical", "health",
    "active", "resolved", "chronic", "acute", "yes", "no", "none", "noted", "negative", "positive",
    "primary", "secondary", "referred", "referral", "refer", "initial", "previous",
    "left", "right", "bilateral", "lateral", "medial", "anterior", "posterior", "superior", "inferior",
    "distal", "proximal", "unilateral", "upper", "lower", "middle", "side", "sides",
    "similar", "same", "different", "other", "another", "new", "old", "first", "second", "third",
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "last", "past",
    "since", "birth", "born", "death", "died", "deceased", "well", "good", "poor", "poorly", "controlled",
    "likely", "unlikely", "possible", "impossible", "probable", "definite", "hx",
    "over", "under", "above", "below", "before", "after", "within", "without",
    "cornell", "university", "school", "hospitalist", "attending physician", "attending doctor", "dr",
    "eric", "nguyen", "doe", "john", "jane", "smith"
}

MEDICAL_WORDS: set[str] = set()


def _load_medical_words():
    global MEDICAL_WORDS
    try:
        with open(_DB_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            MEDICAL_WORDS = {k.lower() for k in data.keys()}
        print(f"[Worker 7] Loaded {len(MEDICAL_WORDS):,} terms from clinical database.")
    except Exception as e:
        print(f"[Worker 7] Warning: Could not load medical database from {_DB_PATH}: {e}")
        MEDICAL_WORDS = set()


_load_medical_words()


def _run_legacy(worker6_output: dict) -> dict:
    term_frequency = worker6_output.get("term_frequency", {})
    filtered_frequency = {}
    for term, count in term_frequency.items():
        term_lower = term.lower()
        if term_lower in BLACKLIST:
            continue
        if len(term_lower) < 3 or term_lower.isdigit():
            continue
        if term_lower not in MEDICAL_WORDS:
            continue
        filtered_frequency[term] = count

    output = dict(worker6_output)
    output["term_frequency"] = filtered_frequency
    output["linker_used"] = False
    return output


# ───────────────────────────────────────────────────────────────────────────
# LINKER path (concept-keyed)
# ───────────────────────────────────────────────────────────────────────────
def _build_concept_timeline(concepts: list[dict], sections: list[dict]) -> list[dict]:
    """Turn grouped concepts into the timeline contract (concept = row)."""
    section_index = {s["id"]: i for i, s in enumerate(sections)}
    content_by_id = {s["id"]: s.get("content", "") for s in sections}

    timeline = []
    for c in concepts:
        # Order occurrences by document position.
        occ_sorted = sorted(
            c["occurrences"],
            key=lambda o: section_index.get(o["section_id"], 0),
        )

        # Enrich each occurrence with dates (reuse Worker 2's date extractor over
        # the observed surface forms) and a negated flag (negated when no asserted
        # mention of the concept survives in that section).
        enriched = []
        for o in occ_sorted:
            content = content_by_id.get(o["section_id"], "")
            dates: list[str] = []
            seen = set()
            for surf in o.get("surfaces", []):
                for d in extract_dates_near_term(surf, content):
                    if d not in seen:
                        seen.add(d)
                        dates.append(d)
            enriched.append({
                "section_id": o["section_id"],
                "section_header": o["section_header"],
                "page": o["page"],
                "section_group": o.get("section_group", "other"),
                "negated": o["asserted"] == 0 and o["negated"] > 0,
                "surfaces": o.get("surfaces", []),
                "dates": dates,
            })

        # Presence is computed from ASSERTED occurrences only (Q8-C); negated
        # mentions are retained but don't define first/last seen.
        asserted_occ = [o for o in enriched if not o["negated"]]
        ordering_occ = asserted_occ or enriched  # purely-negated concept falls back

        first_seen = ordering_occ[0]
        last_seen = ordering_occ[-1]
        first_idx = section_index.get(first_seen["section_id"], 0)
        last_idx = section_index.get(last_seen["section_id"], 0)

        all_dates: list[str] = []
        date_seen = set()
        for o in enriched:
            for d in o["dates"]:
                if d not in date_seen:
                    date_seen.add(d)
                    all_dates.append(d)

        needs_adj = (
            (not c["confident"])
            or c["category"] == "other"
            or c["best_score"] < LINK_ACCEPT
        )

        timeline.append({
            "term": c["canonical_name"],
            "cui": c["cui"],
            "aliases": c["aliases"],
            "category": c["category"],
            "semantic_types": c["semantic_types"],
            "count": c["asserted_total"],
            "negated_count": c["negated_total"],
            "link_score": c["best_score"],
            "needs_adjudication": needs_adj,
            "status": "historical" if c["asserted_total"] == 0 else "unknown",
            "ner_confidence": "unreviewed",
            "first_seen": {k: first_seen[k] for k in ("section_id", "section_header", "page")},
            "last_seen": {k: last_seen[k] for k in ("section_id", "section_header", "page")},
            "occurrences": enriched,
            "recurrence_gap": last_idx - first_idx,
            "sections_present": [o["section_id"] for o in enriched],
            "dates": all_dates,
        })

    # Sort by first asserted appearance, then by frequency desc as tiebreak.
    timeline.sort(
        key=lambda e: (section_index.get(e["first_seen"]["section_id"], 0), -e["count"])
    )
    return timeline


def _run_linker(worker6_output: dict, progress=None) -> dict:
    sections = worker6_output.get("sections", [])
    concepts = clinical_linker.analyze_sections(sections, progress=progress)
    if concepts is None:
        # Linker unavailable at runtime → graceful fallback.
        print("[Worker 7] Linker unavailable — falling back to legacy filter.")
        return _run_legacy(worker6_output)

    timeline = _build_concept_timeline(concepts, sections)

    # Back-compat term_frequency (canonical name → asserted count) for any
    # legacy consumer and Worker 3's top-N selection.
    term_frequency = {c["canonical_name"]: c["asserted_total"] for c in concepts}

    output = dict(worker6_output)
    output["term_frequency"] = term_frequency
    output["concepts"] = concepts
    output["timeline"] = timeline
    output["linker_used"] = True
    print(
        f"[Worker 7] Linker: {len(concepts)} concepts "
        f"({sum(1 for t in timeline if t['needs_adjudication'])} need adjudication)"
    )
    return output


# ───────────────────────────────────────────────────────────────────────────
def run(worker6_output: dict, progress=None) -> dict:
    """
    Filter / link clinical terms.

    Parameters
    ----------
    worker6_output : dict
        Output from Worker 6 (sections[], term_frequency{}, page_count,
        section_outline[]).
    progress : callable(done:int, total:int) | None
        Optional per-section progress callback (linker mode only).

    Returns
    -------
    dict
        Legacy: worker6_output with a filtered term_frequency.
        Linker: adds concepts[], a concept-keyed timeline[], and linker_used=True.
    """
    if _linker_enabled():
        return _run_linker(worker6_output, progress=progress)
    return _run_legacy(worker6_output)
