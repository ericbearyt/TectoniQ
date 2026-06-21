/* ============================================================
   PATIENT DATA — single shared record
   Extracted (once) from My Health Summary_Redactedv2.pdf.
   Consumed by patient-view.js and dashboard.js to populate
   every tab around this one (redacted) patient.

   NOTE: care-team specialties and episode groupings are demo
   inferences from the record's content, not asserted facts
   beyond what the source states (Rubin=Neurology, EMG/MG;
   Montesdeoca=Pathology are explicit in the source).
   ============================================================ */

window.PATIENT_DATA = (function () {
  "use strict";

  const demographics = {
    name: "Redacted Patient",
    initials: "RP",
    mrn: "REDACTED",
    dob: "Aug. 18, 1993",
    age: 32,
    sex: "Female",
    language: "English (Preferred)",
    race: "Asian / Not Hispanic or Latino",
    maritalStatus: "Unknown",
    institution: "Weill Cornell Medicine · NewYork-Presbyterian",
    summaryDate: "Jun. 03, 2026",
    allergies: "No known active allergies",
    status: "Active",
  };

  // Body-system tag used for grouping charts.
  const activeConditions = [
    { name: "Myasthenia gravis", noted: "10/26/2023", system: "Neurological" },
    { name: "Mitral valve prolapse", noted: "10/26/2023", system: "Cardiovascular" },
    { name: "Anxiety", noted: "08/29/2023", system: "Psychiatric" },
    { name: "Depression", noted: "08/29/2023", system: "Psychiatric" },
    { name: "Iron deficiency", noted: "04/21/2026", system: "Hematologic" },
    { name: "Positive ANA (antinuclear antibody)", noted: "04/08/2024", system: "Immunologic" },
    { name: "Patellofemoral disorder of left knee", noted: "01/13/2026", system: "Musculoskeletal" },
    { name: "Lumbar disc degeneration w/ back pain", noted: "01/13/2026", system: "Musculoskeletal" },
    { name: "Regurgitation of food", noted: "08/28/2024", system: "Gastrointestinal" },
    { name: "Pain in both lower legs", noted: "04/08/2024", system: "Musculoskeletal" },
    { name: "Dysphonia", noted: "02/28/2024", system: "Neurological" },
    { name: "Disorder of vocal cords", noted: "02/28/2024", system: "Neurological" },
    { name: "Cardiac complaint", noted: "09/06/2023", system: "Cardiovascular" },
    { name: "S/P appendectomy", noted: "10/23/2025", system: "Gastrointestinal" },
  ];

  const resolvedConditions = [
    { name: "Appendicitis", resolved: "04/21/2026", system: "Gastrointestinal" },
    { name: "Abdominal pain", resolved: "03/05/2025", system: "Gastrointestinal" },
    { name: "Chest pain", resolved: "04/21/2026", system: "Cardiovascular" },
    { name: "Iron deficiency anemia", resolved: "04/21/2026", system: "Hematologic" },
  ];

  const medications = [
    { name: "lamoTRIgine 25 MG Tablet", category: "Mood stabilizer", dose: "75 mg", instructions: "Take 3 tablets by mouth daily.", started: "3/6/2025", status: "Active" },
    { name: "clonazePAM 0.5 MG Tablet", category: "Anxiolytic", dose: "0.5 mg", instructions: "1 tablet by mouth 2× daily as needed for anxiety.", started: "3/5/2025", status: "Active" },
    { name: "quetiapine 50 MG Tablet", category: "Antipsychotic", dose: "50 mg", instructions: "Take 1 tablet by mouth nightly.", started: "—", status: "Active" },
    { name: "ferrous sulfate 325 (65 FE) MG Tablet DR", category: "Iron supplement", dose: "325 mg", instructions: "1 tablet by mouth 3× a week.", started: "—", status: "Active" },
    { name: "JUNEL 1-20 MG-MCG Tablet", category: "Contraceptive", dose: "1-20 mg-mcg", instructions: "Take 1 tablet by mouth every day.", started: "5/27/2026", status: "Active" },
    { name: "Paragard Intrauterine Copper IUD", category: "Contraceptive (device)", dose: "—", instructions: "By intrauterine route.", started: "9/10/2024", status: "Active" },
  ];

  // Most-recent value per lab vs reference range. flag: 'H' | 'L' | null.
  const labs = [
    { name: "Hemoglobin", value: 12.7, low: 11.7, high: 15.5, unit: "g/dL", flag: null, date: "04/21/2026" },
    { name: "Ferritin", value: 17, low: 13, high: 150, unit: "ng/mL", flag: null, date: "04/21/2026" },
    { name: "Platelets", value: 330, low: 140, high: 400, unit: "K/uL", flag: null, date: "04/21/2026" },
    { name: "RDW", value: 14.2, low: 11.0, high: 15.0, unit: "%", flag: null, date: "04/21/2026" },
    { name: "Potassium", value: 4.7, low: 3.5, high: 5.1, unit: "mmol/L", flag: null, date: "04/21/2026" },
    { name: "Glucose", value: 72, low: 74, high: 106, unit: "mg/dL", flag: "L", date: "04/21/2026" },
    { name: "HbA1c", value: 5.1, low: 0, high: 5.7, unit: "%", flag: null, date: "12/24/2025" },
    { name: "Albumin", value: 4.4, low: 3.5, high: 5.2, unit: "g/dL", flag: null, date: "04/21/2026" },
    { name: "T4 (Total)", value: 9.6, low: 5.1, high: 11.9, unit: "mcg/dL", flag: null, date: "12/24/2025" },
    { name: "Cholesterol", value: 191, low: 0, high: 199, unit: "mg/dL", flag: null, date: "04/21/2026" },
    { name: "LDL", value: 111, low: 0, high: 99, unit: "mg/dL", flag: "H", date: "04/21/2026" },
    { name: "HDL", value: 61, low: 50, high: 120, unit: "mg/dL", flag: null, date: "04/21/2026" },
    { name: "Triglycerides", value: 91, low: 0, high: 149, unit: "mg/dL", flag: null, date: "04/21/2026" },
  ];

  // Care team (names from the record; specialties inferred for the demo).
  const careTeam = [
    { name: "Michael Rubin, M.D.", specialty: "Neurology", note: "EMG, myasthenia gravis" },
    { name: "Melissa Leigh Rubianes", specialty: "Internal Medicine", note: "Primary care" },
    { name: "Hank Steven Swerdloff", specialty: "Neurology", note: "Neuromuscular" },
    { name: "Susan Cavender", specialty: "Gastroenterology", note: "GI workup" },
    { name: "Claudia Montesdeoca", specialty: "Pathology", note: "Cytology / lab" },
    { name: "Tina Mathew", specialty: "Rheumatology", note: "Autoimmune panel" },
  ];

  // Clinical episodes — date ranges drive the timeline tab.
  // type maps to the existing timeline legend palette.
  const episodes = [
    { id: "EP-01", start: "2023-08-26", end: "2023-09-18", title: "Inpatient — Neuromuscular workup → Myasthenia gravis dx", doctor: "Michael Rubin", specialty: "Neurology", type: "Inpatient", risk: "High", stage: "Acute" },
    { id: "EP-02", start: "2024-03-18", end: "2024-04-03", title: "Autoimmune / ANA workup (positive ANA, RF, TSH)", doctor: "Tina Mathew", specialty: "Rheumatology", type: "Outpatient", risk: "Moderate", stage: "Workup" },
    { id: "EP-03", start: "2024-08-28", end: "2024-09-03", title: "GI evaluation — food regurgitation, CT abdomen/pelvis", doctor: "Susan Cavender", specialty: "Gastroenterology", type: "Outpatient", risk: "Moderate", stage: "Workup" },
    { id: "EP-04", start: "2025-03-01", end: "2025-03-05", title: "ER — abdominal pain → appendicitis", doctor: "Susan Cavender", specialty: "Emergency / GI", type: "Inpatient", risk: "High", stage: "Acute" },
    { id: "EP-05", start: "2025-10-13", end: "2025-10-23", title: "Appendectomy (surgical pathology)", doctor: "Susan Cavender", specialty: "Surgery", type: "Surgical Procedure", risk: "High", stage: "Treatment" },
    { id: "EP-06", start: "2025-12-24", end: "2025-12-24", title: "Neuro-immune panel (AchR, MAG, ESR, CRP, vitamins)", doctor: "Hank Steven Swerdloff", specialty: "Neurology", type: "Outpatient", risk: "Low", stage: "Monitoring" },
    { id: "EP-07", start: "2026-01-13", end: "2026-02-02", title: "Ortho / Neuro — knee XR, lumbar disc, EMG", doctor: "Michael Rubin", specialty: "Neurology", type: "MRI / CT scan", risk: "Low", stage: "Workup" },
    { id: "EP-08", start: "2026-03-06", end: "2026-03-06", title: "GYN — Pap / HPV, ferritin", doctor: "Claudia Montesdeoca", specialty: "Pathology", type: "Outpatient", risk: "Low", stage: "Screening" },
    { id: "EP-09", start: "2026-04-21", end: "2026-04-21", title: "Iron deficiency dx — CMP, lipid, endocrine labs", doctor: "Melissa Leigh Rubianes", specialty: "Internal Medicine", type: "Outpatient", risk: "Low", stage: "Monitoring" },
  ];

  // Stats derived once for KPI cards.
  const stats = {
    totalLabsOnFile: 336,
    labsTracked: labs.length,
    labsFlagged: labs.filter(function (l) { return l.flag; }).length,
    activeProblems: activeConditions.length,
    activeMeds: medications.length,
    episodes: episodes.length,
    firstVisit: "Aug. 26, 2023",
    lastVisit: "Apr. 21, 2026",
  };

  return {
    demographics: demographics,
    activeConditions: activeConditions,
    resolvedConditions: resolvedConditions,
    medications: medications,
    labs: labs,
    careTeam: careTeam,
    episodes: episodes,
    stats: stats,
  };
})();
