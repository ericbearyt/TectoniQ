"""
TectoniQ — Flask Backend
=========================
Exposes the 6-worker clinical document processing pipeline via REST API.

Pipeline: Worker 4 (chunk) → Worker 5 (progress + Worker 1 per chunk) → Worker 6 (labels) → Worker 2 → Worker 3

Endpoints
---------
GET  /api/health              → health check
POST /api/parse               → upload PDF, returns structured JSON
POST /api/parse/stream        → upload PDF, SSE stream of chunk progress + final JSON
GET  /api/history             → list processed patients
GET  /api/history/<id>        → retrieve single patient data
"""

import os
import re
import json
import uuid
import queue
import threading
from datetime import datetime, timezone
from pathlib import Path
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from dotenv import load_dotenv

from workers import worker1_frequency, worker2_timeline, worker3_gemini_ner
from workers import worker4_chunk_splitter, worker5_progress_tracker, worker6_section_labeler, worker7_filter

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
load_dotenv()

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})  # Allow all origins for local dev

MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 50 MB max upload
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

HISTORY_DIR = Path(__file__).parent / "history"
HISTORY_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    """Health check — confirms backend is running and Gemini key status."""
    gemini_key_set = bool(os.getenv("GEMINI_API_KEY", ""))
    return jsonify({
        "status": "ok",
        "gemini_key_configured": gemini_key_set,
        "message": "TectoniQ backend is running.",
    })


def _validate_pdf_upload():
    """Validate file upload and return (pdf_bytes, error_response)."""
    if "file" not in request.files:
        return None, (jsonify({"error": "No file uploaded. Send a PDF as 'file' in multipart form."}), 400)

    uploaded_file = request.files["file"]

    if uploaded_file.filename == "":
        return None, (jsonify({"error": "Empty filename."}), 400)

    if not uploaded_file.filename.lower().endswith(".pdf"):
        return None, (jsonify({"error": "Only PDF files are supported."}), 415)

    pdf_bytes = uploaded_file.read()

    if len(pdf_bytes) == 0:
        return None, (jsonify({"error": "Uploaded file is empty."}), 400)

    return pdf_bytes, None


def _run_pipeline(pdf_bytes: bytes, progress_callback=None) -> dict:
    """
    Run the full 6-worker pipeline on pdf_bytes.
    Returns the final structured output dict.
    """
    # ── Worker 4: Split PDF into header-based chunks ─────────────────────
    print(f"[Worker 4] Splitting PDF ({len(pdf_bytes):,} bytes) into chunks…")
    w4 = worker4_chunk_splitter.run(pdf_bytes)
    print(f"[Worker 4] Done — {w4['total_chunks']} chunks, {w4['total_pages']} pages")

    # ── Worker 5: Process each chunk through Worker 1 with progress ──────
    print("[Worker 5] Processing chunks…")
    w5 = worker5_progress_tracker.run(w4, progress_callback=progress_callback)
    print(f"[Worker 5] Done — {len(w5['sections'])} sections, "
          f"{len(w5['term_frequency'])} unique terms")

    # ── Worker 6: Label sections with semantic categories ────────────────
    print("[Worker 6] Labeling sections…")
    w6 = worker6_section_labeler.run(w5)
    print(f"[Worker 6] Done — {len(w6.get('section_outline', []))} outline entries")

    # ── Worker 7: Filter / vocabulary-link clinical terms ────────────────
    print("[Worker 7] Filtering keywords…")
    w7 = worker7_filter.run(w6)

    if w7.get("linker_used"):
        # Concept-keyed path: Worker 7 already grouped spans by CUI into a
        # timeline, so Worker 2 (string search) is bypassed. Worker 3 only
        # adjudicates the ambiguous, capped subset.
        print(f"[Worker 7] Linker on — {len(w7['timeline'])} concepts")
        print("[Worker 3] Adjudicating ambiguous concepts…")
        w3 = worker3_gemini_ner.run_adjudication(w7)
        print(f"[Worker 3] Done — {w3['ner_summary']['reviewed_terms']} adjudicated")
        output = _build_output(w7, w3)
    else:
        print(f"[Worker 7] Done — {len(w7['term_frequency'])} unique medical terms remaining")
        # ── Worker 2: Map terms onto 1D timeline ─────────────────────────
        print("[Worker 2] Building timeline…")
        w2 = worker2_timeline.run(w7)
        print(f"[Worker 2] Done — {len(w2['timeline'])} timeline entries")

        # ── Worker 3: Gemini semantic NER ────────────────────────────────
        print("[Worker 3] Running Gemini NER…")
        w3 = worker3_gemini_ner.run(w6, w2)
        print(f"[Worker 3] Done — {w3['ner_summary']['reviewed_terms']} terms reviewed by Gemini")

        # ── Build final structured output ────────────────────────────────
        output = _build_output(w6, w3)

    # Extract patient name
    patient_name = "Unknown Patient"
    for s in w6.get("sections", []):
        content = s.get("content", "")
        match = re.search(r"patient(?:\s*name)?[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)", content, re.IGNORECASE)
        if match:
            patient_name = match.group(1).strip()
            break

    patient_id = str(uuid.uuid4())
    output["patient_id"] = patient_id
    output["patient_name"] = patient_name
    output["processed_at"] = datetime.now(timezone.utc).isoformat()

    # Save to history file
    filepath = HISTORY_DIR / f"{patient_id}.json"
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    return output


