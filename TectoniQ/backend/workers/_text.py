"""
Shared text utilities
======================
Single source of truth for tokenization across the worker pipeline.

Worker 1 builds ``term_frequency`` from these tokens; Worker 2 must tokenize
sections with the *exact* same logic so that its inverted-index keys line up
with the term keys Worker 1 produced. Importing from one place guarantees that
parity — if the rules drift, both workers drift together.
"""

import string

# ---------------------------------------------------------------------------
# Stop words — common English + clinical filler words to exclude from counts
# ---------------------------------------------------------------------------
STOP_WORDS = {
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
    "been", "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "shall", "can", "need",
    "dare", "ought", "used", "this", "that", "these", "those", "i", "you",
    "he", "she", "it", "we", "they", "what", "which", "who", "whom",
    "not", "no", "nor", "so", "yet", "both", "either", "neither",
    "each", "every", "all", "any", "both", "few", "more", "most",
    "other", "some", "such", "than", "too", "very", "just", "also",
    "patient", "date", "time", "page", "see", "noted", "per",
}

MIN_TERM_LENGTH = 3   # skip tokens shorter than this

# Translate every punctuation char to a space, so "co-morbid" -> "co morbid".
_PUNCT_TRANSLATOR = str.maketrans(string.punctuation, " " * len(string.punctuation))


def tokenize(text: str) -> list[str]:
    """Lowercase, strip punctuation, remove stop words, short tokens, and digits."""
    cleaned = text.lower().translate(_PUNCT_TRANSLATOR)
    tokens = cleaned.split()
    return [
        t for t in tokens
        if len(t) >= MIN_TERM_LENGTH and t not in STOP_WORDS and not t.isdigit()
    ]


def normalize(text: str) -> str:
    """Lowercase + punctuation-to-space, no filtering. Used for multi-word substring scans."""
    return text.lower().translate(_PUNCT_TRANSLATOR)


def extract_pdf_pages(pdf_bytes: bytes) -> list[dict]:
    """
    Extract text page-by-page using PyMuPDF (fitz), which is ~10-50x faster than
    pdfminer — the single biggest win for large documents (e.g. a 1,600-page
    record). Single source of truth so Worker 1 and Worker 4 stay in lockstep.

    Returns [{ "page": int (1-indexed), "text": str }].
    """
    import fitz  # PyMuPDF

    pages = []
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        for i, page in enumerate(doc, start=1):
            pages.append({"page": i, "text": page.get_text("text")})
    finally:
        doc.close()
    return pages
