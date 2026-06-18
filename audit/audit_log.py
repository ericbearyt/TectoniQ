"""
audit/audit_log.py
──────────────────
Append-only, structured audit logger.
Every read or write to a patient record is captured here.
HIPAA Security Rule §164.312(b) — Audit Controls.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


AUDIT_LOG_PATH = Path(os.getenv("AUDIT_LOG_PATH", "audit/audit.jsonl"))


def _ensure_log_dir() -> None:
    AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)


def log_event(
    action: str,
    patient_id: Optional[str],
    actor: str = "system",
    document_id: Optional[str] = None,
    details: Optional[dict] = None,
) -> None:
    """
    Append a structured audit event to the JSONL log file.

    Args:
        action:      One of READ, CREATE, UPDATE, DELETE, INGEST, EXPORT, DEIDENTIFY.
        patient_id:  FHIR Patient UUID (or None for system-level events).
        actor:       User/system ID performing the action.
        document_id: Source document UUID if applicable.
        details:     Any extra key-value context (NO raw PHI).
    """
    _ensure_log_dir()

    # ── PHI scrubber: never write raw PHI into the audit log ──────────────
    safe_details = {k: v for k, v in (details or {}).items()
                    if k not in {"name", "dob", "ssn", "address", "phone"}}

    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "patient_id": patient_id,
        "document_id": document_id,
        "actor": actor,
        "details": safe_details,
    }

    with open(AUDIT_LOG_PATH, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def tail_log(n: int = 20) -> list[dict]:
    """Return the last *n* audit events."""
    if not AUDIT_LOG_PATH.exists():
        return []
    lines = AUDIT_LOG_PATH.read_text(encoding="utf-8").strip().splitlines()
    return [json.loads(line) for line in lines[-n:]]
