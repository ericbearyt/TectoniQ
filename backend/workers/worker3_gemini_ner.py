"""
Worker 3 — Gemini Semantic NER
================================
Takes the combined Worker 1 + Worker 2 output and pipes the top-N
most frequent terms through the Gemini API for:
  1. Clinical entity classification:
       diagnosis | medication | procedure | biomarker | demographic | other
  2. Status classification:
       active | historical | unknown

Falls back gracefully if GEMINI_API_KEY is not set — terms are tagged
as classification="unreviewed".

Output contract
---------------
Merges NER labels into the timeline entries. Each timeline entry gains:
{
    "category":       "medication",   # from Gemini
    "status":         "active",       # from Gemini
    "ner_confidence": "high"          # high | low | unreviewed
}

Full output:
{
    "timeline": [ ...annotated timeline entries... ],
    "ner_summary": {
        "total_terms":    50,
        "reviewed_terms": 48,
        "categories": {
            "diagnosis":    12,
            "medication":   18,
            ...
        }
    }
}
"""

import json
import os
import textwrap

# ---------------------------------------------------------------------------
# Gemini SDK import — optional; graceful fallback if not installed / no key
# Uses the new google-genai SDK (v2.x), replacing deprecated google.generativeai
# ---------------------------------------------------------------------------
try:
    from google import genai
    _GENAI_AVAILABLE = True
except ImportError:
    _GENAI_AVAILABLE = False

# How many top terms to send to Gemini (cost/latency tradeoff)
TOP_N_TERMS = 200

# Locate the medical terminology database in workspace root
_DB_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "medical_terminology.json")
)

DICT_CATEGORY_MAP = {
    "Medication": "medication",
    "Procedure": "procedure",
    "Condition": "diagnosis",
    "Symptom": "diagnosis",
    "Allergy": "diagnosis",
    "Finding": "diagnosis",
    "MedicalTerm": "other"  # Use heuristic mapping for MedicalTerm
}

def _heuristic_classify(term: str) -> str:
    term_lower = term.lower()
    
    # Medications
    med_suffixes = (
        "olol", "pril", "stat", "cillin", "mycin", "pam", "lam", 
        "mab", "nib", "vir", "oxacin", "artan", "osin", "idine",
        "phine", "setron", "triptan", "afil", "asone", "onide",
        "ine", "one", "ide", "ole", "ate", "fen", "zine", "tine", "cin"
    )
    if term_lower.endswith(med_suffixes) or any(x in term_lower for x in ("sodium", "hydrochloride", "sulfate", "phosphate", "acid")):
        return "medication"
        
    # Procedures
    proc_suffixes = ("tomy", "stomy", "plasty", "ectomy", "scopy", "graphy", "gram", "centesis", "pexy")
    if term_lower.endswith(proc_suffixes) or any(x in term_lower for x in ("biopsy", "resection", "incision", "drainage", "repair", "bypass", "transplant", "ultrasound", "scan", "ekg", "ecg", "mri", "xray", "x-ray")):
        return "procedure"
        
    # Diagnoses
    diag_suffixes = ("itis", "opathy", "osis", "megaly", "penia", "philia", "emia", "uria", "algia", "oma", "syndrome", "spasm")
    if term_lower.endswith(diag_suffixes) or any(x in term_lower for x in ("failure", "disease", "disorder", "infection", "cancer", "tumor", "infarction", "fracture", "pain", "fever", "cough", "dyspnea", "edema", "syncope", "arrhythmia")):
        return "diagnosis"
        
    # Labs (Labs / biomarkers)
    lab_keywords = ("level", "count", "saturation", "percentage", "concentration", "clearance", "fraction", "ratio", "pressure", "rate")
    if any(x in term_lower for x in lab_keywords) or term_lower in ("bnp", "troponin", "creatinine", "hba1c", "ldl", "hdl", "wbc", "rbc", "platelets", "hb", "hct", "bun", "sodium", "potassium", "chloride", "calcium"):
        return "biomarker"
        
    return "other"

_MEDICAL_TERMINOLOGY = {}

def _load_terminology():
    global _MEDICAL_TERMINOLOGY
    try:
        with open(_DB_PATH, "r", encoding="utf-8") as f:
            _MEDICAL_TERMINOLOGY = json.load(f)
    except Exception as e:
        print(f"[Worker 3] Warning: Could not load medical database from {_DB_PATH}: {e}")
        _MEDICAL_TERMINOLOGY = {}

# Load database on import
_load_terminology()

VALID_CATEGORIES = {
    "diagnosis", "medication", "procedure",
    "biomarker", "demographic", "other",
}
VALID_STATUSES = {"active", "historical", "unknown"}

_NER_PROMPT_TEMPLATE = textwrap.dedent("""
You are a clinical NLP assistant. Below is a list of medical terms extracted
from a clinical document. For each term, respond with a JSON array where every
element has exactly these fields:
  - "term":     the original term (string, exact match)
  - "category": one of: diagnosis | medication | procedure | biomarker | demographic | other
  - "status":   one of: active | historical | unknown
  - "confidence": one of: high | low

Return ONLY the JSON array, no markdown fences, no explanation.

Terms:
{terms_json}
""")


def _build_prompt(terms: list[str]) -> str:
    return _NER_PROMPT_TEMPLATE.format(terms_json=json.dumps(terms, indent=2))


def _parse_gemini_response(response_text: str) -> dict:
    """Parse Gemini's JSON array response into a term → annotation dict."""
    try:
        # Strip accidental markdown fences
        cleaned = response_text.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
        data = json.loads(cleaned)
        result = {}
        for item in data:
            term = item.get("term", "").lower()
            category = item.get("category", "other")
            status = item.get("status", "unknown")
            confidence = item.get("confidence", "low")

            if category not in VALID_CATEGORIES:
                category = "other"
            if status not in VALID_STATUSES:
                status = "unknown"

            result[term] = {
                "category": category,
                "status": status,
                "ner_confidence": confidence,
            }
        return result
    except (json.JSONDecodeError, TypeError, KeyError):
        return {}


