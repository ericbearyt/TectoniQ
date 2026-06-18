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
TOP_N_TERMS = 60

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
            # Fallback tags
            entry["category"] = "other"
            entry["status"] = "unknown"
            entry["ner_confidence"] = "unreviewed"

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
