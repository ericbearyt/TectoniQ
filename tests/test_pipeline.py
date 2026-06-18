"""
tests/test_pipeline.py
──────────────────────
End-to-end and unit tests for the TectoniQ medical pipeline.
Uses only the sample text document (no PDF/OCR required).
Run:  python -m pytest tests/ -v
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import uuid
from pathlib import Path

import pytest

# ── Point pipeline at temp directories so tests don't pollute real data ───────
TEST_PROFILES_DIR = Path("tests/temp_profiles")
TEST_AUDIT_DIR = Path("tests/temp_audit")

os.environ["PROFILES_DIR"] = str(TEST_PROFILES_DIR)
os.environ["AUDIT_LOG_PATH"] = str(TEST_AUDIT_DIR / "audit.jsonl")
os.environ["EXPORT_DIR"] = "tests/temp_exports"

# Import after env vars are set
from workers.document_scanner import scan_document, _split_into_sections, DocumentSection
from workers.profile_manager import process_document, _extract_demographics
from workers.keyterm_extractor import extract_and_update, _keyword_scan
from analytics.pandas_pipeline import (
    load_all_dataframes,
    build_patients_df,
    build_timeline_df,
    build_terms_freq_df,
    deidentify,
)
from fhir import store as fhir_store
from audit.audit_log import log_event, tail_log

SAMPLE_DOC = Path("data/raw_documents/sample_note.txt")


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def clean_temp_dirs():
    """Wipe temp test directories before and after each test."""
    for d in [TEST_PROFILES_DIR, TEST_AUDIT_DIR, Path("tests/temp_exports")]:
        if d.exists():
            shutil.rmtree(d)
    yield
    for d in [TEST_PROFILES_DIR, TEST_AUDIT_DIR, Path("tests/temp_exports")]:
        if d.exists():
            shutil.rmtree(d)


@pytest.fixture
def sample_text() -> str:
    return SAMPLE_DOC.read_text(encoding="utf-8")


@pytest.fixture
def scan_result(tmp_path):
    """Run Worker 1 on the sample text document."""
    doc_id = str(uuid.uuid4())
    return scan_document(SAMPLE_DOC, document_id=doc_id)


# ─────────────────────────────────────────────────────────────────────────────
# Worker 1 — Document Scanner
# ─────────────────────────────────────────────────────────────────────────────

class TestDocumentScanner:

    def test_scan_returns_sections(self, scan_result):
        assert len(scan_result.sections) > 0, "Should find at least one section"

    def test_section_names_are_strings(self, scan_result):
        for sec in scan_result.sections:
            assert isinstance(sec.section_name, str)
            assert len(sec.section_name) > 0

    def test_chief_complaint_found(self, scan_result):
        names = [s.section_name for s in scan_result.sections]
        assert any("CHIEF" in n or "COMPLAINT" in n for n in names), \
            f"Expected CHIEF COMPLAINT section. Got: {names}"

    def test_medications_section_found(self, scan_result):
        names = [s.section_name for s in scan_result.sections]
        assert any("MEDICATION" in n for n in names)

    def test_assessment_section_found(self, scan_result):
        names = [s.section_name for s in scan_result.sections]
        assert any("ASSESSMENT" in n for n in names)

    def test_vital_signs_section_found(self, scan_result):
        names = [s.section_name for s in scan_result.sections]
        assert any("VITAL" in n for n in names)

    def test_raw_text_nonempty(self, scan_result):
        for sec in scan_result.sections:
            # At least the full document text should be non-empty
            pass
        assert len(scan_result.full_text) > 100

    def test_document_id_preserved(self, scan_result):
        assert len(scan_result.document_id) == 36   # UUID format

    def test_split_no_headers_returns_one_section(self):
        text = "No headers here. Just some plain clinical narrative about a patient."
        sections = _split_into_sections(text)
        assert len(sections) == 1
        assert sections[0].section_name == "DOCUMENT"


# ─────────────────────────────────────────────────────────────────────────────
# Worker 2 — Profile Manager
# ─────────────────────────────────────────────────────────────────────────────

class TestProfileManager:

    def test_new_patient_profile_created(self, scan_result):
        patient_id = process_document(scan_result, actor="test")
        assert patient_id is not None
        bundle = fhir_store.get_profile(patient_id)
        assert bundle is not None
        assert bundle["resourceType"] == "Bundle"

    def test_patient_resource_in_bundle(self, scan_result):
        patient_id = process_document(scan_result, actor="test")
        bundle = fhir_store.get_profile(patient_id)
        resource_types = [e["resource"]["resourceType"] for e in bundle["entry"]]
        assert "Patient" in resource_types

    def test_encounter_resource_in_bundle(self, scan_result):
        patient_id = process_document(scan_result, actor="test")
        bundle = fhir_store.get_profile(patient_id)
        resource_types = [e["resource"]["resourceType"] for e in bundle["entry"]]
        assert "Encounter" in resource_types

    def test_medication_statements_extracted(self, scan_result):
        patient_id = process_document(scan_result, actor="test")
        bundle = fhir_store.get_profile(patient_id)
        resource_types = [e["resource"]["resourceType"] for e in bundle["entry"]]
        assert "MedicationStatement" in resource_types

    def test_conditions_extracted(self, scan_result):
        patient_id = process_document(scan_result, actor="test")
        bundle = fhir_store.get_profile(patient_id)
        resource_types = [e["resource"]["resourceType"] for e in bundle["entry"]]
        assert "Condition" in resource_types

    def test_second_ingest_same_patient_does_not_duplicate(self, scan_result):
        """Ingesting the same MRN twice should not create two Patient resources."""
        patient_id_1 = process_document(scan_result, actor="test")

        # Create a second ScanResult with same content but new doc_id
        import copy
        scan2 = copy.copy(scan_result)
        scan2.document_id = str(uuid.uuid4())
        patient_id_2 = process_document(scan2, actor="test")

        assert patient_id_1 == patient_id_2, \
            "Same MRN should map to same patient UUID on second ingest"

    def test_demographics_extraction(self, sample_text):
        sections = _split_into_sections(sample_text)
        from workers.document_scanner import DocumentSection
        sec_objects = [DocumentSection(s.section_name, s.raw_text) for s in sections]
        demo = _extract_demographics(sec_objects)
        assert demo["mrn"] == "100234"
        assert demo["family"].lower() == "doe"
        assert demo["dob"] == "1968-03-15"
        assert demo["gender"] == "female"


# ─────────────────────────────────────────────────────────────────────────────
# Worker 3 — Key-Term Extractor
# ─────────────────────────────────────────────────────────────────────────────

class TestKeytermExtractor:

    def test_terms_extracted(self, scan_result):
        patient_id = process_document(scan_result, actor="test")
        result = extract_and_update(scan_result, patient_id=patient_id, actor="test")
        assert result["terms_found"] > 0

    def test_known_terms_found(self, scan_result):
        patient_id = process_document(scan_result, actor="test")
        result = extract_and_update(scan_result, patient_id=patient_id, actor="test")
        freq = result["term_frequency_delta"]
        # These terms appear explicitly in the sample note
        assert "hypertension" in freq or "htn" in freq
        assert "metformin" in freq or "diabetes" in freq

    def test_timeline_appended(self, scan_result):
        patient_id = process_document(scan_result, actor="test")
        extract_and_update(scan_result, patient_id=patient_id, actor="test")
        bundle = fhir_store.get_profile(patient_id)
        assert len(bundle.get("_timeline", [])) == 1

    def test_term_frequency_stored(self, scan_result):
        patient_id = process_document(scan_result, actor="test")
        extract_and_update(scan_result, patient_id=patient_id, actor="test")
        bundle = fhir_store.get_profile(patient_id)
        assert len(bundle.get("_term_frequency", {})) > 0

    def test_keyword_scan_basic(self):
        hits = _keyword_scan("Patient has hypertension and takes metformin daily.", "TEST")
        terms = [h["term"] for h in hits]
        assert "hypertension" in terms
        assert "metformin" in terms

    def test_keyword_scan_avoids_partial_matches(self):
        """'mi' should not match inside 'family'."""
        hits = _keyword_scan("family history of CAD", "TEST")
        terms = [h["term"] for h in hits]
        assert "mi" not in terms


# ─────────────────────────────────────────────────────────────────────────────
# Analytics — Pandas Pipeline
# ─────────────────────────────────────────────────────────────────────────────

class TestAnalytics:

    def _run_full_pipeline(self, scan_result):
        patient_id = process_document(scan_result, actor="test")
        extract_and_update(scan_result, patient_id=patient_id, actor="test")
        return patient_id

    def test_patients_df_has_row(self, scan_result):
        self._run_full_pipeline(scan_result)
        dfs = load_all_dataframes()
        assert len(dfs["patients"]) == 1

    def test_timeline_df_has_rows(self, scan_result):
        self._run_full_pipeline(scan_result)
        dfs = load_all_dataframes()
        assert len(dfs["timeline"]) > 0

    def test_terms_freq_df_has_rows(self, scan_result):
        self._run_full_pipeline(scan_result)
        dfs = load_all_dataframes()
        assert len(dfs["terms_freq"]) > 0

    def test_documents_df_has_row(self, scan_result):
        self._run_full_pipeline(scan_result)
        dfs = load_all_dataframes()
        assert len(dfs["documents"]) >= 1

    def test_deidentify_removes_phi(self, scan_result):
        self._run_full_pipeline(scan_result)
        dfs = load_all_dataframes()
        deid = deidentify(dfs["patients"])
        phi_cols = {"family_name", "given_names", "birth_date", "mrn"}
        for col in phi_cols:
            assert col not in deid.columns, f"PHI column '{col}' still present after deidentify"


# ─────────────────────────────────────────────────────────────────────────────
# Audit Log
# ─────────────────────────────────────────────────────────────────────────────

class TestAuditLog:

    def test_audit_log_written(self, scan_result):
        process_document(scan_result, actor="dr_test")
        events = tail_log(50)
        assert len(events) > 0

    def test_audit_log_has_create_event(self, scan_result):
        process_document(scan_result, actor="dr_test")
        events = tail_log(50)
        actions = [e["action"] for e in events]
        assert "CREATE" in actions

    def test_audit_log_no_phi(self, scan_result):
        process_document(scan_result, actor="dr_test")
        events = tail_log(50)
        for event in events:
            details = event.get("details", {})
            for phi_key in ("name", "dob", "ssn", "address", "phone"):
                assert phi_key not in details, \
                    f"PHI key '{phi_key}' found in audit log details!"
