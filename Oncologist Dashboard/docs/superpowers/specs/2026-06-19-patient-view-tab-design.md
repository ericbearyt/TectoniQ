# Patient View Tab — Design

**Date:** 2026-06-19
**Status:** Approved

## Goal

Add a working "Patient View" tab to the existing oncologist dashboard, populated with one real (redacted) patient's data extracted from `My Health Summary_Redactedv2.pdf`. Gives the otherwise-empty skeleton a live demo screen.

## Data Source

`My Health Summary_Redactedv2.json` (1659-page health summary export). Data is extracted once and hardcoded into a JS data object — no runtime PDF parsing.

Patient: Female, born Aug. 18 1993 (age 32), English-speaking, Asian. Institution: Weill Cornell Medicine / Columbia Physicians / NewYork-Presbyterian. No known allergies.

## Placement

New tab `patient-view` added to:
- Sidebar nav (`index.html`)
- Tab bar (`index.html`)
- `TAB_IDS` array (`js/app.js`)
- Cmd+number shortcut range extended to 8

Inserted after "Patient Card", before "Analytics".

## Layout (top to bottom)

1. **Patient header** — reuse existing `.patient-header` component: initials avatar, demographics (DOB, age, sex, language, race), institution, "Active" badge. No-allergies note.

2. **Active Conditions** — badge/chip list, 14 conditions with noted dates (Myasthenia gravis, Mitral valve prolapse, Anxiety, Depression, Iron deficiency, etc.).

3. **Current Medications** — card grid, one card per med: name, dose, instructions, start date. 6 active meds.

4. **Lab Results** — Chart.js horizontal bar chart showing actual value vs reference range for ~12 key labs (Hemoglobin, Ferritin, LDL, HDL, Triglycerides, Glucose, HbA1c, T4, Potassium, RDW, Platelets, Albumin). Out-of-range values flagged. Chart.js loaded via CDN.

5. **Resolved Conditions** (collapsible `<details>`) — Appendicitis, Abdominal pain, Chest pain, Iron deficiency anemia, with resolved dates.

## Tech

- Pure vanilla JS, matching existing stack. Data object + render functions in new `js/patient-view.js`.
- Chart.js via CDN `<script>` (only new dependency).
- New CSS appended to `css/style.css` using existing design tokens (`--color-*`, `--space-*`). New classes: `.condition-chip`, `.med-card`, `.lab-bar` (only if Chart.js insufficient).

## Out of Scope

Editing data, multi-patient switching, real FHIR fetch, persistence.

## Addendum (2026-06-19) — All tabs populated

Extended beyond the single Patient View tab: every dashboard tab now renders
this one patient's data (single-patient framing), since the record contains
one patient.

- `js/patient-data.js` — shared `window.PATIENT_DATA` record (demographics,
  conditions, meds, labs, care team, clinical episodes, derived stats).
  Consumed by both `patient-view.js` and `dashboard.js`.
- `js/dashboard.js` — populates Dashboard (KPIs + 3 charts + activity feed),
  Patient Registry (1 row), Care/Medication Plans (meds + appendectomy),
  Care Timeline (episodes as positioned bars on a 2023–2026 axis), Patient
  Card (header, history, care team, systems chart, episodes table),
  Analytics (lab-position, systems donut, encounters + diagnoses charts).
  Charts render lazily per-tab once; Chart.js shared.
- Care-team specialties and episode groupings are demo inferences from the
  record content; Rubin=Neurology (EMG/MG) and Montesdeoca=Pathology are
  explicit in the source.
