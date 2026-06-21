"""
TUI → Category Mapping  (Worker 7 support module)
=================================================
Maps UMLS Semantic Type identifiers (TUIs) onto TectoniQ's five clinical
buckets, implementing the *hybrid* strategy agreed in design:

  - medication / diagnosis / procedure  →  curated TUI allowlists (high confidence)
  - biomarker                           →  small TUI set, disambiguated by the
                                            section the concept appears in
                                            (`section_group == "results"`)
  - demographic                         →  NOT produced here. Demographics are
                                            structured data pulled from the FHIR
                                            layer, not surfaced by entity linking.
  - other                               →  linked but unmapped → routed to Gemini
                                            adjudication (needs_adjudication=True)

⚠ VERIFY THE LITERAL TUI CODES against current UMLS Semantic Network docs
  (SRDEF / Semantic Types & Groups). These are the standard, widely-used codes,
  but they are encoded here from knowledge, not pulled from a licensed UMLS
  install — confirm before relying on them in production.
"""

from __future__ import annotations

# ── Curated TUI allowlists ────────────────────────────────────────────────
MEDICATION_TUIS = {
    "T121",  # Pharmacologic Substance
    "T200",  # Clinical Drug
    "T195",  # Antibiotic
    "T125",  # Hormone
    "T129",  # Immunologic Factor
}

DIAGNOSIS_TUIS = {
    "T047",  # Disease or Syndrome
    "T191",  # Neoplastic Process
    "T046",  # Pathologic Function
    "T048",  # Mental or Behavioral Dysfunction
    "T019",  # Congenital Abnormality
    "T020",  # Acquired Abnormality
    "T184",  # Sign or Symptom
}

PROCEDURE_TUIS = {
    "T060",  # Diagnostic Procedure
    "T061",  # Therapeutic or Preventive Procedure
    "T058",  # Health Care Activity
}

# Biomarker is the fuzziest bucket — these need the section signal to firm up.
BIOMARKER_TUIS = {
    "T034",  # Laboratory or Test Result
    "T201",  # Clinical Attribute
}

# Analytes/measurable substances. On their own these are too broad to call a
# biomarker (e.g. T123 sweeps many chemicals), but *inside a results/labs
# section* a span linking to one of these reads as a reported lab value
# (troponin, HbA1c, creatinine). Used only as a section-gated promotion.
ANALYTE_TUIS = {
    "T116",  # Amino Acid, Peptide, or Protein
    "T123",  # Biologically Active Substance
    "T126",  # Enzyme
    "T196",  # Element, Ion, or Isotope
    "T059",  # Laboratory Procedure
}

# T059 (Laboratory Procedure) straddles procedure vs biomarker. The note section
# breaks the tie: under a results/labs section it reads as a biomarker readout,
# otherwise as a procedure performed.
LAB_PROCEDURE_TUI = "T059"

# NOTE: T033 "Finding" was intentionally REMOVED from diagnosis mapping. On
# real records it sweeps in meta-qualifiers ("Negative", "Positive", "Abnormal",
# "Normal") that are frequent and pollute the timeline. Finding now falls through
# to "other" (dropped). Re-add here only with a paired denylist if you need it.
SOFT_DIAGNOSIS_TUIS: set[str] = set()


def classify(tuis, section_group: str | None = None) -> tuple[str, bool]:
    """
    Map a concept's semantic types to a TectoniQ category.

    Parameters
    ----------
    tuis : iterable[str]
        UMLS semantic type ids attached to the linked concept.
    section_group : str | None
        Worker 6 section group the concept appeared in ("results", "plan", ...).
        Used to disambiguate the biomarker/procedure boundary.

    Returns
    -------
    (category, confident)
        category : one of medication | diagnosis | procedure | biomarker | other
        confident : True when a curated TUI matched cleanly; False when the
                    mapping is a soft guess that should be sent to Gemini
                    adjudication (needs_adjudication).
    """
    tui_set = {t for t in (tuis or [])}
    in_results = (section_group == "results")

    # High-confidence buckets first.
    if tui_set & MEDICATION_TUIS:
        return ("medication", True)
    if tui_set & DIAGNOSIS_TUIS:
        return ("diagnosis", True)

    # Lab-procedure tie-break via section.
    if LAB_PROCEDURE_TUI in tui_set:
        return ("biomarker", True) if in_results else ("procedure", True)

    if tui_set & PROCEDURE_TUIS:
        return ("procedure", True)

    if tui_set & BIOMARKER_TUIS:
        # Clinical Attribute outside a results section is shakier — let the
        # section vouch for it; otherwise adjudicate.
        return ("biomarker", in_results or bool(tui_set & {"T034"}))

    # Section-gated promotion: an analyte mentioned under labs/results reads as
    # a reported biomarker value. Confident because the section vouches for it.
    if in_results and (tui_set & ANALYTE_TUIS):
        return ("biomarker", True)

    # Soft / vague semantic types → guess but flag.
    if tui_set & SOFT_DIAGNOSIS_TUIS:
        return ("diagnosis", False)

    # Linked, but no mapped type → other, adjudicate.
    return ("other", False)
