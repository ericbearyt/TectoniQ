# TectoniQ Worker Pipeline — Reference

This document describes the seven workers that form the backend processing pipeline. Workers run **sequentially**: Worker 4 → Worker 5 (which runs Worker 1 per chunk) → Worker 6 → Worker 7 → Worker 2 → Worker 3.

---

## Overview

```
PDF bytes
   │
   ▼
┌──────────────────────────────────────────┐
│  Worker 4 — PDF Chunk Splitter          │
│  File: backend/workers/worker4_chunk_splitter.py │
│  Quick text scan → header boundaries    │
│  → split into chunks                    │
└────────────────────┬─────────────────────┘
                     │  chunks[] (header-delimited page groups)
                     ▼
┌──────────────────────────────────────────┐
│  Worker 5 — Chunk Progress Tracker      │
│  File: backend/workers/worker5_progress_tracker.py │
│  Runs Worker 1 on each chunk,           │
│  emits progress (1/N, 2/N, ...)         │
│  Merges results into unified output     │
└────────────────────┬─────────────────────┘
                     │  merged Worker 1 output (sections + term_frequency)
                     ▼
┌──────────────────────────────────────────┐
│  Worker 6 — Section Heading Labeler     │
│  File: backend/workers/worker6_section_labeler.py │
│  Assigns semantic labels to sections    │
│  (e.g., "Progress 1: Social History")   │
└────────────────────┬─────────────────────┘
                     │  labeled_sections[] + section_outline[]
                     ▼
┌──────────────────────────────────────────┐
│  Worker 7 — Clinical Term Filter        │
│  File: backend/workers/worker7_filter.py │
│  Filters term frequency list using      │
│  local database + noise blacklist       │
└────────────────────┬─────────────────────┘
                     │  filtered term_frequency{}
                     ▼
┌──────────────────────────────────────────┐
│  Worker 2 — 1D Timeline Mapper          │
│  File: backend/workers/worker2_timeline.py  │
└────────────────────┬─────────────────────┘
                     │  timeline[]
                     ▼
┌──────────────────────────────────────────┐
│  Worker 3 — Gemini Semantic NER         │
│  File: backend/workers/worker3_gemini_ner.py │
└────────────────────┬─────────────────────┘
                     │  annotated timeline[] + ner_summary{}
                     ▼
              Final JSON response
```

---

## Worker 4 — PDF Chunk Splitter

**File:** `backend/workers/worker4_chunk_splitter.py`

### What it does

1. Accepts raw PDF bytes
2. Does a **lightweight first-pass** text extraction using `pdfminer` to scan each page for major section headers
3. Uses the same header detection regex patterns as Worker 1 (ALL CAPS, numbered headings, known clinical headers, markdown `##`)
4. Identifies the page numbers where major headers appear
5. Groups consecutive pages between header boundaries into **chunks**
6. Uses `PyPDF2` to split the original PDF into per-chunk sub-PDFs at those boundaries

### Key Design: Header-Based Chunking

Chunks are **not** fixed page counts. They match the document's actual structure. For example:

| Chunk | Pages | Header Boundary |
|-------|-------|-----------------|
| 1/4   | 1–3   | CHIEF COMPLAINT |
| 2/4   | 4–6   | PAST MEDICAL HISTORY |
| 3/4   | 7–9   | ASSESSMENT & PLAN |
| 4/4   | 10–12 | DISCHARGE SUMMARY |

### Input

```python
pdf_bytes: bytes  # raw PDF file content
```

### Output Contract

```json
{
  "chunks": [
    {
      "chunk_id": "c0",
      "header": "CHIEF COMPLAINT",
      "pages": [1, 2, 3],
      "pdf_bytes": "<bytes>"
    }
  ],
  "total_chunks": 4,
  "total_pages": 12
}
```

### Edge Cases

- **Single-page PDFs**: produces 1 chunk
- **No headers detected**: entire document becomes 1 chunk labeled "DOCUMENT"
- **Headers on same page**: grouped under the first header found on that page
- **Pages before first header**: grouped into a "DOCUMENT START" chunk

### Dependencies

| Package | Minimum Version | Purpose |
|---------|-----------------|---------|
| `pdfminer.six` | `20221105` | Lightweight text extraction for header scanning |
| `PyPDF2` | `3.0.0` | Splitting PDF into sub-documents |

---

## Worker 5 — Chunk Progress Tracker

**File:** `backend/workers/worker5_progress_tracker.py`

### What it does

1. Takes Worker 4's output (list of chunks)
2. Iterates over each chunk sequentially
3. Calls Worker 1's `run()` on each chunk's PDF bytes
4. After each chunk completes, emits a progress event via an optional callback
5. Re-indexes all section IDs to be globally unique (`s0`, `s1`, ...) across chunks
6. Adjusts page numbers to reflect position in the original document
7. Merges all chunk results into a single unified Worker 1 output

