"""
fhir/models.py
──────────────
FHIR R4 resource builders.
Provides factory functions that return validated fhir.resources objects,
ready to serialize to JSON for storage or transmission.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Optional


# ── fhir.resources (FHIR R4 Python SDK) ──────────────────────────────────────
try:
    from fhir.resources.patient import Patient
    from fhir.resources.observation import Observation
    from fhir.resources.condition import Condition
    from fhir.resources.medicationstatement import MedicationStatement
    from fhir.resources.encounter import Encounter
    from fhir.resources.documentreference import DocumentReference
    from fhir.resources.bundle import Bundle, BundleEntry
    from fhir.resources.humanname import HumanName
    from fhir.resources.identifier import Identifier
    from fhir.resources.codeableconcept import CodeableConcept
    from fhir.resources.coding import Coding
    from fhir.resources.reference import Reference
    from fhir.resources.period import Period
    FHIR_AVAILABLE = True
except ImportError:  # pragma: no cover
    FHIR_AVAILABLE = False


def _require_fhir() -> None:
    if not FHIR_AVAILABLE:
        raise RuntimeError("fhir.resources not installed. Run: pip install fhir.resources")


def new_patient_id() -> str:
    return str(uuid.uuid4())


# ─────────────────────────────────────────────────────────────────────────────
# Patient
# ─────────────────────────────────────────────────────────────────────────────

def build_patient(
    patient_id: str,
    mrn: str,
    family_name: str,
    given_names: list[str],
    birth_date: Optional[str] = None,   # "YYYY-MM-DD"
    gender: Optional[str] = None,       # "male" | "female" | "other" | "unknown"
) -> dict:
    """
    Build a FHIR R4 Patient resource dict.
    Stored as JSON; the patient_id is the FHIR logical ID.
    """
    _require_fhir()

    resource = {
        "resourceType": "Patient",
        "id": patient_id,
        "identifier": [
            {
                "use": "usual",
                "type": {
                    "coding": [
                        {
                            "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
                            "code": "MR",
                            "display": "Medical Record Number",
                        }
                    ]
                },
                "value": mrn,
            }
        ],
        "name": [
            {
                "use": "official",
                "family": family_name,
                "given": given_names,
            }
        ],
        "meta": {
            "lastUpdated": datetime.now(timezone.utc).isoformat(),
            "profile": ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"],
        },
    }

    if birth_date:
        resource["birthDate"] = birth_date
    if gender:
        resource["gender"] = gender.lower()

    return resource


# ─────────────────────────────────────────────────────────────────────────────
# Encounter  (one per ingested document)
# ─────────────────────────────────────────────────────────────────────────────

def build_encounter(
    patient_id: str,
    encounter_id: Optional[str] = None,
    document_id: Optional[str] = None,
    status: str = "finished",
    encounter_class: str = "AMB",    # ambulatory
) -> dict:
    encounter_id = encounter_id or str(uuid.uuid4())
    return {
        "resourceType": "Encounter",
        "id": encounter_id,
        "status": status,
        "class": {
            "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
            "code": encounter_class,
        },
        "subject": {"reference": f"Patient/{patient_id}"},
        "period": {"start": datetime.now(timezone.utc).isoformat()},
        "meta": {"source": document_id or "unknown"},
    }


# ─────────────────────────────────────────────────────────────────────────────
# Observation  (vitals, labs, clinical findings)
# ─────────────────────────────────────────────────────────────────────────────

def build_observation(
    patient_id: str,
    code: str,
    display: str,
    value_string: Optional[str] = None,
    value_quantity: Optional[dict] = None,   # {"value": 120, "unit": "mmHg"}
    encounter_id: Optional[str] = None,
    observation_id: Optional[str] = None,
    status: str = "final",
    effective_date: Optional[str] = None,
    system: str = "http://loinc.org",
) -> dict:
    obs = {
        "resourceType": "Observation",
        "id": observation_id or str(uuid.uuid4()),
        "status": status,
        "code": {
            "coding": [{"system": system, "code": code, "display": display}],
            "text": display,
        },
        "subject": {"reference": f"Patient/{patient_id}"},
        "effectiveDateTime": effective_date or datetime.now(timezone.utc).isoformat(),
    }

    if encounter_id:
        obs["encounter"] = {"reference": f"Encounter/{encounter_id}"}
    if value_string:
        obs["valueString"] = value_string
    if value_quantity:
        obs["valueQuantity"] = value_quantity

    return obs


# ─────────────────────────────────────────────────────────────────────────────
# Condition  (diagnoses, problems)
# ─────────────────────────────────────────────────────────────────────────────

def build_condition(
    patient_id: str,
    display: str,
    icd10_code: Optional[str] = None,
    snomed_code: Optional[str] = None,
    clinical_status: str = "active",   # active | resolved | inactive
    condition_id: Optional[str] = None,
    encounter_id: Optional[str] = None,
    onset_date: Optional[str] = None,
) -> dict:
    codings = []
    if icd10_code:
        codings.append({
            "system": "http://hl7.org/fhir/sid/icd-10-cm",
            "code": icd10_code,
            "display": display,
        })
    if snomed_code:
        codings.append({
            "system": "http://snomed.info/sct",
            "code": snomed_code,
            "display": display,
        })
    if not codings:
        codings.append({"display": display})

    cond = {
        "resourceType": "Condition",
        "id": condition_id or str(uuid.uuid4()),
        "clinicalStatus": {
            "coding": [{
                "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
                "code": clinical_status,
            }]
        },
        "code": {"coding": codings, "text": display},
        "subject": {"reference": f"Patient/{patient_id}"},
        "recordedDate": datetime.now(timezone.utc).isoformat(),
    }

    if encounter_id:
        cond["encounter"] = {"reference": f"Encounter/{encounter_id}"}
    if onset_date:
        cond["onsetDateTime"] = onset_date

    return cond


# ─────────────────────────────────────────────────────────────────────────────
# MedicationStatement
# ─────────────────────────────────────────────────────────────────────────────

def build_medication_statement(
    patient_id: str,
    medication_display: str,
    rxnorm_code: Optional[str] = None,
    status: str = "active",
    med_id: Optional[str] = None,
) -> dict:
    coding = [{"display": medication_display}]
    if rxnorm_code:
        coding.insert(0, {
            "system": "http://www.nlm.nih.gov/research/umls/rxnorm",
            "code": rxnorm_code,
            "display": medication_display,
        })

    return {
        "resourceType": "MedicationStatement",
        "id": med_id or str(uuid.uuid4()),
        "status": status,
        "medicationCodeableConcept": {"coding": coding, "text": medication_display},
        "subject": {"reference": f"Patient/{patient_id}"},
        "dateAsserted": datetime.now(timezone.utc).isoformat(),
    }


# ─────────────────────────────────────────────────────────────────────────────
# DocumentReference  (link back to source file)
# ─────────────────────────────────────────────────────────────────────────────

def build_document_reference(
    patient_id: str,
    document_id: str,
    source_path: str,
    doc_title: str = "Clinical Document",
) -> dict:
    return {
        "resourceType": "DocumentReference",
        "id": document_id,
        "status": "current",
        "type": {
            "coding": [{
                "system": "http://loinc.org",
                "code": "34109-9",
                "display": "Note",
            }]
        },
        "subject": {"reference": f"Patient/{patient_id}"},
        "date": datetime.now(timezone.utc).isoformat(),
        "description": doc_title,
        "content": [
            {
                "attachment": {
                    "url": f"file://{source_path}",
                    "title": doc_title,
                }
            }
        ],
    }