@app.post("/api/parse")
def parse_document():
    """
    Accept a multipart PDF upload, run it through Workers 4 → 5 → 6 → 2 → 3,
    and return a fully structured JSON payload.
    """
    pdf_bytes, error = _validate_pdf_upload()
    if error:
        return error

    try:
        output = _run_pipeline(pdf_bytes)
        return jsonify(output), 200
    except Exception as e:
        print(f"[Error] Pipeline failed: {e}")
        return jsonify({"error": f"Processing failed: {str(e)}"}), 500


@app.post("/api/parse/stream")
def parse_document_stream():
    """
    SSE streaming endpoint — runs the same pipeline but emits chunk
    progress events via Server-Sent Events so the frontend can show
    real-time per-chunk progress bars.

    Event types:
      chunk_progress  — emitted after each chunk is processed
      pipeline_stage  — emitted when a pipeline stage starts/finishes
      complete        — final event with the full JSON payload
      error           — emitted if the pipeline fails
    """
    pdf_bytes, error = _validate_pdf_upload()
    if error:
        return error

    def generate():
        # The pipeline runs in a worker thread and pushes events onto a queue;
        # this generator drains the queue and yields SSE lines. On a long link
        # (e.g. a 1,600-page record) the queue stays empty for stretches, so we
        # emit heartbeat comments to keep the connection alive past proxy/browser
        # idle timeouts. link_progress events give live movement during linking.
        events: "queue.Queue" = queue.Queue()
        SENTINEL = object()

        def emit(ev):
            events.put(ev)

        def pipeline():
            try:
                emit({"event": "pipeline_stage", "stage": "worker4", "status": "processing"})
                w4 = worker4_chunk_splitter.run(pdf_bytes)
                emit({"event": "pipeline_stage", "stage": "worker4", "status": "done",
                      "total_chunks": w4["total_chunks"], "total_pages": w4["total_pages"]})

                emit({"event": "pipeline_stage", "stage": "worker5", "status": "processing"})
                # Worker 5 chunk progress flows live through the same queue.
                w5 = worker5_progress_tracker.run(w4, progress_callback=emit)
                emit({"event": "pipeline_stage", "stage": "worker5", "status": "done"})

                emit({"event": "pipeline_stage", "stage": "worker6", "status": "processing"})
                w6 = worker6_section_labeler.run(w5)
                emit({"event": "pipeline_stage", "stage": "worker6", "status": "done"})

                emit({"event": "pipeline_stage", "stage": "worker7", "status": "processing"})

                def link_progress(done, total):
                    emit({"event": "link_progress", "done": done, "total": total})

                w7 = worker7_filter.run(w6, progress=link_progress)
                emit({"event": "pipeline_stage", "stage": "worker7", "status": "done"})

                if w7.get("linker_used"):
                    emit({"event": "pipeline_stage", "stage": "worker2", "status": "done", "skipped": True})
                    emit({"event": "pipeline_stage", "stage": "worker3", "status": "processing"})
                    w3 = worker3_gemini_ner.run_adjudication(w7)
                    emit({"event": "pipeline_stage", "stage": "worker3", "status": "done"})
                    output = _build_output(w7, w3)
                else:
                    emit({"event": "pipeline_stage", "stage": "worker2", "status": "processing"})
                    w2 = worker2_timeline.run(w7)
                    emit({"event": "pipeline_stage", "stage": "worker2", "status": "done"})
                    emit({"event": "pipeline_stage", "stage": "worker3", "status": "processing"})
                    w3 = worker3_gemini_ner.run(w6, w2)
                    emit({"event": "pipeline_stage", "stage": "worker3", "status": "done"})
                    output = _build_output(w6, w3)

                patient_name = "Unknown Patient"
                for s in w6.get("sections", []):
                    content = s.get("content", "")
                    match = re.search(r"patient(?:\s*name)?[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)", content, re.IGNORECASE)
                    if match:
                        patient_name = match.group(1).strip()
                        break

                patient_id = str(uuid.uuid4())
                output["patient_id"] = patient_id
                output["patient_name"] = patient_name
                output["processed_at"] = datetime.now(timezone.utc).isoformat()

                with open(HISTORY_DIR / f"{patient_id}.json", "w", encoding="utf-8") as f:
                    json.dump(output, f, indent=2, ensure_ascii=False)

                emit({"event": "complete", "data": output})
            except Exception as e:
                print(f"[Error] Pipeline failed: {e}")
                emit({"event": "error", "message": str(e)})
            finally:
                events.put(SENTINEL)

        threading.Thread(target=pipeline, daemon=True).start()

        while True:
            try:
                ev = events.get(timeout=15)
            except queue.Empty:
                yield ": heartbeat\n\n"   # SSE comment — keeps the connection warm
                continue
            if ev is SENTINEL:
                break
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.get("/api/history")
def get_history():
    """List all previously processed patient histories (metadata only)."""
    history_list = []
    try:
        for p in HISTORY_DIR.glob("*.json"):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    history_list.append({
                        "patient_id": data.get("patient_id"),
                        "patient_name": data.get("patient_name", "Unknown Patient"),
                        "processed_at": data.get("processed_at"),
                        "meta": data.get("meta", {}),
                    })
            except Exception as ex:
                print(f"[Error] Failed to read history file {p.name}: {ex}")
        
        # Sort by processed_at descending
        history_list.sort(key=lambda x: x.get("processed_at") or "", reverse=True)
    except Exception as e:
        return jsonify({"error": f"Failed to retrieve history: {str(e)}"}), 500
        
    return jsonify(history_list), 200


