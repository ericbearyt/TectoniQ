"""
workers/keyterm_extractor.py  —  Worker 3
──────────────────────────────────────────
Identifies clinically significant terms in document sections,
tracks their frequency per patient, and builds a longitudinal timeline.

Strategy (two-tier):
  Tier 1 — Rule-based: curated medical keyword dictionary (fast, no ML required).
  Tier 2 — NLP/NER: spaCy + SciSpacy biomedical model (richer entity detection).
             Falls back gracefully if scispacy is not installed.

Timeline entry schema:
  {
    "document_id": str,
    "date": ISO-8601 str,
    "terms": [{"term": str, "category": str, "section": str}],
    "section_counts": {"MEDICATIONS": 3, "ASSESSMENT": 2, ...}
  }
"""

from __future__ import annotations

import re
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Optional

from workers.document_scanner import DocumentSection, ScanResult
from fhir import store as fhir_store
from audit.audit_log import log_event

# ── Optional: dateparser for temporal expression extraction ───────────────────
try:
    import dateparser
    DATEPARSER_AVAILABLE = True
except ImportError:
    DATEPARSER_AVAILABLE = False

# ── Optional: spaCy + SciSpacy ────────────────────────────────────────────────
try:
    import spacy
    # Try biomedical model first, fall back to general English
    try:
        _nlp = spacy.load("en_core_sci_sm")
        _NLP_MODEL = "en_core_sci_sm"
    except OSError:
        try:
            _nlp = spacy.load("en_core_web_sm")
            _NLP_MODEL = "en_core_web_sm"
        except OSError:
            _nlp = None
            _NLP_MODEL = None
    SPACY_AVAILABLE = _nlp is not None
except ImportError:
    SPACY_AVAILABLE = False
    _nlp = None
    _NLP_MODEL = None


# ─────────────────────────────────────────────────────────────────────────────
# Curated clinical keyword dictionary (Tier 1)
# Keys = normalized terms, Values = clinical category
# ─────────────────────────────────────────────────────────────────────────────

