"""
Worker 1 — Frequency Tallier
=============================
Accepts a PDF binary (bytes), extracts raw text via pdfminer.six,
splits the document into sections by detecting header patterns,
and produces a term-frequency map across the full document.

Output contract
---------------
{
    "sections": [
        {
            "id": "s0",
            "header": "Assessment",
            "page": 1,
            "content": "full text of section..."
        }
    ],
    "term_frequency": {
        "tamoxifen": 8,
        "hypertension": 5
    },
    "page_count": 10
}
"""

import io
import re
from collections import Counter

from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextContainer, LTAnno, LTChar

from ._text import tokenize as _tokenize

# ---------------------------------------------------------------------------
# Header detection patterns
# Matches: ALL CAPS lines, numbered headings (1. / A. / I.), markdown ##
# ---------------------------------------------------------------------------
HEADER_PATTERNS = [
    re.compile(r"^[A-Z][A-Z\s\-/&]{3,}$"),          # ALL CAPS
    re.compile(r"^\d+[\.\)]\s+[A-Z]"),               # 1. or 1) Heading
    re.compile(r"^[A-Z][\.\)]\s+[A-Z]"),             # A. or A) Heading
    re.compile(r"^#{1,3}\s+"),                        # Markdown ## headings
    re.compile(r"^(ASSESSMENT|PLAN|HPI|ROS|PMH|MEDICATIONS|ALLERGIES|"
               r"SOCIAL HISTORY|FAMILY HISTORY|PHYSICAL EXAM|VITALS|"
               r"LABS|IMAGING|PROCEDURES|DIAGNOSIS|IMPRESSION|"
               r"CHIEF COMPLAINT|HISTORY OF PRESENT ILLNESS|"
               r"REVIEW OF SYSTEMS|PAST MEDICAL HISTORY|"
               r"SURGICAL HISTORY|PROBLEM LIST|DISCHARGE SUMMARY)"),
]

MAX_TERMS = 500       # cap on unique terms returned


def _is_header(line: str) -> bool:
    """Return True if the line looks like a section header."""
    stripped = line.strip()
    if not stripped or len(stripped) > 120:
        return False
    return any(p.match(stripped) for p in HEADER_PATTERNS)


def _extract_text_by_page(pdf_bytes: bytes) -> list[dict]:
    """
    Use pdfminer to extract text page-by-page.
    Returns a list of { page: int, text: str } dicts.
    """
    pages = []
    pdf_file = io.BytesIO(pdf_bytes)
    for page_num, page_layout in enumerate(extract_pages(pdf_file), start=1):
        page_text_parts = []
        for element in page_layout:
            if isinstance(element, LTTextContainer):
                page_text_parts.append(element.get_text())
        pages.append({"page": page_num, "text": "\n".join(page_text_parts)})
    return pages


def _split_into_sections(pages: list[dict]) -> list[dict]:
    """
    Walk through page text and split at header lines.
    Each section carries the page number where it began.
    """
    sections = []
    current_header = "DOCUMENT START"
    current_page = 1
    current_lines = []
    section_idx = 0

    for page_info in pages:
        for line in page_info["text"].splitlines():
            if _is_header(line):
                # Flush current section
                if current_lines:
                    sections.append({
                        "id": f"s{section_idx}",
                        "header": current_header,
                        "page": current_page,
                        "content": "\n".join(current_lines).strip(),
                    })
                    section_idx += 1
                current_header = line.strip()
                current_page = page_info["page"]
                current_lines = []
            else:
                current_lines.append(line)

    # Flush last section
    if current_lines:
        sections.append({
            "id": f"s{section_idx}",
            "header": current_header,
            "page": current_page,
            "content": "\n".join(current_lines).strip(),
        })

    return sections


def run(pdf_bytes: bytes) -> dict:
    """
    Main entry point for Worker 1.

    Parameters
    ----------
    pdf_bytes : bytes
        Raw PDF file content.

    Returns
    -------
    dict
        { sections, term_frequency, page_count }
    """
    pages = _extract_text_by_page(pdf_bytes)
    sections = _split_into_sections(pages)

    # Build global term frequency across all sections
    all_tokens = []
    for section in sections:
        all_tokens.extend(_tokenize(section["content"]))

    term_freq = dict(
        Counter(all_tokens).most_common(MAX_TERMS)
    )

    return {
        "sections": sections,
        "term_frequency": term_freq,
        "page_count": len(pages),
    }
