"""
analytics/pandas_pipeline.py
─────────────────────────────
Converts FHIR R4 patient bundles stored on disk into structured Pandas
DataFrames for analytics, trend analysis, and export.

DataFrames produced:
  patients_df   — one row per patient (demographics)
  timeline_df   — one row per (patient, date, term) — longitudinal events
  documents_df  — one row per ingested document (metadata)
  terms_freq_df — aggregated term frequency per patient (sorted desc)

All DataFrames carry a `source_version` column so you can track which
pipeline run produced the data.

De-identification:
  Call deidentify(df) on any DataFrame to strip PHI columns before export.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import pandas as pd
import numpy as np

PROFILES_DIR = Path(os.getenv("PROFILES_DIR", "profiles"))
EXPORT_DIR = Path(os.getenv("EXPORT_DIR", "exports"))

_PIPELINE_VERSION = "1.0.0"

# Columns considered PHI — stripped by deidentify()
PHI_COLUMNS = {"family_name", "given_names", "birth_date", "mrn"}


# ─────────────────────────────────────────────────────────────────────────────
# Bundle loader
# ─────────────────────────────────────────────────────────────────────────────

def _load_all_bundles() -> list[dict]:
    """Load every patient bundle.json from the profiles directory."""
    bundles = []
    if not PROFILES_DIR.exists():
        return bundles
    for bundle_path in PROFILES_DIR.glob("*/bundle.json"):
        try:
            bundles.append(json.loads(bundle_path.read_text(encoding="utf-8")))
        except Exception as e:
            print(f"[Analytics] ⚠️  Could not load {bundle_path}: {e}")
    return bundles


def _extract_patient_resource(bundle: dict) -> Optional[dict]:
    """Pull the Patient resource from a bundle's entry list."""
    for entry in bundle.get("entry", []):
        res = entry.get("resource", {})
        if res.get("resourceType") == "Patient":
            return res
    return None


def _get_mrn(patient_res: dict) -> str:
    for ident in patient_res.get("identifier", []):
        codings = ident.get("type", {}).get("coding", [])
        for c in codings:
            if c.get("code") == "MR":
                return ident.get("value", "")
    return ""


# ─────────────────────────────────────────────────────────────────────────────
# DataFrame builders
# ─────────────────────────────────────────────────────────────────────────────

def build_patients_df(bundles: Optional[list[dict]] = None) -> pd.DataFrame:
    """
    Build a flat DataFrame of patient demographics.

    Columns:
        patient_id, mrn, family_name, given_names, birth_date, gender,
        profile_created, last_updated, document_count, source_version
    """
    if bundles is None:
        bundles = _load_all_bundles()

    rows = []
    for bundle in bundles:
        patient_res = _extract_patient_resource(bundle)
        if not patient_res:
            continue

        patient_id = patient_res.get("id", "")
        mrn = _get_mrn(patient_res)
        names = patient_res.get("name", [{}])[0]
        family = names.get("family", "")
        given = " ".join(names.get("given", []))
        birth_date = patient_res.get("birthDate", "")
        gender = patient_res.get("gender", "")
        last_updated = bundle.get("timestamp", "")

        # Count documents
        doc_count = sum(
            1 for e in bundle.get("entry", [])
            if e.get("resource", {}).get("resourceType") == "DocumentReference"
        )

        rows.append({
            "patient_id": patient_id,
            "mrn": mrn,
            "family_name": family,
            "given_names": given,
            "birth_date": birth_date,
            "gender": gender,
            "last_updated": last_updated,
            "document_count": doc_count,
            "source_version": _PIPELINE_VERSION,
        })

    df = pd.DataFrame(rows)
    if not df.empty:
        df["last_updated"] = pd.to_datetime(df["last_updated"], errors="coerce", utc=True)
    return df


def build_timeline_df(bundles: Optional[list[dict]] = None) -> pd.DataFrame:
    """
    Build a long-format DataFrame of clinical events across all patients.

    Columns:
        patient_id, date, term, category, section, document_id,
        source, source_version
    """
    if bundles is None:
        bundles = _load_all_bundles()

    rows = []
    for bundle in bundles:
        patient_id = bundle.get("id", "")
        for entry in bundle.get("_timeline", []):
            doc_id = entry.get("document_id", "")
            date_str = entry.get("date", "")
            for term_hit in entry.get("terms", []):
                rows.append({
                    "patient_id": patient_id,
                    "date": date_str,
                    "term": term_hit.get("term", ""),
                    "category": term_hit.get("category", ""),
                    "section": term_hit.get("section", ""),
                    "document_id": doc_id,
                    "source": term_hit.get("source", ""),
                    "source_version": _PIPELINE_VERSION,
                })

    df = pd.DataFrame(rows)
    if not df.empty:
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df.sort_values(["patient_id", "date"], inplace=True)
        df.reset_index(drop=True, inplace=True)
    return df


