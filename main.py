"""
main.py
───────
Pipeline orchestrator — ties all three workers together.

Usage:
    python main.py --document path/to/document.pdf
    python main.py --document path/to/scan.png --actor dr_smith
    python main.py --report      # show analytics summary for all patients

Flow:
    1. Worker 1: Scan & split the document
    2. Worker 2: Upsert patient profile (create or update FHIR bundle)
    3. Worker 3: Extract key terms & update patient timeline
    4. Analytics: Refresh Pandas DataFrames & show summary
"""

from __future__ import annotations

import argparse
import uuid
from datetime import datetime, timezone
from pathlib import Path

from workers.document_scanner import scan_document
from workers.profile_manager import process_document
from workers.keyterm_extractor import extract_and_update, get_patient_timeline, get_patient_term_history
from analytics.pandas_pipeline import load_all_dataframes, term_trend_for_patient, export_to_excel
from audit.audit_log import tail_log


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline runner
# ─────────────────────────────────────────────────────────────────────────────

def run_pipeline(document_path: str, actor: str = "system") -> dict:
    """
    Execute the full 3-worker pipeline on a single document.

    Returns a summary dict with patient_id, terms_found, and document_id.
    """
    document_id = str(uuid.uuid4())
    print(f"\n{'='*60}")
    print(f"  TectoniQ Medical Pipeline  —  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"  Document  : {document_path}")
    print(f"  Doc ID    : {document_id}")
    print(f"  Actor     : {actor}")
    print(f"{'='*60}\n")

    # ── Worker 1: Scan ────────────────────────────────────────────────────
    print("▶ Worker 1 — Scanning document...")
    scan_result = scan_document(document_path, document_id=document_id)
    print(f"  Pages: {scan_result.page_count} | "
          f"Sections found: {len(scan_result.sections)} | "
          f"OCR pages: {scan_result.ocr_pages or 'none'}")
    for s in scan_result.sections:
        preview = s.raw_text[:60].replace("\n", " ")
        print(f"    [{s.section_name}] {preview}...")

    # ── Worker 2: Profile upsert ──────────────────────────────────────────
    print("\n▶ Worker 2 — Updating patient profile...")
    patient_id = process_document(scan_result, actor=actor)

    # ── Worker 3: Key-term extraction ─────────────────────────────────────
    print("\n▶ Worker 3 — Extracting clinical terms...")
    extraction = extract_and_update(scan_result, patient_id=patient_id, actor=actor)

    # ── Summary ───────────────────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print(f"  ✅ Pipeline complete.")
    print(f"  Patient ID    : {patient_id}")
    print(f"  Document ID   : {document_id}")
    print(f"  Terms found   : {extraction['terms_found']}")

    top_terms = sorted(
        extraction["term_frequency_delta"].items(),
        key=lambda x: x[1],
        reverse=True,
    )[:5]
    if top_terms:
        print(f"  Top terms     : {', '.join(f'{t}({c})' for t, c in top_terms)}")
    print(f"{'─'*60}\n")

    return {
        "patient_id": patient_id,
        "document_id": document_id,
        "terms_found": extraction["terms_found"],
        "sections": len(scan_result.sections),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Analytics report
# ─────────────────────────────────────────────────────────────────────────────

def run_report() -> None:
    """Print an analytics summary and export an Excel workbook."""
    print("\n📊 Loading analytics...\n")
    dfs = load_all_dataframes()

    patients_df = dfs["patients"]
    timeline_df = dfs["timeline"]
    terms_freq_df = dfs["terms_freq"]
    documents_df = dfs["documents"]

    print(f"Patients       : {len(patients_df)}")
    print(f"Documents      : {len(documents_df)}")
    print(f"Timeline events: {len(timeline_df)}")
    print(f"Term-freq rows : {len(terms_freq_df)}")

    if not patients_df.empty:
        print("\n── Patient Summary ──────────────────────────────────────")
        print(patients_df[["patient_id", "gender", "document_count", "last_updated"]]
              .to_string(index=False))

    if not terms_freq_df.empty:
        print("\n── Top 10 Clinical Terms Across All Patients ────────────")
        top = (
            terms_freq_df.groupby("term")["frequency"]
            .sum()
            .sort_values(ascending=False)
            .head(10)
            .reset_index()
        )
        print(top.to_string(index=False))

    # Export Excel workbook
    export_to_excel(
        {
            "Patients": patients_df,
            "Timeline": timeline_df,
            "Documents": documents_df,
            "TermFrequency": terms_freq_df,
        },
        filename=f"tectoniQ_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx",
    )

    # Show last 5 audit events
    print("\n── Last 5 Audit Events ──────────────────────────────────")
    for event in tail_log(5):
        print(f"  {event['timestamp'][:19]}  {event['action']:10s}  "
              f"patient={event['patient_id'] or 'n/a':36s}  actor={event['actor']}")


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="TectoniQ — Medical Document Processing Pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py --document records/note.pdf
  python main.py --document records/scan.png --actor dr_nguyen
  python main.py --report
        """,
    )
    parser.add_argument("--document", metavar="PATH",
                        help="Path to a PDF or image file to process.")
    parser.add_argument("--actor", default="system",
                        help="User/system ID performing the action (for audit log).")
    parser.add_argument("--report", action="store_true",
                        help="Print analytics summary for all patients and export Excel.")

    args = parser.parse_args()

    if args.report:
        run_report()
    elif args.document:
        if not Path(args.document).exists():
            print(f"❌ File not found: {args.document}")
            raise SystemExit(1)
        run_pipeline(args.document, actor=args.actor)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
