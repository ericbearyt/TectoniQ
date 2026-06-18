"""
Worker 6 — Section Heading Labeler
=====================================
Takes the merged Worker 1 output (sections list) and assigns semantic
labels to each section, grouping them under recognisable clinical
categories.

Each section receives:
  - section_label:  Human-readable label, e.g. "Progress 1: Social History"
  - section_group:  Category key, e.g. "history", "examination", "results"

Output contract
---------------
Returns the Worker 1 output with enriched sections[]:
{
    "sections": [
        {
            "id": "s0",
            "header": "SOCIAL HISTORY",
            "page": 2,
            "content": "...",
            "section_label": "Progress 1: Social History",
            "section_group": "history"
        }
    ],
    "term_frequency": { ... },
    "page_count": 10,
    "section_outline": [
        { "index": 1, "label": "Progress 1: Social History", "group": "history", "section_id": "s0", "page": 2 },
        { "index": 2, "label": "Procedure", "group": "procedure", "section_id": "s3", "page": 5 }
    ]
}
"""

import re

# ---------------------------------------------------------------------------
# Clinical category definitions
# Maps category → list of header substrings / patterns that belong to it
# ---------------------------------------------------------------------------
CATEGORY_MAP = {
    "history": [
        "SOCIAL HISTORY", "FAMILY HISTORY", "PAST MEDICAL HISTORY",
        "PMH", "HISTORY OF PRESENT ILLNESS", "HPI",
        "SURGICAL HISTORY", "MEDICAL HISTORY",
        "REVIEW OF SYSTEMS", "ROS",
    ],
    "examination": [
        "PHYSICAL EXAM", "VITALS", "VITAL SIGNS",
        "EXAMINATION", "PHYSICAL EXAMINATION",
        "GENERAL EXAM", "NEUROLOGICAL EXAM",
    ],
    "results": [
        "LABS", "LABORATORY", "LAB RESULTS",
        "IMAGING", "RADIOLOGY", "PATHOLOGY",
        "RESULTS", "FINDINGS", "STUDIES",
    ],
    "assessment": [
        "ASSESSMENT", "IMPRESSION", "DIAGNOSIS",
        "DIAGNOSES", "PROBLEM LIST", "CLINICAL IMPRESSION",
    ],
    "plan": [
        "PLAN", "MEDICATIONS", "ALLERGIES",
        "DISCHARGE SUMMARY", "DISCHARGE INSTRUCTIONS",
        "DISPOSITION", "FOLLOW UP", "FOLLOW-UP",
        "RECOMMENDATIONS",
    ],
    "procedure": [
        "PROCEDURES", "PROCEDURE", "OPERATION",
        "OPERATIVE NOTE", "SURGICAL NOTE", "SURGERY",
    ],
    "complaint": [
        "CHIEF COMPLAINT", "PRESENTING COMPLAINT",
        "REASON FOR VISIT", "REASON FOR CONSULTATION",
    ],
}

# Build a fast lookup: normalised substring → (category, display_name)
_HEADER_LOOKUP: list[tuple[str, str, str]] = []
for category, patterns in CATEGORY_MAP.items():
    for pattern in patterns:
        _HEADER_LOOKUP.append((pattern.upper(), category, pattern.title()))


def _classify_header(header: str) -> tuple[str, str]:
    """
    Match a section header against known clinical categories.

    Returns
    -------
    (category, display_name) — e.g. ("history", "Social History")
    Falls back to ("other", header.title()) if no match.
    """
    normalised = header.strip().upper()

    # Try exact and substring matches, longest match first
    best_match = None
    best_len = 0
    for pattern, category, display in _HEADER_LOOKUP:
        if pattern in normalised and len(pattern) > best_len:
            best_match = (category, display)
            best_len = len(pattern)

    if best_match:
        return best_match

    return ("other", header.strip().title())


def run(worker1_output: dict) -> dict:
    """
    Main entry point for Worker 6.

    Parameters
    ----------
    worker1_output : dict
        Output from Worker 5 (merged Worker 1 output).
        Must contain: sections[], term_frequency{}, page_count

    Returns
    -------
    dict
        Enriched Worker 1 output with section_label, section_group,
        and a section_outline table of contents.
    """
    sections = worker1_output["sections"]

    # Track progress counters per category for labelling
    category_counters: dict[str, int] = {}
    section_outline = []

    for section in sections:
        header = section.get("header", "")
        category, display_name = _classify_header(header)

        # Increment counter for this category
        category_counters[category] = category_counters.get(category, 0) + 1
        count = category_counters[category]

        # Build the label: "Progress N: Display Name"
        # Only add "Progress N:" if there are likely multiple sections in this category
        if category != "other":
            label = f"Progress {count}: {display_name}"
        else:
            label = display_name

        section["section_label"] = label
        section["section_group"] = category

        outline_idx = len(section_outline) + 1
        section_outline.append({
            "index": outline_idx,
            "label": label,
            "group": category,
            "section_id": section["id"],
            "page": section.get("page", 0),
            "header": header,
        })

    return {
        "sections": sections,
        "term_frequency": worker1_output["term_frequency"],
        "page_count": worker1_output["page_count"],
        "section_outline": section_outline,
    }