def build_documents_df(bundles: Optional[list[dict]] = None) -> pd.DataFrame:
    """
    Build a DataFrame of all ingested documents (DocumentReference resources).

    Columns:
        patient_id, document_id, date, title, source_path, source_version
    """
    if bundles is None:
        bundles = _load_all_bundles()

    rows = []
    for bundle in bundles:
        patient_id = bundle.get("id", "")
        for entry in bundle.get("entry", []):
            res = entry.get("resource", {})
            if res.get("resourceType") != "DocumentReference":
                continue
            content = res.get("content", [{}])[0]
            attachment = content.get("attachment", {})
            rows.append({
                "patient_id": patient_id,
                "document_id": res.get("id", ""),
                "date": res.get("date", ""),
                "title": res.get("description", ""),
                "source_path": attachment.get("url", "").replace("file://", ""),
                "source_version": _PIPELINE_VERSION,
            })

    df = pd.DataFrame(rows)
    if not df.empty:
        df["date"] = pd.to_datetime(df["date"], errors="coerce", utc=True)
    return df


def build_terms_freq_df(bundles: Optional[list[dict]] = None) -> pd.DataFrame:
    """
    Build a per-patient term frequency DataFrame.

    Columns:
        patient_id, term, frequency, source_version
    Sorted by (patient_id, frequency DESC).
    """
    if bundles is None:
        bundles = _load_all_bundles()

    rows = []
    for bundle in bundles:
        patient_id = bundle.get("id", "")
        for term, freq in bundle.get("_term_frequency", {}).items():
            rows.append({
                "patient_id": patient_id,
                "term": term,
                "frequency": freq,
                "source_version": _PIPELINE_VERSION,
            })

    df = pd.DataFrame(rows)
    if not df.empty:
        df.sort_values(["patient_id", "frequency"], ascending=[True, False], inplace=True)
        df.reset_index(drop=True, inplace=True)
    return df


# ─────────────────────────────────────────────────────────────────────────────
# Analytics helpers
# ─────────────────────────────────────────────────────────────────────────────

def term_trend_for_patient(
    timeline_df: pd.DataFrame,
    patient_id: str,
    term: Optional[str] = None,
    top_n: int = 10,
) -> pd.DataFrame:
    """
    Return a time-series of term occurrences for one patient.
    If term is None, return counts for the top_n most frequent terms.

    Columns: date, term, count
    """
    df = timeline_df[timeline_df["patient_id"] == patient_id].copy()
    if df.empty:
        return pd.DataFrame(columns=["date", "term", "count"])

    if term:
        df = df[df["term"].str.lower() == term.lower()]

    trend = (
        df.groupby(["date", "term"])
        .size()
        .reset_index(name="count")
        .sort_values("date")
    )

    if term is None:
        top_terms = df["term"].value_counts().head(top_n).index.tolist()
        trend = trend[trend["term"].isin(top_terms)]

    return trend


def population_term_heatmap_data(
    terms_freq_df: pd.DataFrame,
    top_n: int = 20,
) -> pd.DataFrame:
    """
    Pivot term frequencies across all patients.
    Returns a DataFrame suitable for a heatmap:
        rows = terms, columns = patient_ids, values = frequency.
    """
    if terms_freq_df.empty:
        return pd.DataFrame()

    top_terms = (
        terms_freq_df.groupby("term")["frequency"]
        .sum()
        .sort_values(ascending=False)
        .head(top_n)
        .index.tolist()
    )

    filtered = terms_freq_df[terms_freq_df["term"].isin(top_terms)]
    pivot = filtered.pivot_table(
        index="term",
        columns="patient_id",
        values="frequency",
        aggfunc="sum",
        fill_value=0,
    )
    return pivot


# ─────────────────────────────────────────────────────────────────────────────
# De-identification  (HIPAA Safe Harbor)
# ─────────────────────────────────────────────────────────────────────────────

def deidentify(df: pd.DataFrame) -> pd.DataFrame:
    """
    Remove PHI columns from a DataFrame.
    Returns a copy — never modifies in-place.
    Also generalizes dates to year-only (HIPAA Safe Harbor §164.514(b)).
    """
    df = df.copy()
    for col in PHI_COLUMNS:
        if col in df.columns:
            df.drop(columns=[col], inplace=True)

    # Generalize date columns to year only
    for col in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            df[col] = df[col].dt.year

    return df


# ─────────────────────────────────────────────────────────────────────────────
# Export helpers
# ─────────────────────────────────────────────────────────────────────────────

def export_to_csv(df: pd.DataFrame, filename: str) -> Path:
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    out = EXPORT_DIR / filename
    df.to_csv(out, index=False)
    print(f"[Analytics] 📤 Exported {len(df)} rows → {out}")
    return out


def export_to_excel(dfs: dict[str, pd.DataFrame], filename: str) -> Path:
    """Export multiple DataFrames as sheets in one Excel file."""
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    out = EXPORT_DIR / filename
    with pd.ExcelWriter(out, engine="openpyxl") as writer:
        for sheet_name, df in dfs.items():
            df.to_excel(writer, sheet_name=sheet_name[:31], index=False)
    print(f"[Analytics] 📤 Exported {len(dfs)} sheets → {out}")
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Convenience: load everything at once
# ─────────────────────────────────────────────────────────────────────────────

def load_all_dataframes() -> dict[str, pd.DataFrame]:
    """
    Load all patient bundles and return all four DataFrames.
    Use this as the single entry point for the dashboard data layer.
    """
    bundles = _load_all_bundles()
    print(f"[Analytics] 📊 Loading {len(bundles)} patient bundle(s)...")

    return {
        "patients": build_patients_df(bundles),
        "timeline": build_timeline_df(bundles),
        "documents": build_documents_df(bundles),
        "terms_freq": build_terms_freq_df(bundles),
    }
