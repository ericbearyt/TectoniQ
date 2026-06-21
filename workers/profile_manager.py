"""
workers/profile_manager.py  —  Worker 2
────────────────────────────────────────
Takes the structured output from Worker 1 (DocumentSection list)
and upserts it into a FHIR R4 patient profile via fhir/store.py.

Logic:
  1. Identify the patient from the PREAMBLE / HPI section (MRN, name, DOB).
  2. Lookup the patient in the profile store.
  3. If found  → update the existing bundle with new Encounter + resources.
  4. If not found → create a new Patient resource + full bundle.
  5. Parse clinical sections into structured FHIR resources.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from workers.document_scanner import DocumentSection, ScanResult
from fhir.models import (
    build_patient,
    build_encounter,
    build_observation,
    build_condition,
    build_medication_statement,
    build_document_reference,
    new_patient_id,
)
from fhir import store as fhir_store
from audit.audit_log import log_event


# ── Regex helpers for extracting demographics ─────────────────────────────────

_MRN_RE = re.compile(r"\bMRN[:\s#]*([A-Z0-9\-]+)", re.IGNORECASE)
_DOB_RE = re.compile(
    r"\b(?:DOB|Date\s+of\s+Birth|Birth(?:date)?)[:\s]*"
    r"(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}|\d{4}-\d{2}-\d{2})",
    re.IGNORECASE,
)
_NAME_RE = re.compile(
    r"\b(?:Patient(?:\s+Name)?|Name)[:\s]+([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+){1,3})",
    re.IGNORECASE,
)
_GENDER_RE = re.compile(
    r"\b(?:Sex|Gender)[:\s]+(Male|Female|Other|Unknown|M|F)\b",
    re.IGNORECASE,
)


def _extract_demographics(sections: list[DocumentSection]) -> dict:
    """
    Scan the PREAMBLE and HPI sections for patient demographics.
    Returns a dict with keys: mrn, family, given, dob, gender.
    """
    target_sections = {s.section_name for s in sections
                       if s.section_name in ("PREAMBLE", "HPI",
                                             "HISTORY OF PRESENT ILLNESS",
                                             "DOCUMENT")}
    combined = " ".join(
        s.raw_text for s in sections
        if s.section_name in target_sections or s.section_name == "PREAMBLE"
    ) or " ".join(s.raw_text for s in sections[:3])

    mrn_match = _MRN_RE.search(combined)
    dob_match = _DOB_RE.search(combined)
    name_match = _NAME_RE.search(combined)
    gender_match = _GENDER_RE.search(combined)

    # Parse DOB → ISO 8601
    dob_iso: Optional[str] = None
    if dob_match:
        raw_dob = dob_match.group(1)
        try:
            for fmt in ("%m/%d/%Y", "%m-%d-%Y", "%Y-%m-%d", "%m/%d/%y"):
                try:
                    dob_iso = datetime.strptime(raw_dob, fmt).strftime("%Y-%m-%d")
                    break
                except ValueError:
                    continue
        except Exception:
            dob_iso = raw_dob

    # Parse name → family / given
    family_name = "Unknown"
    given_names = ["Unknown"]
    if name_match:
        parts = name_match.group(1).strip().split()
        if len(parts) >= 2:
            family_name = parts[-1]
            given_names = parts[:-1]
        elif parts:
            family_name = parts[0]

    gender_map = {"m": "male", "f": "female"}
    gender: Optional[str] = None
    if gender_match:
        raw_g = gender_match.group(1).lower()
        gender = gender_map.get(raw_g, raw_g)

    return {
        "mrn": mrn_match.group(1) if mrn_match else f"UNKNOWN-{uuid.uuid4().hex[:6].upper()}",
        "family": family_name,
        "given": given_names,
        "dob": dob_iso,
        "gender": gender,
    }


# ── Section → FHIR resource parsers ──────────────────────────────────────────

def _parse_vitals(section: DocumentSection, patient_id: str, encounter_id: str) -> list[dict]:
    """Extract simple vital sign observations from a VITALS section."""
    observations = []
    text = section.raw_text

    vital_patterns = [
        (r"BP[:\s]+(\d+/\d+)\s*(?:mmHg)?",  "55284-4", "Blood Pressure", "mmHg"),
        (r"HR[:\s]+(\d+)\s*(?:bpm|/min)?",   "8867-4",  "Heart Rate",     "bpm"),
        (r"RR[:\s]+(\d+)\s*(?:breaths)?",    "9279-1",  "Respiratory Rate","breaths/min"),
        (r"Temp[:\s]+(\d+\.?\d*)\s*[°F]?",   "8310-5",  "Body Temperature","°F"),
        (r"O2\s*Sat[:\s]+(\d+)\s*%?",        "2708-6",  "Oxygen Saturation","%"),
        (r"Wt[:\s]+(\d+\.?\d*)\s*(?:kg|lbs)?", "29463-7","Body Weight",   "kg"),
        (r"Ht[:\s]+(\d+\.?\d*)\s*(?:cm|in)?",  "8302-2", "Body Height",   "cm"),
    ]

    for pattern, loinc_code, display, unit in vital_patterns:
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            value = m.group(1)
            observations.append(build_observation(
                patient_id=patient_id,
                code=loinc_code,
                display=display,
                value_string=f"{value} {unit}",
                encounter_id=encounter_id,
            ))

    return observations


def _parse_medications(section: DocumentSection, patient_id: str) -> list[dict]:
    """Extract medication names from a MEDICATIONS section."""
    meds = []
    lines = section.raw_text.splitlines()
    for line in lines:
        line = line.strip()
        if len(line) < 3:
            continue
        # Each non-blank line is treated as a medication entry
        meds.append(build_medication_statement(
            patient_id=patient_id,
            medication_display=line,
        ))
    return meds


def _parse_diagnoses(section: DocumentSection, patient_id: str, encounter_id: str) -> list[dict]:
    """Extract conditions/diagnoses from ASSESSMENT or DIAGNOSIS sections."""
    conditions = []
    text = section.raw_text

    # Look for ICD-10 codes (format: X99.99)
    icd_pattern = re.compile(r"([A-Z]\d{2}(?:\.\d+)?)\s+([^\n\r]+)")
    for m in icd_pattern.finditer(text):
        icd_code = m.group(1)
        display = m.group(2).strip()[:120]
        conditions.append(build_condition(
            patient_id=patient_id,
            display=display,
            icd10_code=icd_code,
            encounter_id=encounter_id,
        ))

    # If no ICD codes found, treat numbered/bulleted list items as diagnoses
    if not conditions:
        lines = re.split(r"[\n\r]+", text)
        for line in lines:
            line = re.sub(r"^[\d\.\-\*\•]\s*", "", line).strip()
            if len(line) > 5:
                conditions.append(build_condition(
                    patient_id=patient_id,
                    display=line[:120],
                    encounter_id=encounter_id,
                ))

    return conditions


# ── Main Worker 2 entry point ─────────────────────────────────────────────────

def process_document(
    scan_result: ScanResult,
    actor: str = "system",
) -> str:
    """
    Upsert a patient profile based on a scanned document.

    Returns:
        patient_id (UUID string)
    """
    sections = scan_result.sections
    document_id = scan_result.document_id

    # 1. Extract demographics
    demo = _extract_demographics(sections)
    mrn = demo["mrn"]

    # 2. Lookup patient
    patient_id = fhir_store.find_patient_by_mrn(mrn)
    is_new = patient_id is None

    if is_new:
        # 3a. Create new patient
        patient_id = new_patient_id()
        patient_res = build_patient(
            patient_id=patient_id,
            mrn=mrn,
            family_name=demo["family"],
            given_names=demo["given"],
            birth_date=demo["dob"],
            gender=demo["gender"],
        )
        fhir_store.create_profile(
            patient_resource=patient_res,
            mrn=mrn,
            actor=actor,
            document_id=document_id,
        )
        print(f"[Worker 2] ✨ Created NEW patient profile — ID: {patient_id}")
    else:
        print(f"[Worker 2] 🔄 Found EXISTING patient — ID: {patient_id}")

    # 4. Create Encounter for this document ingestion
    encounter = build_encounter(
        patient_id=patient_id,
        document_id=document_id,
    )
    encounter_id = encounter["id"]
    fhir_store.upsert_resource(patient_id, encounter, actor=actor, document_id=document_id)

    # 5. Create DocumentReference
    doc_ref = build_document_reference(
        patient_id=patient_id,
        document_id=document_id,
        source_path=scan_result.source_path,
    )
    fhir_store.upsert_resource(patient_id, doc_ref, actor=actor, document_id=document_id)

    # 6. Parse sections into FHIR resources
    for section in sections:
        name = section.section_name

        if "VITAL" in name:
            for obs in _parse_vitals(section, patient_id, encounter_id):
                fhir_store.upsert_resource(patient_id, obs, actor=actor, document_id=document_id)

        elif "MEDICATION" in name:
            for med in _parse_medications(section, patient_id):
                fhir_store.upsert_resource(patient_id, med, actor=actor, document_id=document_id)

        elif any(kw in name for kw in ("ASSESSMENT", "DIAGNOSIS", "DIAGNOSES", "IMPRESSION")):
            for cond in _parse_diagnoses(section, patient_id, encounter_id):
                fhir_store.upsert_resource(patient_id, cond, actor=actor, document_id=document_id)

    log_event(
        "INGEST",
        patient_id=patient_id,
        actor=actor,
        document_id=document_id,
        details={
            "is_new_patient": is_new,
            "sections_processed": len(sections),
            "ocr_pages": scan_result.ocr_pages,
        },
    )

    print(f"[Worker 2] ✅ Profile updated — {len(sections)} sections processed.")
    return patient_id
