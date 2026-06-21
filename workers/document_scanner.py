"""
workers/document_scanner.py  —  Worker 1
─────────────────────────────────────────
Ingests a raw document (PDF or image scan) with NO page numbers,
splits it into logical clinical sections using header heuristics,
and returns structured section dicts for downstream workers.

Strategy
────────
1. PDF text layer first (pdfplumber) — fast, no OCR overhead.
2. If a page yields < MIN_CHARS characters, fall back to OCR (pytesseract).
3. Concatenate all page text into one linear stream.
4. Detect section boundaries via a curated regex of common clinical headers.
5. Yield {"section_name", "raw_text", "page_hints", "char_offset"} per section.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Generator, Optional

# ── PDF & image libs (graceful import so tests can mock them) ─────────────────
try:
    import pdfplumber
except ImportError:  # pragma: no cover
    pdfplumber = None  # type: ignore

try:
    import fitz  # PyMuPDF — used for image extraction from PDFs
except ImportError:  # pragma: no cover
    fitz = None  # type: ignore

try:
    from PIL import Image
    import pytesseract
    OCR_AVAILABLE = True
except ImportError:  # pragma: no cover
    OCR_AVAILABLE = False

# ── Constants ─────────────────────────────────────────────────────────────────
MIN_CHARS_BEFORE_OCR = 50   # if a page has fewer chars, attempt OCR

# Clinical section header patterns (case-insensitive).
# Order matters — more specific patterns first.
SECTION_PATTERNS: list[str] = [
    r"CHIEF\s+COMPLAINT",
    r"HISTORY\s+OF\s+PRESENT\s+ILLNESS|HPI",
    r"PAST\s+(MEDICAL\s+)?HISTORY|PMH",
    r"PAST\s+SURGICAL\s+HISTORY|PSH",
    r"FAMILY\s+HISTORY|FH",
    r"SOCIAL\s+HISTORY|SH",
    r"REVIEW\s+OF\s+SYSTEMS|ROS",
    r"ALLERGIES",
    r"MEDICATIONS?",
    r"PHYSICAL\s+EXAM(?:INATION)?",
    r"VITAL\s+SIGNS?|VITALS?",
    r"LABORATORY(?:\s+(?:RESULTS?|DATA))?|LABS?",
    r"IMAGING|RADIOLOGY",
    r"ASSESSMENT(?:\s+AND\s+PLAN)?",
    r"PLAN",
    r"DIAGNOSIS|DIAGNOSES|IMPRESSION",
    r"PROCEDURES?",
    r"DISCHARGE\s+SUMMARY",
    r"FOLLOW[\s\-]?UP",
    r"NOTES?",
]

# Build a single compiled regex that captures the header text
_HEADER_RE = re.compile(
    r"^[ \t]*("
    + "|".join(SECTION_PATTERNS)
    + r")[:\s]*$",
    re.IGNORECASE | re.MULTILINE,
)


@dataclass
class DocumentSection:
    """One logical section extracted from a clinical document."""
    section_name: str
    raw_text: str
    page_hints: list[int] = field(default_factory=list)   # approximate page(s) the section fell on
    char_offset: int = 0                                    # character offset in the full doc stream


@dataclass
class ScanResult:
    """Full result of scanning one document."""
    document_id: str
    source_path: str
    sections: list[DocumentSection]
    full_text: str
    page_count: int
    ocr_pages: list[int] = field(default_factory=list)     # pages that required OCR


# ── Public API ────────────────────────────────────────────────────────────────

def scan_document(path: str | Path, document_id: str) -> ScanResult:
    """
    Primary entry point.  Accepts a PDF or image file path.
    Returns a ScanResult with all extracted sections.
    """
    path = Path(path)
    suffix = path.suffix.lower()

    if suffix == ".pdf":
        full_text, page_count, ocr_pages = _extract_pdf(path)
    elif suffix in {".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp"}:
        full_text, page_count, ocr_pages = _extract_image(path)
    elif suffix == ".txt":
        full_text = path.read_text(encoding="utf-8")
        page_count = 1
        ocr_pages = []
    else:
        raise ValueError(f"Unsupported file type: {suffix}")

    sections = _split_into_sections(full_text)

    return ScanResult(
        document_id=document_id,
        source_path=str(path),
        sections=sections,
        full_text=full_text,
        page_count=page_count,
        ocr_pages=ocr_pages,
    )


# ── Internal helpers ──────────────────────────────────────────────────────────

def _extract_pdf(path: Path) -> tuple[str, int, list[int]]:
    """Extract text from a PDF, falling back to OCR per page if needed."""
    if pdfplumber is None:
        raise RuntimeError("pdfplumber not installed. Run: pip install pdfplumber")

    all_text_parts: list[str] = []
    ocr_pages: list[int] = []

    with pdfplumber.open(path) as pdf:
        page_count = len(pdf.pages)
        for i, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            if len(text.strip()) < MIN_CHARS_BEFORE_OCR:
                # Page is likely a scan — try OCR via PyMuPDF image render
                ocr_text = _ocr_pdf_page(path, i)
                if ocr_text:
                    text = ocr_text
                    ocr_pages.append(i + 1)
            all_text_parts.append(text)

    return "\n".join(all_text_parts), page_count, ocr_pages


def _ocr_pdf_page(pdf_path: Path, page_index: int) -> str:
    """Render a PDF page to an image and run tesseract OCR on it."""
    if not OCR_AVAILABLE:
        return ""
    if fitz is None:
        return ""

    doc = fitz.open(str(pdf_path))
    page = doc[page_index]
    mat = fitz.Matrix(2.0, 2.0)   # 2× zoom → ~150 DPI → good OCR quality
    pix = page.get_pixmap(matrix=mat, alpha=False)
    img_bytes = pix.tobytes("png")
    img = Image.open(io.BytesIO(img_bytes))
    return pytesseract.image_to_string(img, lang="eng")


def _extract_image(path: Path) -> tuple[str, int, list[int]]:
    """Run OCR directly on an image file."""
    if not OCR_AVAILABLE:
        raise RuntimeError("pytesseract / Pillow not installed.")
    img = Image.open(path)
    text = pytesseract.image_to_string(img, lang="eng")
    return text, 1, [1]


def _split_into_sections(text: str) -> list[DocumentSection]:
    """
    Split a linear text stream into DocumentSection objects.

    Algorithm:
    - Find all section header positions via regex.
    - Slice text between consecutive headers.
    - Anything before the first header becomes an "UNCLASSIFIED" section.
    """
    matches = list(_HEADER_RE.finditer(text))

    if not matches:
        # No headers found — return the whole document as one section
        return [DocumentSection(
            section_name="DOCUMENT",
            raw_text=text.strip(),
            char_offset=0,
        )]

    sections: list[DocumentSection] = []

    # Text before the first header
    preamble = text[: matches[0].start()].strip()
    if preamble:
        sections.append(DocumentSection(
            section_name="PREAMBLE",
            raw_text=preamble,
            char_offset=0,
        ))

    for idx, match in enumerate(matches):
        header_name = _normalize_header(match.group(1))
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        body = text[start:end].strip()

        sections.append(DocumentSection(
            section_name=header_name,
            raw_text=body,
            char_offset=match.start(),
        ))

    return sections


def _normalize_header(raw: str) -> str:
    """Collapse whitespace and upper-case the header name."""
    return re.sub(r"\s+", " ", raw).strip().upper()