@app.get("/api/history/<patient_id>")
def get_history_detail(patient_id):
    """Retrieve full parsed data for a single patient."""
    # Prevent directory traversal attacks by validating uuid or path
    safe_name = re.sub(r"[^a-zA-Z0-9\-_]", "", patient_id)
    filepath = HISTORY_DIR / f"{safe_name}.json"
    if not filepath.exists():
        return jsonify({"error": f"Patient history with ID {patient_id} not found."}), 404
        
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        return jsonify(data), 200
    except Exception as e:
        return jsonify({"error": f"Failed to read history data: {str(e)}"}), 500


def _build_output(w6: dict, w3: dict) -> dict:
    """
    Combine Worker outputs into the final structured document model.
    Matches the export schema defined in the implementation plan.
    Now includes section_outline from Worker 6.
    """
    sections = w6["sections"]
    timeline_entries = w3["timeline"]

    # Build keyword lookup from timeline
    keywords = {}
    is_gemini_available = w3.get("ner_summary", {}).get("gemini_available", False)
    linker_used = w6.get("linker_used", False)
    filtered_timeline = []
    concepts_total = len(timeline_entries)

    # ── Precision filter + cap (linker mode) ─────────────────────────────────
    # Large records (e.g. a 1,600-page summary) link to thousands of concepts and
    # freeze the D3 keyword tree. Reduce to a precise, bounded set BEFORE shipping
    # to the browser: min link score, frequency floor, and a per-category cap by
    # (count desc, score desc). All env-tunable.
    if linker_used:
        keep_score = float(os.getenv("KEYWORD_MIN_SCORE", "0.85"))
        # Frequency floor is adaptive: singletons are noise on a big record but
        # the whole signal on a short note. Only enforce count>=2 once the doc
        # produced more concepts than this threshold.
        large_doc = concepts_total > int(os.getenv("KEYWORD_LARGE_DOC", "150"))
        min_count = int(os.getenv("KEYWORD_MIN_COUNT", "2")) if large_doc else 1
        cap_default = int(os.getenv("KEYWORD_CAP", "40"))
        caps = {
            "diagnosis": int(os.getenv("KEYWORD_CAP_DIAGNOSIS", "60")),
            "medication": int(os.getenv("KEYWORD_CAP_MEDICATION", str(cap_default))),
            "procedure": int(os.getenv("KEYWORD_CAP_PROCEDURE", str(cap_default))),
            "biomarker": int(os.getenv("KEYWORD_CAP_BIOMARKER", "30")),
        }

        survivors: dict[str, list] = {}
        for e in timeline_entries:
            cat = e.get("category", "other")
            if cat in ("other", "demographic"):
                continue
            if (e.get("link_score") or 0) < keep_score:
                continue
            # Frequency floor on asserted mentions; always keep negated-only
            # (count 0) concepts that survived, since they're clinically notable.
            if e.get("count", 0) < min_count and e.get("negated_count", 0) == 0:
                continue
            survivors.setdefault(cat, []).append(e)

        reduced = []
        for cat, items in survivors.items():
            items.sort(key=lambda x: (x.get("count", 0), x.get("link_score") or 0), reverse=True)
            reduced.extend(items[: caps.get(cat, cap_default)])
        timeline_entries = reduced

    for entry in timeline_entries:
        cat = entry.get("category", "other")

        # Drop non-clinical/meta buckets. In linker mode "other" means the span
        # linked but mapped to no clinical category (and adjudication, if any, has
        # already run) — so it's noise regardless of Gemini. In legacy mode we
        # only trust this filter when Gemini classified the terms.
        if (linker_used or is_gemini_available) and cat in ("other", "demographic"):
            continue

        filtered_timeline.append(entry)

        keywords[entry["term"]] = {
            "category": cat,
            "status": entry.get("status", "unknown"),
            "ner_confidence": entry.get("ner_confidence", "unreviewed"),
            "count": entry["count"],
            "first_seen": entry["first_seen"],
            "last_seen": entry["last_seen"],
            "occurrences": entry["occurrences"],
            "recurrence_gap": entry["recurrence_gap"],
            "sections_present": entry["sections_present"],
            # Concept-keyed extras (present only when the linker ran)
            "cui": entry.get("cui"),
            "aliases": entry.get("aliases", []),
            "semantic_types": entry.get("semantic_types", []),
            "negated_count": entry.get("negated_count", 0),
            "link_score": entry.get("link_score"),
        }

    # Annotate sections with their keyword lists
    for section in sections:
        sid = section["id"]
        section["keywords"] = [
            term for term, data in keywords.items()
            if sid in data.get("sections_present", [])
        ]
        # Simple duplicate detection: flag sections with identical headers
        section["duplicate_of"] = None

    _flag_duplicates(sections)

    return {
        "meta": {
            "page_count": w6["page_count"],
            "section_count": len(sections),
            "unique_terms": len(keywords),
            "concepts_total": concepts_total,
            "concepts_shown": len(keywords),
            "linker_used": linker_used,
            "ner_summary": w3["ner_summary"],
        },
        "sections": sections,
        "keywords": keywords,
        "timeline": filtered_timeline,
        "section_outline": w6.get("section_outline", []),
    }


def _flag_duplicates(sections: list[dict]) -> None:
    """
    Mark sections whose headers appear more than once.
    Sets duplicate_of to the id of the first section with that header.
    Modifies sections in-place.
    """
    seen: dict[str, str] = {}  # header → first section id
    for section in sections:
        header_key = section["header"].strip().upper()
        if header_key in seen:
            section["duplicate_of"] = seen[header_key]
        else:
            seen[header_key] = section["id"]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.getenv("FLASK_PORT", 5000))
    print(f"🧠 TectoniQ backend starting on http://localhost:{port}")
    app.run(debug=True, port=port)