def _get_annotations_from_gemini(terms: list[str], api_key: str) -> dict:
    """Call Gemini API and return { term_lower: { category, status, ner_confidence } }."""
    if not _GENAI_AVAILABLE:
        return {}

    client = genai.Client(api_key=api_key)
    prompt = _build_prompt(terms)
    try:
        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt,
        )
        return _parse_gemini_response(response.text)
    except Exception as e:
        print(f"[Worker3] Gemini API error: {e}")
        return {}


GEMINI_ADJUDICATION_CAP = int(os.getenv("GEMINI_ADJUDICATION_CAP", "40"))


def run_adjudication(worker7_output: dict) -> dict:
    """
    Concept-keyed adjudication mode (used when Worker 7 ran the vocabulary
    linker). Unlike run(), this does NOT re-categorise everything — confident,
    TUI-mapped concepts keep their category. Gemini only adjudicates the
    *ambiguous* subset (needs_adjudication=True), capped at
    GEMINI_ADJUDICATION_CAP by frequency, in a single batched call (Q7-C:
    tiered + capped + batched). This keeps the allowlist as the primary gate and
    bounds Gemini cost/latency.

    Spans that NER tagged but the KB couldn't link (#4) were already dropped by
    the linker's allowlist. (Upgrade path: swap in a typed NER model such as
    en_ner_bc5cdr_md to let a clinical label vouch for unlinked spans.)
    """
    timeline = worker7_output["timeline"]
    api_key = os.getenv("GEMINI_API_KEY", "")

    # Confident concepts: trust the TUI mapping.
    for entry in timeline:
        if not entry.get("needs_adjudication"):
            entry["ner_confidence"] = "linked"
            if entry.get("status") == "unknown" and entry["category"] != "other":
                entry["status"] = "active"

    # Ambiguous subset, capped by frequency.
    ambiguous = [e for e in timeline if e.get("needs_adjudication")]
    ambiguous.sort(key=lambda e: e.get("count", 0), reverse=True)
    queue = ambiguous[:GEMINI_ADJUDICATION_CAP]

    annotations: dict = {}
    if api_key and _GENAI_AVAILABLE and queue:
        annotations = _get_annotations_from_gemini([e["term"] for e in queue], api_key)

    adjudicated = 0
    for entry in queue:
        ann = annotations.get(entry["term"].lower())
        if ann:
            entry["category"] = ann["category"]
            entry["status"] = ann["status"]
            entry["ner_confidence"] = ann["ner_confidence"]
            adjudicated += 1
        else:
            # No verdict: keep the TUI guess, mark it unreviewed.
            entry["ner_confidence"] = "unreviewed"

    category_counts: dict[str, int] = {}
    for entry in timeline:
        category_counts[entry["category"]] = category_counts.get(entry["category"], 0) + 1

    return {
        "timeline": timeline,
        "ner_summary": {
            "total_terms": len(timeline),
            "reviewed_terms": adjudicated,
            "adjudication_queue": len(queue),
            "ambiguous_total": len(ambiguous),
            "categories": category_counts,
            "gemini_available": bool(api_key and _GENAI_AVAILABLE),
            "mode": "linker_adjudication",
        },
    }


def run(worker1_output: dict, worker2_output: dict) -> dict:
    """
    Main entry point for Worker 3.

    Parameters
    ----------
    worker1_output : dict
        Output from worker1_frequency.run()
    worker2_output : dict
        Output from worker2_timeline.run()

    Returns
    -------
    dict
        { "timeline": [...annotated...], "ner_summary": {...} }
    """
    api_key = os.getenv("GEMINI_API_KEY", "")
    timeline = worker2_output["timeline"]

    # Select top-N terms by frequency for NER review
    sorted_terms = sorted(
        worker1_output["term_frequency"].items(),
        key=lambda x: x[1],
        reverse=True,
    )
    top_terms = [t for t, _ in sorted_terms[:TOP_N_TERMS]]

    # Get Gemini annotations (or empty dict if no key / unavailable)
    annotations: dict = {}
    if api_key and _GENAI_AVAILABLE:
        annotations = _get_annotations_from_gemini(top_terms, api_key)

    # Merge annotations into timeline entries
    category_counts: dict[str, int] = {}
    reviewed = 0

    for entry in timeline:
        term_lower = entry["term"].lower()
        if term_lower in annotations:
            ann = annotations[term_lower]
            entry["category"] = ann["category"]
            entry["status"] = ann["status"]
            entry["ner_confidence"] = ann["ner_confidence"]
            category_counts[ann["category"]] = category_counts.get(ann["category"], 0) + 1
            reviewed += 1
        else:
            # Fallback tags using the local dictionary and suffix heuristics
            dict_cat = _MEDICAL_TERMINOLOGY.get(term_lower, "other")
            if dict_cat == "MedicalTerm":
                mapped_cat = _heuristic_classify(term_lower)
            else:
                mapped_cat = DICT_CATEGORY_MAP.get(dict_cat, "other")
            
            entry["category"] = mapped_cat
            entry["status"] = "unknown"
            entry["ner_confidence"] = "unreviewed"
            category_counts[mapped_cat] = category_counts.get(mapped_cat, 0) + 1

    ner_summary = {
        "total_terms": len(timeline),
        "reviewed_terms": reviewed,
        "categories": category_counts,
        "gemini_available": bool(api_key and _GENAI_AVAILABLE),
    }

    return {
        "timeline": timeline,
        "ner_summary": ner_summary,
    }