### Input

```python
worker4_output: dict  # output of Worker 4
progress_callback: callable  # optional, called after each chunk
```

### Progress Callback

The `progress_callback` function receives a dict after each chunk:

```json
{
  "event": "chunk_progress",
  "chunk": 2,
  "total": 6,
  "header": "PAST MEDICAL HISTORY",
  "status": "done",
  "sections_found": 4,
  "pages": [4, 5, 6]
}
```

Status values: `"processing"` (before chunk starts), `"done"` (after chunk completes)

### Output Contract

```json
{
  "sections": [
    {
      "id": "s0",
      "header": "CHIEF COMPLAINT",
      "page": 1,
      "content": "Patient presents with..."
    }
  ],
  "term_frequency": {
    "hypertension": 4,
    "metformin": 2
  },
  "page_count": 12
}
```

This matches the Worker 1 output contract exactly, so downstream workers (6, 2, 3) are unaffected.

---

## Worker 6 — Section Heading Labeler

**File:** `backend/workers/worker6_section_labeler.py`

### What it does

1. Takes the merged Worker 1 output (sections list)
2. Classifies each section header against known clinical categories:
   - **complaint**: Chief Complaint, Reason for Visit
   - **history**: Social History, Family History, Past Medical History, HPI
   - **examination**: Physical Exam, Vitals, ROS
   - **results**: Labs, Imaging, Pathology
   - **assessment**: Assessment, Impression, Diagnosis
   - **plan**: Plan, Medications, Discharge Summary
   - **procedure**: Procedures, Surgical History, Operative Note
   - **other**: anything that doesn't match
3. Assigns a `section_label` (e.g., "Progress 1: Social History") and `section_group` to each section
4. Generates a `section_outline` — a table of contents for the document

### Input

```python
worker1_output: dict  # output of Worker 5 (merged Worker 1 output)
```

### Output Contract

Each section gains two new fields:

```json
{
  "id": "s0",
  "header": "SOCIAL HISTORY",
  "page": 2,
  "content": "...",
  "section_label": "Progress 1: Social History",
  "section_group": "history"
}
```

Top-level adds a `section_outline`:

```json
{
  "sections": [ "...enriched sections..." ],
  "term_frequency": { "..." },
  "page_count": 10,
  "section_outline": [
    {
      "index": 1,
      "label": "Progress 1: Social History",
      "group": "history",
      "section_id": "s0",
      "page": 2,
      "header": "SOCIAL HISTORY"
    }
  ]
}
```

---

## Worker 1 — Frequency Tallier

**File:** `backend/workers/worker1_frequency.py`

### What it does

1. Accepts raw PDF bytes (now per-chunk from Worker 5)
2. Uses `pdfminer.six` to extract text page-by-page
3. Detects section headers using regex patterns:
   - ALL CAPS lines
   - Numbered headings (`1.`, `A.`, `I.`)
   - Common clinical headers (`ASSESSMENT`, `PLAN`, `HPI`, etc.)
   - Markdown-style (`##`)
4. Splits the document into named sections
5. Tokenizes all text, removes stop words, counts term frequency globally

### Input

```python
pdf_bytes: bytes  # raw PDF file content
```

### Output Contract

```json
{
  "sections": [
    {
      "id": "s0",
      "header": "CHIEF COMPLAINT",
      "page": 1,
      "content": "Patient presents with..."
    }
  ],
  "term_frequency": {
    "hypertension": 4,
    "metformin": 2
  },
  "page_count": 8
}
```

### Configurable Constants

| Constant | Default | Description |
|----------|---------|-------------|
| `MIN_TERM_LENGTH` | `3` | Minimum character length for a token to be counted |
| `MAX_TERMS` | `500` | Maximum unique terms returned |

---

## Worker 7 — Clinical Term Filter

**File:** `backend/workers/worker7_filter.py`

### What it does

1. Accepts the output from Worker 6 (enriched sections + global term frequency list)
2. Filters out terms from `term_frequency` that:
   - Do not appear in the 96,000+ local medical term database (`data/medical_terminology.json`)
   - Match a curated blacklist of common non-clinical meta terms (e.g., `"doctor"`, `"hospital"`, `"patient"`, `"page"`, `"notes"`, `"cornell"`)
   - Are less than 3 characters long or are entirely numeric
3. Returns the enriched document payload with the cleaned `term_frequency` dictionary

### Input

```python
worker6_output: dict  # output of Worker 6
```

### Output Contract

