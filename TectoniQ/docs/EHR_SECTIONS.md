# EHR Section Standards

Reference for the common, recurring sections found in clinical documents that
TectoniQ ingests. **This is a convention, not a guarantee** — real EHR exports
are heterogeneous stacks of many document types and vary widely in length,
naming, and structure (see [Caveats](#caveats)). This document defines the
canonical section set TectoniQ normalizes toward, the header synonyms we accept,
and how each maps onto downstream FHIR resources.

This list is the source of truth for the header-detection patterns in
[`backend/workers/worker1_frequency.py`](../backend/workers/worker1_frequency.py)
(`HEADER_PATTERNS`). Keep the two in sync.

---

## Canonical sections

Sections are grouped by the standard clinical note structure (H&P / SOAP /
discharge summary). Each row lists the canonical name, common header synonyms /
abbreviations seen in the wild, and the primary FHIR resource it feeds.

### 1. Identification & Encounter

| Canonical            | Common synonyms / headers                          | FHIR target           |
| -------------------- | -------------------------------------------------- | --------------------- |
| Chief Complaint      | `CC`, `Reason for Visit`, `Presenting Complaint`   | `Encounter.reasonCode`|
| History of Present Illness | `HPI`, `History of Present Illness`          | `Condition` (context) |

### 2. History

| Canonical            | Common synonyms / headers                          | FHIR target           |
| -------------------- | -------------------------------------------------- | --------------------- |
| Past Medical History | `PMH`, `Past Medical History`, `Problem List`      | `Condition`           |
| Past Surgical History| `PSH`, `Surgical History`, `Procedures`            | `Procedure`           |
| Medications          | `Meds`, `Current Medications`, `Home Medications`, `Medication List` | `MedicationStatement` / `MedicationRequest` |
| Allergies            | `Allergies`, `Allergies and Intolerances`, `NKDA`  | `AllergyIntolerance`  |
| Family History       | `FH`, `Family History`                             | `FamilyMemberHistory` |
| Social History       | `SH`, `Social History`, `Substance Use`            | `Observation` (social-history) |
| Review of Systems    | `ROS`, `Review of Systems`                         | `Observation`         |

### 3. Objective / Exam

| Canonical            | Common synonyms / headers                          | FHIR target           |
| -------------------- | -------------------------------------------------- | --------------------- |
| Vitals               | `Vitals`, `Vital Signs`                            | `Observation` (vital-signs) |
| Physical Exam        | `PE`, `Physical Exam`, `Examination`               | `Observation`         |
| Labs                 | `Labs`, `Laboratory Results`, `Lab Data`           | `Observation` (laboratory) / `DiagnosticReport` |
| Imaging              | `Imaging`, `Radiology`, `Diagnostic Imaging`       | `DiagnosticReport` / `ImagingStudy` |

### 4. Assessment & Plan

| Canonical            | Common synonyms / headers                          | FHIR target           |
| -------------------- | -------------------------------------------------- | --------------------- |
| Assessment           | `Assessment`, `Impression`, `Diagnosis`            | `Condition`           |
| Plan                 | `Plan`, `Treatment Plan`, `Recommendations`        | `CarePlan` / `ServiceRequest` |
| Assessment & Plan    | `A/P`, `A&P`, `Assessment and Plan`                | `Condition` + `CarePlan` |

### 5. Disposition

| Canonical            | Common synonyms / headers                          | FHIR target           |
| -------------------- | -------------------------------------------------- | --------------------- |
| Discharge Summary    | `Discharge Summary`, `Discharge Disposition`       | `Encounter` / `CarePlan` |
| Follow-up            | `Follow-up`, `Follow Up Instructions`              | `ServiceRequest`      |

---

## Standard note formats these sections compose into

- **SOAP** — Subjective, Objective, Assessment, Plan. The progress-note backbone.
- **H&P** (History & Physical) — CC, HPI, PMH/PSH, Meds, Allergies, FH, SH, ROS,
  Vitals, PE, Labs/Imaging, Assessment, Plan.
- **Discharge Summary** — Admission/discharge dates, diagnoses, hospital course,
  meds at discharge, follow-up.

---

## Caveats

Real-world EHR exports do **not** reliably conform to this list:

- **No standard length.** A routine visit note is 1–5 pages; a litigation or
  disability record dump can be 1,000–3,000+ pages because it concatenates every
  document on file. There is no meaningful "average."
- **Note bloat.** Copy-forward and auto-pulled labs/flowsheets in Epic/Cerner
  inflate length without adding information.
- **Heterogeneous document types.** A large record is a stack of nursing
  flowsheets, lab reports, imaging reports, scanned faxes, and billing — not one
  long structured note. Many of these have no clean section headers.
- **Scanned / image-only pages** have no text layer. `pdfminer` returns empty
  text; these require an OCR path (`pytesseract`, in `requirements.txt`).
- **Naming is inconsistent.** Same section, many labels and abbreviations — hence
  the synonym columns above.

When no header is detected, `worker1` assigns content to a `DOCUMENT START`
fallback section so nothing is dropped.
