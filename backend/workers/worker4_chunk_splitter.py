"""
Worker 4 — PDF Chunk Splitter
===============================
Does a lightweight first-pass text extraction to locate major section
header boundaries, then splits the original PDF into per-header chunks
so downstream workers can process them independently with progress
tracking.

The chunking is **header-driven** — each chunk starts at a detected
header boundary and extends to the next one.  The number of chunks
equals the number of major headers found (minimum 1).

Output contract
---------------
{
    "chunks": [
        {
            "chunk_id":  "c0",
            "header":    "CHIEF COMPLAINT",
            "pages":     [1, 2, 3],
            "pdf_bytes": b"..."
        }
    ],
    "total_chunks": 4,
    "total_pages":  12
}
"""

import io
import re
from typing import Callable, Optional

from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextContainer

# ---------------------------------------------------------------------------
# PyPDF2 for splitting the PDF into sub-documents
# ---------------------------------------------------------------------------
try:
    from PyPDF2 import PdfReader, PdfWriter
    _PYPDF2_AVAILABLE = True
except ImportError:
    _PYPDF2_AVAILABLE = False

# ---------------------------------------------------------------------------
# Header detection patterns — mirrors Worker 1's logic for consistency
# ---------------------------------------------------------------------------
HEADER_PATTERNS = [
    re.compile(r"^[A-Z][A-Z\s\-/&]{3,}$"),          # ALL CAPS
    re.compile(r"^\d+[\.\\)]\s+[A-Z]"),               # 1. or 1) Heading
    re.compile(r"^[A-Z][\.\\)]\s+[A-Z]"),             # A. or A) Heading
    re.compile(r"^#{1,3}\s+"),                         # Markdown ## headings
    re.compile(r"^(ASSESSMENT|PLAN|HPI|ROS|PMH|MEDICATIONS|ALLERGIES|"
               r"SOCIAL HISTORY|FAMILY HISTORY|PHYSICAL EXAM|VITALS|"
               r"LABS|IMAGING|PROCEDURES|DIAGNOSIS|IMPRESSION|"
               r"CHIEF COMPLAINT|HISTORY OF PRESENT ILLNESS|"
               r"REVIEW OF SYSTEMS|PAST MEDICAL HISTORY|"
               r"SURGICAL HISTORY|PROBLEM LIST|DISCHARGE SUMMARY)"),
]


def _is_header(line: str) -> bool:
    """Return True if the line looks like a section header."""
    stripped = line.strip()
    if not stripped or len(stripped) > 120:
        return False
    return any(p.match(stripped) for p in HEADER_PATTERNS)


def _scan_header_boundaries(pdf_bytes: bytes) -> list[dict]:
    """
    Lightweight first-pass: extract text page-by-page and find which
    pages contain major section headers.

    Returns a list of { page: int, header: str } for each header found,
    sorted by page number.
    """
    boundaries = []
    pdf_file = io.BytesIO(pdf_bytes)

    for page_num, page_layout in enumerate(extract_pages(pdf_file), start=1):
        page_text_parts = []
        for element in page_layout:
            if isinstance(element, LTTextContainer):
                page_text_parts.append(element.get_text())
        page_text = "\n".join(page_text_parts)

        for line in page_text.splitlines():
            if _is_header(line):
                boundaries.append({
                    "page": page_num,
                    "header": line.strip(),
                })
                break  # Only record the first header per page

    return boundaries


def _split_pdf_bytes(pdf_bytes: bytes, page_ranges: list[list[int]]) -> list[bytes]:
    """
    Split the original PDF into sub-PDFs for the given page ranges.
    Each page_range is a list of 1-indexed page numbers.
    Returns a list of PDF bytes, one per range.
    """
    if not _PYPDF2_AVAILABLE:
        raise ImportError(
            "PyPDF2 is required for PDF chunk splitting. "
            "Install it with: pip install PyPDF2"
        )

    reader = PdfReader(io.BytesIO(pdf_bytes))
    results = []

    for page_range in page_ranges:
        writer = PdfWriter()
        for page_num in page_range:
            # PyPDF2 uses 0-indexed pages
            idx = page_num - 1
            if 0 <= idx < len(reader.pages):
                writer.add_page(reader.pages[idx])
        buf = io.BytesIO()
        writer.write(buf)
        results.append(buf.getvalue())

    return results


def run(pdf_bytes: bytes) -> dict:
    """
    Main entry point for Worker 4.

    Parameters
    ----------
    pdf_bytes : bytes
        Raw PDF file content.

    Returns
    -------
    dict
        { chunks, total_chunks, total_pages }
    """
    # Count total pages
    reader_for_count = io.BytesIO(pdf_bytes)
    total_pages = 0
    for _ in extract_pages(reader_for_count):
        total_pages += 1

    if total_pages == 0:
        return {"chunks": [], "total_chunks": 0, "total_pages": 0}

    # Scan for header boundaries
    boundaries = _scan_header_boundaries(pdf_bytes)

    # Build page ranges from boundaries
    # Each chunk spans from one header's page to the next header's page - 1
    if not boundaries:
        # No headers found — treat entire document as one chunk
        page_ranges = [list(range(1, total_pages + 1))]
        chunk_headers = ["DOCUMENT"]
    else:
        page_ranges = []
        chunk_headers = []

        for i, boundary in enumerate(boundaries):
            start_page = boundary["page"]
            if i + 1 < len(boundaries):
                end_page = boundaries[i + 1]["page"] - 1
            else:
                end_page = total_pages

            # Handle case where headers are on the same page
            if end_page < start_page:
                end_page = start_page

            page_ranges.append(list(range(start_page, end_page + 1)))
            chunk_headers.append(boundary["header"])

        # If the first header isn't on page 1, prepend a chunk for pages before it
        if boundaries[0]["page"] > 1:
            pre_pages = list(range(1, boundaries[0]["page"]))
            page_ranges.insert(0, pre_pages)
            chunk_headers.insert(0, "DOCUMENT START")

    # Split PDF into sub-documents
    chunk_pdfs = _split_pdf_bytes(pdf_bytes, page_ranges)

    # Build output
    chunks = []
    for i, (pages, header, pdf_chunk) in enumerate(
        zip(page_ranges, chunk_headers, chunk_pdfs)
    ):
        chunks.append({
            "chunk_id": f"c{i}",
            "header": header,
            "pages": pages,
            "pdf_bytes": pdf_chunk,
        })

    return {
        "chunks": chunks,
        "total_chunks": len(chunks),
        "total_pages": total_pages,
    }