```json
{
  "sections": [ "..." ],
  "term_frequency": {
    "hypertension": 4,
    "metformin": 2
    // noise terms like "cornell" are filtered out here
  },
  "page_count": 12,
  "section_outline": [ "..." ]
}
```

---

## Worker 2 — 1D Timeline Mapper

**File:** `backend/workers/worker2_timeline.py`

### What it does

1. Iterates every section in document order
2. For each term in `term_frequency`, searches each section for its presence
3. Records every position `{ section_id, section_header, page }` where it appears
4. Computes:
   - `first_seen` — earliest position
   - `last_seen` — latest position
   - `recurrence_gap` — number of sections between first and last appearance
5. Sorts the timeline by first appearance order

### Input

```python
worker1_output: dict  # output of Worker 6 (enriched Worker 1 output)
```

### Output Contract

```json
{
  "timeline": [
    {
      "term": "hypertension",
      "count": 4,
      "first_seen": { "section_id": "s1", "section_header": "PAST MEDICAL HISTORY", "page": 2 },
      "last_seen":  { "section_id": "s6", "section_header": "ASSESSMENT", "page": 7 },
      "occurrences": [
        { "section_id": "s1", "section_header": "PAST MEDICAL HISTORY", "page": 2 },
        { "section_id": "s3", "section_header": "ASSESSMENT", "page": 4 }
      ],
      "recurrence_gap": 5,
      "sections_present": ["s1", "s3", "s6"]
    }
  ]
}
```

### Notes

- Multi-word terms (e.g., `"heart failure"`) are matched as substrings after normalization
- Single-word terms use word-boundary regex (`\b`) to avoid partial matches

---

## Worker 3 — Gemini Semantic NER

**File:** `backend/workers/worker3_gemini_ner.py`

### What it does

1. Takes the top-N most frequent terms from Worker 1 (default: 60)
2. Sends them in a single structured prompt to the Gemini API
3. Asks Gemini to classify each term as one of:
   - `diagnosis` — a disease, condition, or syndrome
   - `medication` — a drug or supplement
   - `procedure` — a test, surgery, or clinical intervention
   - `biomarker` — a lab value or biological marker
   - `demographic` — patient attribute (age, sex, ethnicity)
   - `other` — anything that doesn't fit above
4. Also asks Gemini to assign a status:
   - `active` — currently relevant
   - `historical` — past/resolved
   - `unknown` — cannot determine
5. Merges these annotations back into the timeline entries

### Input

```python
worker1_output: dict  # output of Worker 6 (enriched Worker 1 output)
worker2_output: dict  # output of Worker 2
```

### Output Contract

Each timeline entry from Worker 2 gains three new fields:

```json
{
  "term": "hypertension",
  "category": "diagnosis",
  "status": "active",
  "ner_confidence": "high",
  "... (all Worker 2 fields preserved)"
}
```

Top-level summary:

```json
{
  "timeline": [ "...annotated entries..." ],
  "ner_summary": {
    "total_terms": 60,
    "reviewed_terms": 58,
    "categories": {
      "diagnosis": 12,
      "medication": 18,
      "procedure": 8
    },
    "gemini_available": true
  }
}
```

### Graceful Degradation

If `GEMINI_API_KEY` is not set or `google-generativeai` is not installed:
- All terms receive `"category": "other"`, `"status": "unknown"`, `"ner_confidence": "unreviewed"`
- The rest of the pipeline and UI continue to work normally
- `ner_summary.gemini_available` is `false`

### Configurable Constants

| Constant | Default | Description |
|----------|---------|-------------|
| `TOP_N_TERMS` | `60` | How many top-frequency terms to send to Gemini |

---

## Extending the Pipeline

To add a Worker 8 (e.g., a FHIR exporter or deduplication engine):

1. Create `backend/workers/worker8_yourname.py`
2. Implement a `run(previous_output: dict) -> dict` function
3. Import and call it in `backend/app.py` in the appropriate pipeline position
4. Document it here in `README_WORKERS.md`

---

## Running Workers in Isolation (for testing)

```python
# From the backend/ directory with venv active
import json
from workers import (
    worker4_chunk_splitter, worker5_progress_tracker,
    worker6_section_labeler, worker7_filter, worker2_timeline, worker3_gemini_ner
)

with open("test.pdf", "rb") as f:
    pdf_bytes = f.read()

w4 = worker4_chunk_splitter.run(pdf_bytes)
w5 = worker5_progress_tracker.run(w4)        # runs Worker 1 per chunk internally
w6 = worker6_section_labeler.run(w5)
w7 = worker7_filter.run(w6)
w2 = worker2_timeline.run(w7)
w3 = worker3_gemini_ner.run(w6, w2)          # Note: uses w6 (or w7) and timeline w2

print(json.dumps(w3, indent=2))
```
