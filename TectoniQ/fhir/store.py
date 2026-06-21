"""
fhir/store.py
─────────────
Profile read / write / upsert logic.
Stores FHIR R4 patient bundles as JSON files on disk under:
    profiles/{patient_uuid}/bundle.json

Lookup index stored at:
    profiles/_index.json   →   { "mrn::<MRN>": "<patient_uuid>", ... }

For production, swap _read/_write calls for HAPI FHIR REST API calls.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from audit.audit_log import log_event

PROFILES_DIR = Path(os.getenv("PROFILES_DIR", "profiles"))
INDEX_FILE = PROFILES_DIR / "_index.json"

_lock = threading.Lock()   # guard concurrent writes in multi-threaded use


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _ensure_dirs(patient_id: str) -> Path:
    patient_dir = PROFILES_DIR / patient_id
    patient_dir.mkdir(parents=True, exist_ok=True)
    return patient_dir


def _load_index() -> dict[str, str]:
    if INDEX_FILE.exists():
        return json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    return {}


def _save_index(index: dict[str, str]) -> None:
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps(index, indent=2), encoding="utf-8")


def _bundle_path(patient_id: str) -> Path:
    return PROFILES_DIR / patient_id / "bundle.json"


def _load_bundle(patient_id: str) -> Optional[dict]:
    bp = _bundle_path(patient_id)
    if bp.exists():
        return json.loads(bp.read_text(encoding="utf-8"))
    return None


def _save_bundle(patient_id: str, bundle: dict) -> None:
    patient_dir = _ensure_dirs(patient_id)
    bp = patient_dir / "bundle.json"
    # Keep a simple version history (last 10 snapshots)
    history_dir = patient_dir / "history"
    history_dir.mkdir(exist_ok=True)
    if bp.exists():
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        import shutil
        shutil.copy2(bp, history_dir / f"bundle_{ts}.json")
    bp.write_text(json.dumps(bundle, indent=2, ensure_ascii=False), encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# Lookup
# ─────────────────────────────────────────────────────────────────────────────

def find_patient_by_mrn(mrn: str) -> Optional[str]:
    """Return patient UUID if MRN is known, else None."""
    index = _load_index()
    return index.get(f"mrn::{mrn}")


def find_patient_by_name_dob(family: str, dob: str) -> Optional[str]:
    """Return patient UUID matching family name + DOB, else None."""
    index = _load_index()
    key = f"namedob::{family.upper()}::{dob}"
    return index.get(key)


def get_profile(patient_id: str, actor: str = "system") -> Optional[dict]:
    """Read and return the full FHIR bundle for a patient."""
    bundle = _load_bundle(patient_id)
    log_event("READ", patient_id=patient_id, actor=actor)
    return bundle


# ─────────────────────────────────────────────────────────────────────────────
# Create
# ─────────────────────────────────────────────────────────────────────────────

def create_profile(
    patient_resource: dict,
    mrn: str,
    actor: str = "system",
    document_id: Optional[str] = None,
) -> str:
    """
    Persist a brand-new FHIR Patient bundle.
    Returns the patient UUID.
    """
    patient_id = patient_resource["id"]
    dob = patient_resource.get("birthDate", "")
    family = ""
    if patient_resource.get("name"):
        family = patient_resource["name"][0].get("family", "")

    bundle = {
        "resourceType": "Bundle",
        "id": patient_id,
        "type": "collection",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "entry": [
            {"resource": patient_resource, "fullUrl": f"Patient/{patient_id}"}
        ],
        "_timeline": [],            # populated by Worker 3
        "_term_frequency": {},      # populated by Worker 3
    }

    with _lock:
        _save_bundle(patient_id, bundle)

        index = _load_index()
        index[f"mrn::{mrn}"] = patient_id
        if family and dob:
            index[f"namedob::{family.upper()}::{dob}"] = patient_id
        _save_index(index)

    log_event(
        "CREATE",
        patient_id=patient_id,
        actor=actor,
        document_id=document_id,
        details={"mrn": mrn},
    )
    return patient_id


# ─────────────────────────────────────────────────────────────────────────────
# Update / Upsert resources into an existing bundle
# ─────────────────────────────────────────────────────────────────────────────

def upsert_resource(
    patient_id: str,
    resource: dict,
    actor: str = "system",
    document_id: Optional[str] = None,
) -> None:
    """
    Add or replace a FHIR resource inside the patient's bundle.
    Matching is done by resourceType + id.
    """
    with _lock:
        bundle = _load_bundle(patient_id)
        if bundle is None:
            raise ValueError(f"No profile found for patient {patient_id}")

        resource_type = resource.get("resourceType", "")
        resource_id = resource.get("id", "")
        full_url = f"{resource_type}/{resource_id}"

        # Find existing entry with same fullUrl
        entries: list[dict] = bundle.get("entry", [])
        replaced = False
        for i, entry in enumerate(entries):
            if entry.get("fullUrl") == full_url:
                entries[i] = {"resource": resource, "fullUrl": full_url}
                replaced = True
                break

        if not replaced:
            entries.append({"resource": resource, "fullUrl": full_url})

        bundle["entry"] = entries
        bundle["timestamp"] = datetime.now(timezone.utc).isoformat()
        _save_bundle(patient_id, bundle)

    log_event(
        "UPDATE",
        patient_id=patient_id,
        actor=actor,
        document_id=document_id,
        details={"resource_type": resource_type, "resource_id": resource_id},
    )


def update_timeline(
    patient_id: str,
    timeline_entry: dict,
    term_freq_delta: dict[str, int],
    actor: str = "system",
) -> None:
    """
    Append a timeline entry and merge term-frequency counts.
    Called by Worker 3 after key-term extraction.
    """
    with _lock:
        bundle = _load_bundle(patient_id)
        if bundle is None:
            raise ValueError(f"No profile found for patient {patient_id}")

        bundle.setdefault("_timeline", []).append(timeline_entry)

        freq = bundle.setdefault("_term_frequency", {})
        for term, count in term_freq_delta.items():
            freq[term] = freq.get(term, 0) + count

        bundle["timestamp"] = datetime.now(timezone.utc).isoformat()
        _save_bundle(patient_id, bundle)

    log_event("UPDATE", patient_id=patient_id, actor=actor,
              details={"action": "timeline_append", "terms_added": len(term_freq_delta)})
