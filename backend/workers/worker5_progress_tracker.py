"""
Worker 5 — Chunk Progress Tracker
===================================
Orchestrates per-chunk processing by iterating over Worker 4's chunks,
running Worker 1 on each chunk's PDF bytes, and emitting progress events
after each chunk completes.

Merges all chunk results into a single unified Worker 1 output with
globally unique section IDs.

Progress callback signature
----------------------------
callback({
    "event":          "chunk_progress",
    "chunk":          2,         # 1-indexed current chunk
    "total":          6,
    "header":         "PAST MEDICAL HISTORY",
    "status":         "done",
    "sections_found": 4,
    "pages":          [4, 5, 6],
})
"""

from collections import Counter
from typing import Callable, Optional

from workers import worker1_frequency


def run(
    worker4_output: dict,
    progress_callback: Optional[Callable[[dict], None]] = None,
) -> dict:
    """
    Main entry point for Worker 5.

    Parameters
    ----------
    worker4_output : dict
        Output from worker4_chunk_splitter.run()
        Must contain: chunks[], total_chunks, total_pages
    progress_callback : callable, optional
        Function called after each chunk is processed, receiving a
        progress dict.  Used by the SSE streaming endpoint.

    Returns
    -------
    dict
        Merged Worker 1 output: { sections, term_frequency, page_count }
    """
    chunks = worker4_output["chunks"]
    total_chunks = worker4_output["total_chunks"]
    total_pages = worker4_output["total_pages"]

    if total_chunks == 0:
        return {
            "sections": [],
            "term_frequency": {},
            "page_count": 0,
        }

    all_sections = []
    merged_frequency = Counter()
    global_section_idx = 0

    for i, chunk in enumerate(chunks):
        chunk_id = chunk["chunk_id"]
        chunk_header = chunk["header"]
        chunk_pages = chunk["pages"]
        chunk_pdf = chunk["pdf_bytes"]

        # Emit "processing" event before starting
        if progress_callback:
            progress_callback({
                "event": "chunk_progress",
                "chunk": i + 1,
                "total": total_chunks,
                "header": chunk_header,
                "status": "processing",
                "sections_found": 0,
                "pages": chunk_pages,
            })

        # Run Worker 1 on this chunk's PDF bytes
        w1_result = worker1_frequency.run(chunk_pdf)

        # Re-index section IDs to be globally unique
        chunk_sections = w1_result["sections"]
        for section in chunk_sections:
            section["id"] = f"s{global_section_idx}"
            # Adjust page numbers to reflect position in original document
            # Worker 1 reports pages relative to the chunk (1-indexed),
            # so we offset by the chunk's starting page
            chunk_start_page = chunk_pages[0] if chunk_pages else 1
            relative_page = section["page"]
            section["page"] = chunk_start_page + relative_page - 1
            global_section_idx += 1

        all_sections.extend(chunk_sections)

        # Merge term frequencies
        merged_frequency.update(w1_result["term_frequency"])

        # Emit "done" event after chunk completes
        if progress_callback:
            progress_callback({
                "event": "chunk_progress",
                "chunk": i + 1,
                "total": total_chunks,
                "header": chunk_header,
                "status": "done",
                "sections_found": len(chunk_sections),
                "pages": chunk_pages,
            })

    return {
        "sections": all_sections,
        "term_frequency": dict(merged_frequency),
        "page_count": total_pages,
    }