CLINICAL_KEYWORDS: dict[str, str] = {}
def _load_clinical_keywords() -> dict[str, str]:
    db_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "medical_terminology.json"))
    try:
        with open(db_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Warning: Could not load {db_path}: {e}")
        return {}

CLINICAL_KEYWORDS = _load_clinical_keywords()

# Temporal markers used to estimate when something occurred
_TEMPORAL_PATTERNS = [
    r"\b(\d+)\s+(year|month|week|day)s?\s+ago\b",
    r"\bsince\s+(\d{4})\b",
    r"\bfor\s+(?:the\s+past|the\s+last)?\s+(\d+)\s+(year|month|week|day)s?\b",
    r"\b(January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+(\d{4})\b",
    r"\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})\b",
]
_TEMPORAL_RE = re.compile("|".join(_TEMPORAL_PATTERNS), re.IGNORECASE)


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _keyword_scan(text: str, section_name: str) -> list[dict]:
    """Tier-1 rule-based scan using the curated keyword dictionary."""
    text_lower = text.lower()
    hits = []

    for term, category in CLINICAL_KEYWORDS.items():
        # Whole-word match (avoid partial hits like 'mi' inside 'family')
        pattern = r"\b" + re.escape(term) + r"\b"
        if re.search(pattern, text_lower):
            hits.append({
                "term": term,
                "category": category,
                "section": section_name,
                "source": "keyword_dict",
            })

    return hits


def _nlp_scan(text: str, section_name: str) -> list[dict]:
    """Tier-2 NLP/NER scan using spaCy (SciSpacy preferred)."""
    if not SPACY_AVAILABLE or _nlp is None:
        return []

    doc = _nlp(text[:100_000])   # spaCy has token limits; cap at 100k chars
    hits = []

    for ent in doc.ents:
        if len(ent.text.strip()) < 3:
            continue
            
        term_clean = ent.text.lower().strip()
        category = ent.label_

        # If using generic web model, it will extract non-medical things like GPE, ORG, DATE
        if _NLP_MODEL == "en_core_web_sm":
            # If it's not in our dictionary, discard it.
            if term_clean not in CLINICAL_KEYWORDS:
                continue
            # Override category with our known medical category
            category = CLINICAL_KEYWORDS[term_clean]
        else:
            # For scispacy (en_core_sci_sm), it labels everything as ENTITY.
            # Try to upgrade the label if we know it in our dictionary.
            if term_clean in CLINICAL_KEYWORDS:
                category = CLINICAL_KEYWORDS[term_clean]

        hits.append({
            "term": term_clean,
            "category": category,
            "section": section_name,
            "source": f"nlp:{_NLP_MODEL}",
        })

    return hits


def _extract_temporal_context(text: str) -> list[str]:
    """Find temporal expressions in text for timeline anchoring."""
    return [m.group(0) for m in _TEMPORAL_RE.finditer(text)]


def _parse_date_from_context(temporal_hints: list[str]) -> Optional[str]:
    """Try to resolve a calendar date from temporal hints."""
    if not temporal_hints:
        return None

    if DATEPARSER_AVAILABLE:
        for hint in temporal_hints:
            parsed = dateparser.parse(hint, settings={"RETURN_AS_TIMEZONE_AWARE": False})
            if parsed:
                return parsed.strftime("%Y-%m-%d")

    return None


def _deduplicate_terms(terms: list[dict]) -> list[dict]:
    """Remove duplicate (term, category, section) triples, keeping first occurrence."""
    seen: set[tuple] = set()
    deduped = []
    for t in terms:
        key = (t["term"], t["section"])
        if key not in seen:
            seen.add(key)
            deduped.append(t)
    return deduped


# ─────────────────────────────────────────────────────────────────────────────
# Main Worker 3 entry point
# ─────────────────────────────────────────────────────────────────────────────

def extract_and_update(
    scan_result: ScanResult,
    patient_id: str,
    actor: str = "system",
) -> dict:
    """
    Run key-term extraction on all sections and update the patient timeline.

    Returns:
        {
          "document_id": str,
          "terms_found": int,
          "timeline_entry": dict,
          "term_frequency_delta": dict[str, int]
        }
    """
    all_terms: list[dict] = []
    section_counts: dict[str, int] = defaultdict(int)

    for section in scan_result.sections:
        text = section.raw_text
        if not text.strip():
            continue

        # Tier 1 — keyword scan
        kw_hits = _keyword_scan(text, section.section_name)

        # Tier 2 — NLP NER (adds entities not in the keyword dict)
        nlp_hits = _nlp_scan(text, section.section_name)

        section_hits = _deduplicate_terms(kw_hits + nlp_hits)
        all_terms.extend(section_hits)
        section_counts[section.section_name] += len(section_hits)

    all_terms = _deduplicate_terms(all_terms)

    # ── Temporal anchoring ────────────────────────────────────────────────
    full_text = scan_result.full_text
    temporal_hints = _extract_temporal_context(full_text)
    inferred_date = _parse_date_from_context(temporal_hints)
    event_date = inferred_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # ── Build timeline entry ──────────────────────────────────────────────
    timeline_entry = {
        "document_id": scan_result.document_id,
        "date": event_date,
        "temporal_hints": temporal_hints[:5],   # first 5 raw hints for display
        "terms": all_terms,
        "section_counts": dict(section_counts),
        "nlp_model": _NLP_MODEL,
    }

    # ── Term frequency delta ──────────────────────────────────────────────
    term_freq_delta = Counter(t["term"] for t in all_terms)

    # ── Persist to FHIR store ─────────────────────────────────────────────
    fhir_store.update_timeline(
        patient_id=patient_id,
        timeline_entry=timeline_entry,
        term_freq_delta=dict(term_freq_delta),
        actor=actor,
    )

    log_event(
        "UPDATE",
        patient_id=patient_id,
        actor=actor,
        document_id=scan_result.document_id,
        details={
            "action": "keyterm_extraction",
            "terms_found": len(all_terms),
            "nlp_model": _NLP_MODEL,
        },
    )

    print(f"[Worker 3] 🔍 {len(all_terms)} clinical terms extracted from "
          f"{len(scan_result.sections)} sections. "
          f"Event date inferred: {event_date}")

    return {
        "document_id": scan_result.document_id,
        "terms_found": len(all_terms),
        "timeline_entry": timeline_entry,
        "term_frequency_delta": dict(term_freq_delta),
    }


def get_patient_term_history(patient_id: str) -> dict[str, int]:
    """Return the full term frequency history for a patient."""
    bundle = fhir_store.get_profile(patient_id)
    if not bundle:
        return {}
    return bundle.get("_term_frequency", {})


def get_patient_timeline(patient_id: str) -> list[dict]:
    """Return the chronological event timeline for a patient."""
    bundle = fhir_store.get_profile(patient_id)
    if not bundle:
        return []
    timeline = bundle.get("_timeline", [])
    return sorted(timeline, key=lambda e: e.get("date", ""))
