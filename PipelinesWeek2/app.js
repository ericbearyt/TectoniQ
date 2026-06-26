/* ==========================================================================
   BEAM Pipeline 3 Core Application Script
   Database of 44 variables, interactive engine, PK solvers, stochastic marrow simulation,
   XGBoost decisions, SHAP waterfall generator, and clinical dashboard charting.
   ========================================================================== */

// ==========================================================================
// 1. Variable Database (44 Variables)
// ==========================================================================

const variablesDb = [
  // ── STAGE 1: PATIENT INPUTS (14 variables) ──
  {
    id: "age",
    name: "Age at ASCT",
    stage: 0,
    type: "Continuous (years)",
    classification: "imp",
    source: "EHR / Transplant Registry",
    desc: "Patient's age in years on the day of stem cell infusion (Day 0). Used directly as a covariate in ML models and as a modifier for organ reserve thresholds.",
    beam: "Older age reduces organ reserve — Carmustine lung scarring risk and Melphalan-induced renal decline are significantly amplified past 65. Historically restricted to under 60; now routinely performed into the 70s with careful comorbidity screening.",
    equation: "Age_{Modifier} = \\max(1.0, 1.0 + 0.03 \\cdot (Age - 65)) \\text{ for } Age > 65"
  },
  {
    id: "bsa",
    name: "Body Surface Area (BSA)",
    stage: 0,
    type: "Continuous (m²)",
    classification: "key",
    source: "Calculated (Mosteller/DuBois)",
    desc: "Derived from patient height and weight. Every BEAM drug dose is expressed as mg/m² and scaled to BSA before being passed to the PhysiPKPD PK models.",
    beam: "BEAM dosing is not one-size-fits-all. BSA is the primary dose-scaling variable. An incorrect BSA calculation propagates into all four PK compartment models and can cause under- or overdosing with severe toxicity consequences.",
    equation: "BSA = \\sqrt{\\frac{Height(cm) \\cdot Weight(kg)}{3600}}"
  },
  {
    id: "weight",
    name: "Patient Weight",
    stage: 0,
    type: "Continuous (kg)",
    classification: "neutral",
    source: "EHR / Vital Signs",
    desc: "Measured body weight at admission. Used to calculate BSA and to normalize the target stem cell dose (CD34+ cells/kg) for infusion.",
    beam: "Sizing influences toxic volume of distribution. For obese patients (BMI > 30), adjusted ideal body weight is used for chemotherapy calculation to avoid excess toxicity, whereas actual weight scales the CD34+ cell count.",
    equation: "Weight_{Ideal} = 50.0 + 2.3 \\cdot (Height(in) - 60)"
  },
  {
    id: "ecog",
    name: "ECOG Performance Score",
    stage: 0,
    type: "Ordinal (0–4)",
    classification: "crit",
    source: "Clinical Assessment",
    desc: "Standardized measure of patient functional status. 0 = fully active; 1 = restricted in strenuous activity; 2 = ambulatory but unable to work; 3–4 = limited / bedridden.",
    beam: "Hard exclusion criterion. ECOG 3–4 patients are excluded — the treatment's acute toxicity (febrile neutropenia, mucositis, severe fatigue) would be fatal in a patient with already-limited functional reserve. Only ECOG 0–2 are eligible.",
    equation: "\\text{Eligibility} = \\text{False if } ECOG \\ge 3"
  },
  {
    id: "lvef",
    name: "LVEF (Left Ventricular Ejection Fraction)",
    stage: 0,
    type: "Continuous (%)",
    classification: "crit",
    source: "Echocardiogram or MUGA scan",
    desc: "Percentage of blood ejected from the left ventricle per heartbeat. Measured via echo or nuclear MUGA scan within 4–6 weeks of planned transplant.",
    beam: "Minimum threshold 45–50%. BEAM conditioning — especially combined with prior anthracycline exposure — causes subclinical left ventricular dysfunction. Patients below threshold risk acute heart failure during the intensive conditioning week.",
    equation: "\\text{Eligibility} = \\text{False if } LVEF < 45\\%"
  },
  {
    id: "dlco",
    name: "DLCO % Predicted",
    stage: 0,
    type: "Continuous (%)",
    classification: "crit",
    source: "Pulmonary Function Test (PFT)",
    desc: "Diffusing capacity of the lungs for carbon monoxide, expressed as a percentage of the predicted value for the patient's age, sex, and height. Reflects gas exchange efficiency.",
    beam: "Minimum threshold 50–60%. Carmustine (BCNU) specifically causes chronic alveolar injury and lung fibrosis. A patient with already-reduced DLCO entering BEAM faces compounded pulmonary toxicity. DLCO also seeds the long-term pulmonary decline trajectory in the 15-year simulator.",
    equation: "\\text{Eligibility} = \\text{False if } DLCO < 50\\%"
  },
  {
    id: "crcl",
    name: "Creatinine Clearance (CrCl)",
    stage: 0,
    type: "Continuous (mL/min)",
    classification: "crit",
    source: "Blood test / CKD-EPI equation",
    desc: "Estimated renal filtration rate from serum creatinine, age, sex, and race using the CKD-EPI equation. Reflects functional nephron capacity.",
    beam: "Minimum threshold 40–60 mL/min. Melphalan is cleared almost entirely renally, so reduced CrCl directly prolongs drug exposure. Below threshold, PhysiPKPD raises the Melphalan renal stress score and may trigger a Mini-BEAM dose-reduction recommendation.",
    equation: "\\text{Eligibility} = \\text{False if } CrCl < 40\\text{ mL/min}"
  },
  {
    id: "cd34_yield",
    name: "CD34+ Stem Cell Yield",
    stage: 0,
    type: "Continuous (×10⁶ cells/kg)",
    classification: "crit",
    source: "Cell processing lab logs",
    desc: "Total CD34+ hematopoietic progenitor cells harvested during apheresis and available for reinfusion on Day 0, normalized to patient body weight.",
    beam: "Minimum threshold 2–4 ×10⁶/kg. Directly seeds the PhysiCell simulation — the count of CD34+ agents inserted into the marrow grid on Day 0. Yields below 2.0 ×10⁶/kg are borderline and significantly raise P(engraftment failure).",
    equation: "\\text{CD34+}_{Agents} = CD34\\text{ Yield} \\cdot Weight \\cdot 10^4"
  },
  {
    id: "hct_ci",
    name: "HCT-CI Score",
    stage: 0,
    type: "Ordinal (0–10+)",
    classification: "imp",
    source: "Composite Clinical Assessment",
    desc: "Hematopoietic Cell Transplantation Comorbidity Index. A weighted sum scoring 17 comorbidities (arrhythmia, liver disease, renal disease, pulmonary, prior solid tumor, etc.).",
    beam: "Scores ≥ 3 correlate with significantly worse outcomes. Scores of 4+ are associated with primary engraftment failure. HCT-CI is one of the strongest predictors in the XGBoost eligibility head and consistently ranks in the top SHAP features.",
    equation: "HCT\\text{-}CI = \\sum_{i=1}^{17} w_i \\cdot Comorbidity_i"
  },
  {
    id: "deauville",
    name: "Deauville Score (Post-Salvage)",
    stage: 0,
    type: "Ordinal (1–5)",
    classification: "imp",
    source: "PET/CT scan report",
    desc: "Five-point scale measuring metabolic response to salvage chemotherapy on PET/CT. 1–2 = complete metabolic response; 3 = partial; 4–5 = inadequate or disease progression.",
    beam: "Deauville 4–5 post-salvage is an unfavorable prognostic marker — residual FDG-avid disease at transplant predicts higher relapse rates and is used as a disease status feature in the ML model.",
    equation: "\\text{DiseaseStatus}_{Feature} = \\text{High if } Deauville \\ge 4"
  },
  {
    id: "chemo_lines",
    name: "Number of Prior Chemotherapy Lines",
    stage: 0,
    type: "Discrete (integer)",
    classification: "imp",
    source: "EHR medication records",
    desc: "Total count of distinct chemotherapy regimens received before BEAM, including first-line (CHOP, ABVD) and all salvage therapies (ICE, DHAP).",
    beam: "1–2 prior lines = better outcomes. 3+ lines = diminishing benefit and compounding DNA damage — the primary driver of t-MDS/AML risk. Each additional line amplifies the cumulative genomic damage that BEAM's alkylating agents can exploit to induce secondary malignancies.",
    equation: "LateRisk_{Damage} = \\alpha \\cdot (PriorLines)^2"
  },
  {
    id: "tp53_chip",
    name: "TP53 CHIP Status (VAF)",
    stage: 0,
    type: "Continuous VAF (%)",
    classification: "imp",
    source: "NGS panel",
    desc: "Presence and variant allele frequency of TP53 mutations in bone marrow not attributable to the primary lymphoma. CHIP = Clonal Hematopoiesis of Indeterminate Potential.",
    beam: "TP53-mutant CHIP clones have dramatically increased fitness under high-dose alkylator pressure. BEAM acts as selective pressure — killing normal stem cells while allowing TP53-mutant clones to rapidly expand, leading to t-MDS/AML development post-transplant.",
    equation: "CHIP_{FitnessModifier} = 1.0 + 3.5 \\cdot VAF_{TP53}"
  },
  {
    id: "ppm1d_chip",
    name: "PPM1D CHIP Status (VAF)",
    stage: 0,
    type: "Continuous VAF (%)",
    classification: "imp",
    source: "NGS panel",
    desc: "Presence and variant allele frequency of PPM1D truncating mutations in bone marrow. PPM1D encodes a phosphatase that normally suppresses the DNA damage response.",
    beam: "PPM1D mutations confer chemotherapy resistance. Clones survive BEAM conditioning more efficiently than normal progenitors, leading to clonal dominance in the recovering marrow and elevated secondary malignancy risk.",
    equation: "CHIP_{FitnessModifier} = 1.0 + 2.0 \\cdot VAF_{PPM1D}"
  },
  {
    id: "infection_flag",
    name: "Active Infection Flag",
    stage: 0,
    type: "Boolean",
    classification: "key",
    source: "Clinical Assessment at Day −7",
    desc: "Binary flag indicating whether the patient has any active bacterial, fungal, or viral infection at the time of planned BEAM initiation.",
    beam: "Absolute contraindication — if TRUE, BEAM is paused immediately. Administering myeloablative chemotherapy to a patient fighting an active infection can be fatal because the subsequent neutropenic nadir removes all remaining immune capacity.",
    equation: "\\text{Eligibility} = \\text{False if } InfectionFlag == \\text{True}"
  },
  {
    id: "salvage_timing",
    name: "Days Since Last Salvage Chemotherapy",
    stage: 0,
    type: "Continuous (days)",
    classification: "key",
    source: "EHR medication records",
    desc: "Number of days elapsed between the final dose of the most recent salvage regimen and the planned start of BEAM conditioning (Day −6).",
    beam: "Minimum ~21–28 day recovery window required. If BEAM overlaps with residual toxicity from prior salvage — particularly mucositis — the combined GI damage becomes unmanageable. Can trigger a HOLD decision even in an otherwise eligible patient.",
    equation: "\\text{Eligibility} = \\text{Hold if } Timing < 21\\text{ days}"
  },

  // ── STAGE 2: PHYSIPKPD OUTPUTS (9 variables) ──
  {
    id: "bcnu_pk",
    name: "BCNU Plasma Concentration Curve",
    stage: 1,
    type: "Time-series (mg/L)",
    classification: "key",
    source: "Simulated (2-compartment ODE)",
    desc: "Drug concentration in plasma modeled across the Day −6 infusion window. BCNU has a rapid distribution phase followed by a slower elimination phase, solved from BSA-adjusted dose.",
    beam: "The Area Under the Curve (AUC) of this curve drives bone marrow ablation depth and pulmonary toxicity. BCNU also crosses the blood-brain barrier — the CNS penetration concentration at peak is a key input to the cognitive damage model.",
    equation: "\\frac{dC_p}{dt} = -k_{12} C_p + k_{21} C_t - k_{el} C_p"
  },
  {
    id: "bcnu_lung_index",
    name: "BCNU Lung Damage Index",
    stage: 1,
    type: "Continuous [0–1]",
    classification: "crit",
    source: "Derived variable",
    desc: "A normalized damage score combining Carmustine exposure intensity (AUC) with the patient's pre-existing pulmonary reserve (baseline DLCO).",
    beam: "BCNU-driven lung toxicity is the most common long-term late effect — presenting as progressive exertional dyspnea months to years post-transplant. This index seeds the pulmonary track in the 15-year simulator and triggers specialist referral flags.",
    equation: "Damage_{Lung} = \\frac{AUC_{BCNU}}{DLCO_{baseline}} \\cdot k_{lung}"
  },
  {
    id: "etoposide_top2",
    name: "Etoposide TopII Inhibition Score",
    stage: 1,
    type: "Continuous",
    classification: "key",
    source: "Derived variable",
    desc: "Cumulative integral of Etoposide plasma concentration over its administration window (Days −6 to −3). Represents the total Topoisomerase II inhibition burden accumulated in bone marrow cells.",
    beam: "Primary driver of therapy-related AML (t-AML) with 11q23 chromosomal rearrangements. Etoposide-driven t-AML can present abruptly within 1–3 years post-transplant, much earlier than alkylator-driven MDS.",
    equation: "Score_{TopII} = \\int_{t_0}^{t_f} C_{etop}(t) \\cdot k_{inhib} \\, dt"
  },
  {
    id: "arac_bbb",
    name: "Ara-C BBB Penetration Signal",
    stage: 1,
    type: "Continuous",
    classification: "key",
    source: "Derived variable",
    desc: "Estimated concentration of Cytarabine in the CNS compartment, derived from the 2-compartment PK model's tissue distribution parameters. Ara-C crosses the blood-brain barrier significantly at high doses.",
    beam: "Both Ara-C and BCNU penetrate the BBB and trigger microglial activation. This signal seeds the cognitive impairment ('chemo brain') trajectory in the 15-year model.",
    equation: "Signal_{CNS} = \\max(C_{brain}(t))"
  },
  {
    id: "melphalan_renal",
    name: "Melphalan Renal Stress Score",
    stage: 1,
    type: "Continuous",
    classification: "crit",
    source: "Derived variable",
    desc: "A patient-specific stress metric normalizing Melphalan exposure by the kidney's filtration capacity (baseline CrCl). Higher scores indicate the kidney is under proportionally greater strain.",
    beam: "The single strongest predictor of long-term GFR decline. Melphalan causes tubular injury; renal tubular epithelial cells undergo necrosis and scar rather than heal, progressively declining GFR over the decade post-transplant.",
    equation: "Stress_{Renal} = \\frac{\\text{Dose}_{Melp}}{CrCl_{baseline}} \\cdot k_{stress}"
  },
  {
    id: "melphalan_clearance",
    name: "Melphalan 24-Hour Clearance Flag",
    stage: 1,
    type: "Boolean",
    classification: "crit",
    source: "Derived variable",
    desc: "Binary flag indicating whether Melphalan has fallen below a safe threshold (e.g. < 0.05 mg/L) at 24 hours after the Day −1 infusion. If FALSE, the Day 0 stem cell infusion must be delayed.",
    beam: "Hard clinical safety constraint. Residual Melphalan at Day 0 will directly kill infused CD34+ stem cells before they can engraft. The PhysiCell simulation uses this flag to determine CD34+ survival in the first 24 hours.",
    equation: "\\text{ClearancePassed} = C_{melp}(24h) < 0.05 \\text{ mg/L}"
  },
  {
    id: "conditioning_anc_nadir",
    name: "Conditioning ANC Nadir (Predicted)",
    stage: 1,
    type: "Continuous (cells/μL)",
    classification: "crit",
    source: "Simulated (PhysiPKPD myelosuppression)",
    desc: "Predicted lowest absolute neutrophil count during the conditioning and early engraftment window (Days +7 to +14), derived from the combined myelosuppressive effect of all four BEAM drugs.",
    beam: "ANC below 500 cells/μL defines the neutropenic nadir — maximum infection vulnerability. ~76% of BEAM patients develop febrile neutropenia during this window. Predicted nadir depth and duration determine the prophylactic protocol.",
    equation: "Nadir_{ANC} = f(AUC_{BCNU}, AUC_{Etop}, AUC_{AraC}, AUC_{Melp})"
  },
  {
    id: "organ_damage_index",
    name: "Organ Damage Index ×6",
    stage: 1,
    type: "Continuous [0–1] each",
    classification: "imp",
    source: "Derived from all 4 drug damage signals",
    desc: "Six normalized scores — one per organ (Lung, Renal, Cardiac, CNS, Gonadal, Hepatic). Each integrates the relevant drug exposure signal with that organ's baseline reserve.",
    beam: "Primary inputs to XGBoost Head 2 (organ toxicity classification) and the organ risk heatmap. They also seed each respective late-effects trajectory in the 15-year Cox model (renal index → GFR decline; lung index → DLCO decline).",
    equation: "Damage_{Organ} = \\Phi(\\text{exposure}, \\text{reserve})"
  },
  {
    id: "platelet_nadir_pred",
    name: "Platelet Nadir (Predicted)",
    stage: 1,
    type: "Continuous (k/μL)",
    classification: "imp",
    source: "Simulated (PhysiPKPD myelosuppression)",
    desc: "Predicted minimum platelet count during Days +7 to +20, derived from the aggregated myelosuppressive signal of all four drugs on megakaryocyte progenitors.",
    beam: "Platelets below 10k/μL trigger prophylactic transfusion. Prolonged transfusion dependence beyond Day +100 is a clinical indicator of poor engraftment and potentially evolving MDS.",
    equation: "Nadir_{Plt} = g(AUC_{BEAM})"
  },

  // ── STAGE 3: PHYSICELL OUTPUTS (7 variables) ──
  {
    id: "p_engraft",
    name: "P(Engraftment Success)",
    stage: 2,
    type: "Continuous [0–1]",
    classification: "crit",
    source: "Simulated (PhysiCell niche occupancy)",
    desc: "Fraction of Monte Carlo simulation runs in which infused CD34+ stem cell agents successfully occupy a sufficient proportion of vascular niches by Day +21.",
    beam: "The single most important PhysiCell output and primary feature in XGBoost Head 1. P(engraftment) below 0.20 triggers an automatic engraftment failure flag. CD34+ yield from Stage 1 is the strongest input.",
    equation: "P(Engraft) = \\frac{\\text{Runs with Occupancy } \\ge 60\\%}{\\text{Total Runs}}"
  },
  {
    id: "cbc_trajectory",
    name: "Simulated CBC Trajectory (Days 0→+30)",
    stage: 2,
    type: "Multi-series time-series",
    classification: "key",
    source: "Simulated (PhysiCell agent populations)",
    desc: "Daily counts of ANC, WBC, platelets, and hemoglobin from Day 0 through Day +30, derived from agent population dynamics in the spatial marrow grid.",
    beam: "This time-series is the primary data object from which Stage 4 extracts all ML features (nadir value, timing, recovery slope, neutropenic window duration). It also populates the 'Predicted CBC' chart in the Stage 5 dashboard.",
    equation: "CBC(t) = \\mathbf{M} \\cdot \\mathbf{X}(t) \\text{ (where } \\mathbf{X} \\text{ is the cell agent vector)}"
  },
  {
    id: "days_to_neutrophil",
    name: "Days to Neutrophil Engraftment",
    stage: 2,
    type: "Discrete (days post-ASCT)",
    classification: "crit",
    source: "Simulated",
    desc: "Predicted day post-transplant on which simulated ANC exceeds 500 cells/μL and maintains that level for three consecutive days — the standard clinical definition of neutrophil engraftment.",
    beam: "Typical range is Days +11 to +14. Delayed engraftment (Day +21+) correlates with higher infection mortality and prolonged hospitalization. Failure to engraft by Day +28 is potentially fatal.",
    equation: "Engraft_{day} = \\min \\{ t \\mid ANC(t) \\ge 500 \\text{ for } t, t+1, t+2 \\}"
  },
  {
    id: "chip_expansion",
    name: "CHIP Clone Expansion Rate",
    stage: 2,
    type: "Continuous (% clone population / month)",
    classification: "key",
    source: "Simulated (PhysiCell agent dynamics)",
    desc: "Rate of growth of CHIP-mutant (TP53, PPM1D) stem cell agents relative to total marrow stem cell population per simulated month.",
    beam: "The expansion rate directly seeds the 5-year t-MDS/AML hazard curve in the Cox PH model. High expansion rates correspond to patients on the accelerated t-MDS trajectory — 2–5 year latency.",
    equation: "r_{CHIP} = \\frac{1}{N_{total}} \\frac{d N_{CHIP}}{dt}"
  },
  {
    id: "chip_ratio",
    name: "Normal : CHIP Clone Ratio at Day +30",
    stage: 2,
    type: "Continuous [0–1]",
    classification: "imp",
    source: "Simulated",
    desc: "Proportion of bone marrow stem cell agents classified as normal (non-CHIP) versus CHIP-mutant at Day +30 in the PhysiCell simulation.",
    beam: "A ratio below 0.8 (CHIP clones comprising more than 20% of the recovering marrow) is an early warning marker for secondary malignancy, especially relevant for patients with pre-existing CHIP.",
    equation: "Ratio = \\frac{N_{normal}(30)}{N_{normal}(30) + N_{CHIP}(30)}"
  },
  {
    id: "niche_occupancy",
    name: "Vascular Niche Occupancy %",
    stage: 2,
    type: "Continuous (%)",
    classification: "imp",
    source: "Simulated niche occupancy at Day +21",
    desc: "Percentage of bone marrow vascular niches (grid positions adjacent to simulated blood vessels) occupied by successfully-engrafted CD34+ agents at Day +21.",
    beam: "Low occupancy (<60%) indicates incomplete engraftment and predicts prolonged thrombocytopenia. Areas of Carmustine-induced fibrosis act as physical barriers in the simulation, strangling accessible space.",
    equation: "Occupancy = \\frac{\\text{Occupied Niches}}{\\text{Total Vascular Niches}} \\cdot 100"
  },
  {
    id: "engraft_fail_flag",
    name: "Engraftment Failure Flag",
    stage: 2,
    type: "Boolean",
    classification: "imp",
    source: "Derived variable",
    desc: "Binary flag set to TRUE when simulated engraftment probability falls below 0.20 or the CBC trajectory fails to show sustained ANC ≥ 500/μL by Day +28.",
    beam: "Primary engraftment failure risk is elevated with high HCT-CI scores and borderline CD34+ yields. A TRUE flag forces the pipeline to output an EXCLUDE decision with a mandatory MDT review recommendation.",
    equation: "FailureFlag = (P(Engraft) < 0.20) \\lor (ANC(28) < 500)"
  },

  // ── STAGE 4: ML FEATURES & HEADS (8 variables) ──
  {
    id: "anc_nadir_feat",
    name: "ANC Nadir Value",
    stage: 3,
    type: "Continuous (cells/μL)",
    classification: "key",
    source: "Extracted feature",
    desc: "The single lowest ANC value across the full simulated CBC trajectory from Day 0 through Day +30, extracted as a scalar feature for tabular ML.",
    beam: "Consistently one of the top SHAP features for the eligibility head. ANC below 100 cells/μL for more than 10 days predicts life-threatening infection risk.",
    equation: "ANC_{Nadir} = \\min_{t \\in [0,30]} ANC(t)"
  },
  {
    id: "neutropenic_duration",
    name: "Neutropenic Window Duration",
    stage: 3,
    type: "Discrete (days)",
    classification: "key",
    source: "Extracted feature",
    desc: "Count of consecutive days in the simulation where ANC remains below the neutropenic threshold of 500 cells/μL.",
    beam: "Duration of neutropenia is a stronger predictor of febrile neutropenia episodes than nadir depth alone. Standard BEAM produces an 8–14 day window; windows extending beyond 21 days indicate poor recovery.",
    equation: "Duration = \\sum_{t=0}^{30} \\mathbb{I}(ANC(t) < 500)"
  },
  {
    id: "anc_recovery_slope",
    name: "ANC Recovery Slope",
    stage: 3,
    type: "Continuous (Δ cells/μL per day)",
    classification: "key",
    source: "Extracted feature",
    desc: "Rate of ANC increase from the nadir point through Day +21, estimated as the slope of a linear regression fitted to the recovery portion of the trajectory.",
    beam: "Reflects the regeneration kinetics of the engrafted CD34+ stem cells. Slopes < 50 cells/μL/day suggest niche competition from CHIP clones or bone marrow stroma microenvironment damage.",
    equation: "Slope = \\text{Slope}(\\{t, ANC(t)\\} \\text{ from Nadir to } D21)"
  },
  {
    id: "plt_nadir_feat",
    name: "Platelet Nadir Value",
    stage: 3,
    type: "Continuous (k/μL)",
    classification: "key",
    source: "Extracted feature",
    desc: "The single lowest platelet value across the full simulated CBC trajectory from Day 0 through Day +30.",
    beam: "Used in the ML toxicity head. Platelets below 10k/μL require active transfusion. Prolonged thrombocytopenia (nadir extending past Day +20) increases severe bleeding hazard.",
    equation: "Plt_{Nadir} = \\min_{t \\in [0,30]} Platelet(t)"
  },
  {
    id: "plt_recovery_slope",
    name: "Platelet Recovery Slope",
    stage: 3,
    type: "Continuous (Δ k/μL per day)",
    classification: "key",
    source: "Extracted feature",
    desc: "Rate of platelet increase from the nadir point through Day +28, estimated as the slope of a linear regression fitted to the recovery portion.",
    beam: "Megakaryopoiesis takes longer to recover than granulopoiesis. A flat platelet recovery slope indicates impaired megakaryocyte differentiation and predicts long-term transfusion support requirements.",
    equation: "Slope_{Plt} = \\text{Slope}(\\{t, Plt(t)\\} \\text{ from Nadir to } D28)"
  },
  {
    id: "organ_damage_composite",
    name: "Organ Damage Composite Score",
    stage: 3,
    type: "Continuous [0-1]",
    classification: "imp",
    source: "Derived variable",
    desc: "A weighted average of the six individual organ damage indices, reflecting overall treatment-related toxicity burden.",
    beam: "High composite scores are associated with multi-organ dysfunction syndrome. Used as a key feature in the 15-year survival Cox PH model and the multi-label organ toxicity head.",
    equation: "Composite = \\sum_{i=1}^{6} w_i \\cdot Damage_{Organ, i}"
  },
  {
    id: "xgboost_prob",
    name: "XGBoost Eligibility Probability P̂",
    stage: 3,
    type: "Continuous [0-1]",
    classification: "crit",
    source: "ML Classifier (XGBoost Head 1)",
    desc: "The output probability from the XGBoost binary classification model, representing the likelihood of the patient successfully undergoing BEAM without toxic death.",
    beam: "Clinically actioned via strict decision boundaries: P̂ ≥ 0.70 prompts a GO decision; 0.50 ≤ P̂ < 0.70 prompts a HOLD (Mini-BEAM or repeat screening); P̂ < 0.50 triggers EXCLUDE.",
    equation: "P(Eligibility) = \\sigma\\left( \\sum_{tree} f_k(X) \\right)"
  },
  {
    id: "shap_contributions",
    name: "SHAP Feature Contributions",
    stage: 3,
    type: "Vector (float values)",
    classification: "key",
    source: "ML Explainability (SHAP)",
    desc: "Additive feature attribution values explaining the deviation of the patient's predicted eligibility probability from the base population expectation.",
    beam: "Enables clinical auditability. The waterfall visualization translates black-box model predictions into ranked positive and negative clinical drivers for each individual patient.",
    equation: "f(x) = \\phi_0 + \\sum_{i=1}^{M} \\phi_i"
  },

  // ── STAGE 5: CLINICAL OUTPUTS (6 variables) ──
  {
    id: "clinical_decision",
    name: "Clinical Decision (Verdict)",
    stage: 4,
    type: "Categorical (GO / HOLD / EXCLUDE)",
    classification: "crit",
    source: "Clinical Output layer",
    desc: "The final eligibility recommendation output by the pipeline, combining ML classification with hard-coded safety constraints.",
    beam: "Directly directs clinical actions. EXCLUDE recommendations require a Multi-Disciplinary Team (MDT) review to pivot to alternate conditioning regimens (e.g. GemOx or bendamustine).",
    equation: "\\text{Verdict} = \\text{Rules}(P(\\text{Eligibility}), \\text{ExclusionFlags})"
  },
  {
    id: "predicted_cbc_chart",
    name: "Predicted CBC Dashboard View",
    stage: 4,
    type: "Interface / Visualization",
    classification: "key",
    source: "Clinical Output dashboard",
    desc: "Interactive visual presentation of the simulated daily blood count curves showing neutropenia depth and recovery timing.",
    beam: "Allows clinicians to visually plan the patient's hospitalization duration, timing of prophylactic G-CSF initiation, and expected window of maximum infection risk.",
    equation: "\\text{Render}(\\{t, ANC(t), Platelet(t)\\}_{t=0}^{30})"
  },
  {
    id: "organ_risk_heatmap",
    name: "Organ Risk Heatmap View",
    stage: 4,
    type: "Interface / Visualization",
    classification: "crit",
    source: "Clinical Output dashboard",
    desc: "Traffic-light grid (Green/Yellow/Red) mapping predicted toxicity risk for the 6 critical organ groups (Lung, Renal, Cardiac, CNS, Gonadal, Hepatic).",
    beam: "Directs pre-transplant clinical interventions. An amber or red organ block flags the need for specialist consultations (e.g. Nephrology for renal risk, Pulmonology for lung risk) prior to dosing.",
    equation: "\\text{Color}_{Organ} = \\text{Thresholds}(Damage_{Organ})"
  },
  {
    id: "shap_waterfall_view",
    name: "SHAP Top Drivers View",
    stage: 4,
    type: "Interface / Visualization",
    classification: "key",
    source: "Clinical Output dashboard",
    desc: "Visual waterfall chart showing the top contributing patient factors driving the eligibility decision.",
    beam: "Provides clinicians with human-interpretable reasons behind the eligibility decision, fulfilling regulatory explainability requirements in healthcare.",
    equation: "\\text{Render}(\\{\\phi_i, Feature_i\\})"
  },
  {
    id: "late_effects_hazard",
    name: "15-Year Late Effects Hazard Projections",
    stage: 4,
    type: "Survival curves",
    classification: "imp",
    source: "Cox PH Survival Model",
    desc: "Long-term projections showing cumulative hazard of t-MDS/AML and estimated GFR decline over 15 years post-ASCT.",
    beam: "Conditions clinical surveillance plans. High t-MDS hazard shifts post-transplant follow-up to include annual bone marrow biopsies and NGS screening, rather than simple peripheral blood counts.",
    equation: "H(t \\mid X) = H_0(t) \\exp(\\beta^T X)"
  },
  {
    id: "surveillance_schedule",
    name: "Surveillance Schedule Protocol",
    stage: 4,
    type: "Text protocol / schedule",
    classification: "key",
    source: "Clinical Guidelines generator",
    desc: "A personalized, schedule-based checklist of tests and clinical reviews recommended for the patient over their 15-year survival track.",
    beam: "Prevents late-effect mortality by standardizing screening. Triggers include pulmonary function tests at months +3, +6, and +12 for pulmonary risk, and annual clearance scans for GFR decline.",
    equation: "\\text{Schedule} = \\text{Rules}(\\mathbf{DamageVector}, \\text{CHIPStatus})"
  }
];

// Stage Names & Descs
const stageMetadata = [
  {
    name: "Stage 1: Patient Input Layer",
    desc: "Raw variables collected from the patient's EHR, lab tests, and NGS panel before any simulation begins. They feed the drug dosing calculations in PhysiPKPD and set the biological baseline for the PhysiCell environment. <strong>Red-bordered cards are hard exclusion criteria</strong> — a single out-of-range value disqualifies the patient regardless of ML score."
  },
  {
    name: "Stage 2: PhysiPKPD Drug Simulation",
    desc: "Computed outputs of the four PhysiPKPD pharmacokinetic compartment models. Each drug's plasma concentration curve is solved as an ODE system, then an effect-site compartment model translates drug exposure into a tissue damage signal. Organ damage is a function of both <strong>drug exposure intensity (AUC)</strong> and the patient's <strong>baseline organ reserve from Stage 1</strong>."
  },
  {
    name: "Stage 3: PhysiCell Bone Marrow",
    desc: "PhysiCell uses the damage signals from Stage 2 as environmental rules governing cell survival in a 3D bone marrow grid. The key output is a <strong>simulated CBC time-series</strong> from Day 0 through Day +30 — the raw material for ML feature extraction in Stage 4. This is where physics-based simulation produces patient-specific predictions rather than population averages."
  },
  {
    name: "Stage 4: ML Classification Layer",
    desc: "Stage 4 has two phases: (1) <strong>feature extraction</strong> — translating time-series outputs from Stages 2 and 3 into a fixed-length vector for tabular ML, and (2) <strong>classification</strong> — running XGBoost with two separate prediction heads (eligibility and organ toxicity). SHAP values are computed for every prediction to satisfy clinical interpretability requirements."
  },
  {
    name: "Stage 5: Clinical Output",
    desc: "The clinician-facing dashboard containing the actionable pipeline decisions, explanations, and risk projections. Combines the machine learning predictions with clinical safety rules to generate direct <strong>GO / HOLD / EXCLUDE</strong> verdicts, dynamic charts, and long-term surveillance protocols."
  }
];

// ==========================================================================
// 2. Global UI State & Initialization
// ==========================================================================

const state = {
  activeTab: "arch-dictionary", // "arch-dictionary" | "sandbox" | "dense-grid"
  dictStage: "all",            // "all" | 0 | 1 | 2 | 3 | 4
  dictFilter: "all",           // "all" | "crit" | "imp" | "key" | "neutral"
  dictSearchQuery: "",
  dictView: "cards",           // "cards" | "table"
  matrixSortKey: "name",
  matrixSortAsc: true,
  theme: "dark"
};

// DOM Elements
const elements = {};

function initDOMRefs() {
  elements.themeToggle = document.getElementById("theme-toggle");
  elements.navTabs = document.querySelectorAll(".nav-tab");
  elements.panels = document.querySelectorAll(".tab-panel");
  
  // Tab 1 Elements
  elements.svgStages = document.querySelectorAll(".svg-stage");
  elements.svgFlow = document.getElementById("interactive-flow-svg");
  elements.svgDecisionText = document.getElementById("svg-decision-text");
  elements.dictSearch = document.getElementById("dict-search");
  elements.clearSearch = document.getElementById("clear-search");
  elements.stageTabs = document.querySelectorAll(".stage-tab");
  elements.tagFilters = document.querySelectorAll(".tag-filter");
  elements.filteredCount = document.getElementById("filtered-count");
  elements.btnViewCards = document.getElementById("btn-view-cards");
  elements.btnViewTable = document.getElementById("btn-view-table");
  elements.dictCardsGrid = document.getElementById("dict-cards-grid");
  elements.dictTableContainer = document.getElementById("dict-table-container");
  elements.dictTableBody = document.getElementById("dict-table-body");
  elements.dictStageIntro = document.getElementById("dict-stage-intro");
  
  // Tab 3 Elements
  elements.compactTableBody = document.getElementById("compact-table-body");
  elements.compactSearch = document.getElementById("compact-search");
  elements.compactStageFilter = document.getElementById("compact-stage-filter");
  elements.compactTypeFilter = document.getElementById("compact-type-filter");
  elements.matrixHeaders = document.querySelectorAll("#matrix-table th.sortable");
  elements.btnExportCSV = document.getElementById("btn-export-csv");
  
  // Modal Elements
  elements.detailModal = document.getElementById("detail-modal");
  elements.modalCloseBtn = document.getElementById("btn-close-modal");
  elements.modalCloseAction = document.getElementById("btn-modal-close-action");
  elements.mVarName = document.getElementById("m-var-name");
  elements.mStage = document.getElementById("m-stage");
  elements.mTypeRange = document.getElementById("m-type-range");
  elements.mSource = document.getElementById("m-source");
  elements.mClassificationBadge = document.getElementById("m-classification-badge");
  elements.mDesc = document.getElementById("m-desc");
  elements.mBeamRelevance = document.getElementById("m-beam-relevance");
  elements.mEquationWrap = document.getElementById("m-equation-wrap");
  elements.mEquation = document.getElementById("m-equation");
}

document.addEventListener("DOMContentLoaded", () => {
  initDOMRefs();
  setupGlobalEvents();
  setupDictionaryEvents();
  setupMatrixEvents();
  
  // Initial database renders
  renderDictionary();
  renderMatrixTable();
  
  // Auto-detect system light/dark theme preference
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    toggleTheme("light");
  }
});

// ==========================================================================
// 3. Theme & Main Tab Switching Controller
// ==========================================================================

function setupGlobalEvents() {
  // Theme toggle
  elements.themeToggle.addEventListener("click", () => {
    const nextTheme = state.theme === "dark" ? "light" : "dark";
    toggleTheme(nextTheme);
  });

  // Main Tabs click handler
  elements.navTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const targetTab = tab.getAttribute("data-tab");
      switchMainTab(targetTab);
    });
  });

  // Footer link shortcuts
  document.getElementById("link-goto-dict").addEventListener("click", (e) => {
    e.preventDefault();
    switchMainTab("arch-dictionary");
    elements.dictSearch.scrollIntoView({ behavior: "smooth" });
  });

  document.getElementById("link-goto-sandbox").addEventListener("click", (e) => {
    e.preventDefault();
    switchMainTab("sandbox");
  });
}

function toggleTheme(theme) {
  state.theme = theme;
  document.body.setAttribute("data-theme", theme);
  if (theme === "light") {
    elements.themeToggle.innerHTML = "🌙";
  } else {
    elements.themeToggle.innerHTML = "☀️";
  }
}

function switchMainTab(tabId) {
  state.activeTab = tabId;
  
  // Update nav tabs
  elements.navTabs.forEach(btn => {
    if (btn.getAttribute("data-tab") === tabId) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Show panel
  elements.panels.forEach(panel => {
    if (panel.id === `tab-${tabId}`) {
      panel.classList.add("active");
    } else {
      panel.classList.remove("active");
    }
  });

  if (tabId === "protocol") renderProtocolTimeline();
}

// ==========================================================================
// 4. Data Dictionary Engine (Tab 1 Logic)
// ==========================================================================

function setupDictionaryEvents() {
  // Interactive SVG stage clicks
  elements.svgStages.forEach(stageNode => {
    stageNode.addEventListener("click", () => {
      const stageIdx = stageNode.getAttribute("data-stage");
      selectStageFilter(stageIdx);
      elements.dictStageIntro.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });

  // Stage tab filters
  elements.stageTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const stage = tab.getAttribute("data-stage");
      selectStageFilter(stage);
    });
  });

  // Tag filter chips
  elements.tagFilters.forEach(filter => {
    filter.addEventListener("click", () => {
      elements.tagFilters.forEach(b => b.classList.remove("active"));
      filter.classList.add("active");
      state.dictFilter = filter.getAttribute("data-filter");
      renderDictionary();
    });
  });

  // Search input
  elements.dictSearch.addEventListener("input", (e) => {
    state.dictSearchQuery = e.target.value.toLowerCase().trim();
    if (state.dictSearchQuery) {
      elements.clearSearch.style.display = "block";
    } else {
      elements.clearSearch.style.display = "none";
    }
    renderDictionary();
  });

  // Clear search button
  elements.clearSearch.addEventListener("click", () => {
    elements.dictSearch.value = "";
    state.dictSearchQuery = "";
    elements.clearSearch.style.display = "none";
    renderDictionary();
  });

  // View toggle buttons
  elements.btnViewCards.addEventListener("click", () => {
    state.dictView = "cards";
    elements.btnViewCards.classList.add("active");
    elements.btnViewTable.classList.remove("active");
    elements.dictCardsGrid.style.display = "grid";
    elements.dictTableContainer.style.display = "none";
    renderDictionary();
  });

  elements.btnViewTable.addEventListener("click", () => {
    state.dictView = "table";
    elements.btnViewTable.classList.add("active");
    elements.btnViewCards.classList.remove("active");
    elements.dictCardsGrid.style.display = "none";
    elements.dictTableContainer.style.display = "block";
    renderDictionary();
  });

  // Modal events
  const closeModal = () => elements.detailModal.classList.remove("open");
  elements.modalCloseBtn.addEventListener("click", closeModal);
  elements.modalCloseAction.addEventListener("click", closeModal);
  elements.detailModal.addEventListener("click", (e) => {
    if (e.target === elements.detailModal) closeModal();
  });
}

function selectStageFilter(stageVal) {
  // Update state
  state.dictStage = stageVal;
  
  // Highlight stage tabs in UI
  elements.stageTabs.forEach(t => {
    if (t.getAttribute("data-stage") === stageVal.toString()) {
      t.classList.add("active");
    } else {
      t.classList.remove("active");
    }
  });

  // Highlight interactive SVG nodes
  if (stageVal === "all") {
    elements.svgFlow.classList.remove("stage-focus-active");
    elements.svgStages.forEach(s => s.classList.remove("stage-active"));
  } else {
    elements.svgFlow.classList.add("stage-focus-active");
    elements.svgStages.forEach(s => {
      if (s.getAttribute("data-stage") === stageVal.toString()) {
        s.classList.add("stage-active");
      } else {
        s.classList.remove("stage-active");
      }
    });
  }

  // Render dictionary items
  renderDictionary();
}

function renderDictionary() {
  // Filter variables
  const filtered = variablesDb.filter(v => {
    // Stage Filter
    if (state.dictStage !== "all" && v.stage.toString() !== state.dictStage.toString()) {
      return false;
    }
    // Classification Tag Filter
    if (state.dictFilter !== "all" && v.classification !== state.dictFilter) {
      return false;
    }
    // Search Query
    if (state.dictSearchQuery) {
      const matchText = `${v.name} ${v.source} ${v.desc} ${v.beam}`.toLowerCase();
      if (!matchText.includes(state.dictSearchQuery)) {
        return false;
      }
    }
    return true;
  });

  // Update counts
  elements.filteredCount.textContent = filtered.length;

  // Render Stage Banner Description
  if (state.dictStage === "all") {
    elements.dictStageIntro.style.display = "none";
  } else {
    const meta = stageMetadata[parseInt(state.dictStage)];
    elements.dictStageIntro.style.display = "block";
    elements.dictStageIntro.innerHTML = `<strong>${meta.name}</strong> — ${meta.desc}`;
    // Change left accent border color based on stage
    elements.dictStageIntro.style.borderLeftColor = `var(--stage-${state.dictStage}-color)`;
  }

  // Render views
  if (state.dictView === "cards") {
    renderCards(filtered);
  } else {
    renderTableRows(filtered);
  }
}

function renderCards(list) {
  elements.dictCardsGrid.innerHTML = "";
  
  if (list.length === 0) {
    elements.dictCardsGrid.innerHTML = `<div class="no-results-placeholder">No variables match the selected filters.</div>`;
    return;
  }

  list.forEach(v => {
    const card = document.createElement("div");
    card.className = `vc ${v.classification}`;
    card.setAttribute("data-id", v.id);
    
    // Set classification display label
    let badgeHtml = "";
    if (v.classification === "crit") badgeHtml = `<span class="badge br">Critical Constraint</span>`;
    else if (v.classification === "imp") badgeHtml = `<span class="badge bo">Risk Amplifier</span>`;
    else if (v.classification === "key") badgeHtml = `<span class="badge bc">Key Feature</span>`;
    else badgeHtml = `<span class="badge bk">Standard Variable</span>`;

    card.innerHTML = `
      <div class="vname">${v.name}</div>
      <div class="vmeta">
        ${badgeHtml}
        <span class="badge bp">Stage ${v.stage + 1}</span>
        <span class="src">${v.source}</span>
      </div>
      <div class="vdesc">${v.desc}</div>
      <div class="vwhy">
        <span class="wl">BEAM Relevance:</span>${v.beam.substring(0, 100)}...
      </div>
    `;

    card.addEventListener("click", () => openVariableModal(v));
    elements.dictCardsGrid.appendChild(card);
  });
}

function renderTableRows(list) {
  elements.dictTableBody.innerHTML = "";
  
  if (list.length === 0) {
    elements.dictTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 24px;">No variables match the selected filters.</td></tr>`;
    return;
  }

  list.forEach(v => {
    const row = document.createElement("tr");
    row.setAttribute("data-id", v.id);
    
    let badgeHtml = "";
    if (v.classification === "crit") badgeHtml = `<span class="badge br">Critical</span>`;
    else if (v.classification === "imp") badgeHtml = `<span class="badge bo">Risk Amp</span>`;
    else if (v.classification === "key") badgeHtml = `<span class="badge bc">Key</span>`;
    else badgeHtml = `<span class="badge bk">Standard</span>`;

    row.innerHTML = `
      <td class="table-var-name">${v.name}</td>
      <td><span class="badge bp">Stage ${v.stage + 1}</span></td>
      <td><div style="display:flex; flex-direction:column; gap:4px;">${badgeHtml}<small>${v.type}</small></div></td>
      <td><span style="font-size:11px;">${v.source}</span></td>
      <td><div style="max-height: 50px; overflow: hidden; text-overflow: ellipsis; font-size:11.5px;">${v.desc}</div></td>
    `;

    row.addEventListener("click", () => openVariableModal(v));
    elements.dictTableBody.appendChild(row);
  });
}

// Open detail Modal popup
function openVariableModal(variable) {
  elements.mVarName.textContent = variable.name;
  elements.mStage.textContent = `Stage ${variable.stage + 1} · ${stageMetadata[variable.stage].name.split(":")[1].trim()}`;
  elements.mTypeRange.textContent = variable.type;
  elements.mSource.textContent = variable.source;
  
  // Set classification badge
  const badge = elements.mClassificationBadge;
  badge.className = "badge";
  if (variable.classification === "crit") {
    badge.textContent = "Critical Constraint";
    badge.classList.add("br");
  } else if (variable.classification === "imp") {
    badge.textContent = "Risk Amplifier";
    badge.classList.add("bo");
  } else if (variable.classification === "key") {
    badge.textContent = "Key Model Feature";
    badge.classList.add("bc");
  } else {
    badge.textContent = "Standard Variable";
    badge.classList.add("bk");
  }

  elements.mDesc.textContent = variable.desc;
  elements.mBeamRelevance.textContent = variable.beam;
  
  // Math Equation rendering
  if (variable.equation) {
    elements.mEquationWrap.style.display = "block";
    elements.mEquation.textContent = variable.equation;
  } else {
    elements.mEquationWrap.style.display = "none";
  }

  elements.detailModal.classList.add("open");
}

// ==========================================================================
// 5. Compact Variable Matrix Engine (Tab 3 Logic)
// ==========================================================================

function setupMatrixEvents() {
  // Input changes
  elements.compactSearch.addEventListener("input", renderMatrixTable);
  elements.compactStageFilter.addEventListener("change", renderMatrixTable);
  elements.compactTypeFilter.addEventListener("change", renderMatrixTable);

  // Sorting columns
  elements.matrixHeaders.forEach(header => {
    header.addEventListener("click", () => {
      const sortKey = header.getAttribute("data-sort");
      
      if (state.matrixSortKey === sortKey) {
        state.matrixSortAsc = !state.matrixSortAsc;
      } else {
        state.matrixSortKey = sortKey;
        state.matrixSortAsc = true;
      }
      
      // Update header UI indicator icons
      elements.matrixHeaders.forEach(h => {
        const icon = h.querySelector(".sort-icon");
        const key = h.getAttribute("data-sort");
        if (key === state.matrixSortKey) {
          icon.textContent = state.matrixSortAsc ? "▲" : "▼";
          h.className = `sortable ${state.matrixSortAsc ? "asc" : "desc"}`;
        } else {
          icon.textContent = "↕";
          h.className = "sortable";
        }
      });

      renderMatrixTable();
    });
  });

  // Export CSV handler
  elements.btnExportCSV.addEventListener("click", exportDatabaseToCSV);
}

function renderMatrixTable() {
  const query = elements.compactSearch.value.toLowerCase().trim();
  const stageFilter = elements.compactStageFilter.value;
  const typeFilter = elements.compactTypeFilter.value;

  // Filter list
  let filtered = variablesDb.filter(v => {
    if (stageFilter !== "all" && v.stage.toString() !== stageFilter) return false;
    if (typeFilter !== "all" && v.classification !== typeFilter) return false;
    if (query) {
      const matchText = `${v.name} ${v.source} ${v.desc} ${v.beam}`.toLowerCase();
      if (!matchText.includes(query)) return false;
    }
    return true;
  });

  // Sort list
  filtered.sort((a, b) => {
    let fieldA = "";
    let fieldB = "";

    if (state.matrixSortKey === "name") {
      fieldA = a.name.toLowerCase();
      fieldB = b.name.toLowerCase();
    } else if (state.matrixSortKey === "stage") {
      fieldA = a.stage;
      fieldB = b.stage;
    } else if (state.matrixSortKey === "type") {
      fieldA = a.classification.toLowerCase();
      fieldB = b.classification.toLowerCase();
    }

    if (fieldA < fieldB) return state.matrixSortAsc ? -1 : 1;
    if (fieldA > fieldB) return state.matrixSortAsc ? 1 : -1;
    return 0;
  });

  // Render rows
  elements.compactTableBody.innerHTML = "";
  if (filtered.length === 0) {
    elements.compactTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:24px;">No variables found matching criteria.</td></tr>`;
    return;
  }

  filtered.forEach(v => {
    const row = document.createElement("tr");
    row.setAttribute("data-id", v.id);

    let badgeHtml = "";
    if (v.classification === "crit") badgeHtml = `<span class="badge br">Critical Constraint</span>`;
    else if (v.classification === "imp") badgeHtml = `<span class="badge bo">Risk Amplifier</span>`;
    else if (v.classification === "key") badgeHtml = `<span class="badge bc">Key Feature</span>`;
    else badgeHtml = `<span class="badge bk">Standard</span>`;

    row.innerHTML = `
      <td class="table-var-name">${v.name}</td>
      <td><span class="badge bp">Stage ${v.stage + 1}</span></td>
      <td>${badgeHtml}</td>
      <td><small>${v.type}</small></td>
      <td><span style="font-size:11px;">${v.source}</span></td>
      <td><div style="font-size:11.5px; max-height:48px; overflow:hidden; text-overflow:ellipsis;" title="${v.beam}">${v.beam}</div></td>
    `;

    row.addEventListener("click", () => openVariableModal(v));
    elements.compactTableBody.appendChild(row);
  });
}

function exportDatabaseToCSV() {
  const headers = ["Variable Name", "Pipeline Stage", "Classification", "Data Type / Range", "Source System", "Description", "Clinical Relevance (BEAM)"];
  
  const csvRows = [headers.join(",")];
  
  variablesDb.forEach(v => {
    const rowData = [
      v.name,
      `Stage ${v.stage + 1}`,
      v.classification === "crit" ? "Critical Constraint" : v.classification === "imp" ? "Risk Amplifier" : v.classification === "key" ? "Key Feature" : "Standard",
      v.type,
      v.source,
      v.desc,
      v.beam
    ].map(text => {
      // Escape quotes and wrap in quotes for valid CSV formatting
      const escaped = text.replace(/"/g, '""');
      return `"${escaped}"`;
    });
    
    csvRows.push(rowData.join(","));
  });

  const csvContent = "data:text/csv;charset=utf-8," + csvRows.join("\n");
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", "BEAM_Pipeline_3_Data_Dictionary.csv");
  document.body.appendChild(link); // Required for FF
  link.click();
  document.body.removeChild(link);
}

// ==========================================================================
// 6. Patient Simulation Sandbox Engine (Tab 2 Logic)
// ==========================================================================

const sandboxState = {
  age: 55,
  bsa: 1.85,
  lvef: 55,
  dlco: 75,
  crcl: 85,
  ecog: 1,
  hct_ci: 2,
  chemo_lines: 2,
  cd34: 4.2,
  tp53: 0.0,
  ppm1d: 0.0,
  infection: false,
  salvage_days: 30,
  activeOutTab: "out-pk"
};

// Marrow Canvas simulation variables
let marrowSimInterval = null;
let marrowSimRunning = false;
let marrowSimDay = 0;
let marrowNiches = [];
let marrowCells = [];
const MARROW_CANVAS_WIDTH = 400;
const MARROW_CANVAS_HEIGHT = 240;

function setupSandboxEvents() {
  // Inputs listeners
  const bindSlider = (id, stateKey, unit = "") => {
    const slider = document.getElementById(`slider-${id}`);
    const label = document.getElementById(`val-${id}`);
    if (!slider) return;
    slider.addEventListener("input", (e) => {
      let val = e.target.value;
      sandboxState[stateKey] = parseFloat(val);
      
      // Update label
      if (stateKey === "cd34") {
        label.textContent = `${val} ×10⁶/kg`;
      } else if (stateKey === "bsa") {
        label.textContent = `${val} m²`;
      } else {
        label.textContent = `${val}${unit}`;
      }
      
      // Trigger simulation update
      updateSandbox();
    });
  };

  bindSlider("age", "age", " yrs");
  bindSlider("bsa", "bsa");
  bindSlider("lvef", "lvef", "%");
  bindSlider("dlco", "dlco", "%");
  bindSlider("crcl", "crcl", " mL/min");
  bindSlider("ecog", "ecog");
  bindSlider("hct_ci", "hct_ci");
  bindSlider("chemo_lines", "chemo_lines");
  bindSlider("cd34", "cd34");
  bindSlider("tp53", "tp53", "%");
  bindSlider("ppm1d", "ppm1d", "%");
  bindSlider("salvage_days", "salvage_days", " days");

  // Checkbox listener
  const checkInfection = document.getElementById("check-infection");
  if (checkInfection) {
    checkInfection.addEventListener("change", (e) => {
      sandboxState.infection = e.target.checked;
      updateSandbox();
    });
  }

  // Reset button
  const btnReset = document.getElementById("reset-sandbox");
  if (btnReset) {
    btnReset.addEventListener("click", resetSandboxToBaselines);
  }

  // Output Sub-Tabs switching
  const outTabs = document.querySelectorAll(".out-tab");
  const outPanels = document.querySelectorAll(".out-panel");
  outTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      outTabs.forEach(t => t.classList.remove("active"));
      outPanels.forEach(p => p.classList.remove("active"));
      
      tab.classList.add("active");
      const outKey = tab.getAttribute("data-out");
      document.getElementById(outKey).classList.add("active");
      sandboxState.activeOutTab = outKey;
      
      // If marrow tab is selected, trigger canvas reset
      if (outKey === "out-marrow") {
        resetMarrowSimulation();
      }
    });
  });

  // Canvas controls
  const playBtn = document.getElementById("btn-marrow-play");
  const resetBtn = document.getElementById("btn-marrow-reset");
  if (playBtn) {
    playBtn.addEventListener("click", () => {
      if (marrowSimRunning) {
        pauseMarrowSimulation();
      } else {
        startMarrowSimulation();
      }
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener("click", resetMarrowSimulation);
  }

  // Double click variable name labels on controls to view dictionary modals
  document.querySelectorAll(".slider-name").forEach(span => {
    span.addEventListener("click", () => {
      const varId = span.getAttribute("data-var");
      let matchedVar = variablesDb.find(v => v.id === varId);
      // Fallbacks
      if (varId === "cd34") matchedVar = variablesDb.find(v => v.id === "cd34_yield");
      if (varId === "hct_ci") matchedVar = variablesDb.find(v => v.id === "hct_ci");
      if (varId === "chemo_lines") matchedVar = variablesDb.find(v => v.id === "chemo_lines");
      if (varId === "tp53") matchedVar = variablesDb.find(v => v.id === "tp53_chip");
      if (varId === "ppm1d") matchedVar = variablesDb.find(v => v.id === "ppm1d_chip");
      if (varId === "infection") matchedVar = variablesDb.find(v => v.id === "infection_flag");
      if (varId === "salvage_days") matchedVar = variablesDb.find(v => v.id === "salvage_timing");
      
      if (matchedVar) openVariableModal(matchedVar);
    });
  });

  // Initialize
  resetSandboxToBaselines();
}

function resetSandboxToBaselines() {
  sandboxState.age = 55;
  sandboxState.bsa = 1.85;
  sandboxState.lvef = 55;
  sandboxState.dlco = 75;
  sandboxState.crcl = 85;
  sandboxState.ecog = 1;
  sandboxState.hct_ci = 2;
  sandboxState.chemo_lines = 2;
  sandboxState.cd34 = 4.2;
  sandboxState.tp53 = 0.0;
  sandboxState.ppm1d = 0.0;
  sandboxState.infection = false;
  sandboxState.salvage_days = 30;

  // Sync inputs UI
  const setVal = (id, val) => {
    const s = document.getElementById(`slider-${id}`);
    if (s) s.value = val;
    const l = document.getElementById(`val-${id}`);
    if (l) {
      if (id === "cd34") l.textContent = `${val} ×10⁶/kg`;
      else if (id === "bsa") l.textContent = `${val} m²`;
      else if (id === "tp53" || id === "ppm1d") l.textContent = `${val}%`;
      else if (id === "age") l.textContent = `${val} yrs`;
      else if (id === "crcl") l.textContent = `${val} mL/min`;
      else if (id === "salvage_days") l.textContent = `${val} days`;
      else l.textContent = val + (id === "lvef" || id === "dlco" ? "%" : "");
    }
  };

  setVal("age", 55);
  setVal("bsa", 1.85);
  setVal("lvef", 55);
  setVal("dlco", 75);
  setVal("crcl", 85);
  setVal("ecog", 1);
  setVal("hct_ci", 2);
  setVal("chemo_lines", 2);
  setVal("cd34", 4.2);
  setVal("tp53", 0.0);
  setVal("ppm1d", 0.0);
  setVal("salvage_days", 30);
  
  const ch = document.getElementById("check-infection");
  if (ch) ch.checked = false;

  updateSandbox();
}

// Register setup events to load
const originalDOMContentLoaded = document.addEventListener;
document.addEventListener("DOMContentLoaded", () => {
  setupSandboxEvents();
  renderProtocolTimeline();
});

// ==========================================================================
// 7. Math Models & Charts Engine (XGBoost, SHAP, PK ODEs)
// ==========================================================================

function updateSandbox() {
  // --- 1. Evaluate safety constraints ---
  let excludeReasons = [];
  let holdReasons = [];
  
  if (sandboxState.ecog >= 3) excludeReasons.push(`ECOG performance score is ${sandboxState.ecog} (must be ≤ 2)`);
  if (sandboxState.lvef < 45) excludeReasons.push(`LVEF is ${sandboxState.lvef}% (minimum baseline reserve 45%)`);
  if (sandboxState.dlco < 50) excludeReasons.push(`DLCO Predicted is ${sandboxState.dlco}% (minimum threshold 50%)`);
  if (sandboxState.crcl < 40) excludeReasons.push(`CrCl filtration is ${sandboxState.crcl} mL/min (minimum threshold 40)`);
  if (sandboxState.infection) excludeReasons.push(`Active bacterial/viral infection present`);
  if (sandboxState.cd34 < 2.0) excludeReasons.push(`CD34+ cell yield is ${sandboxState.cd34} ×10⁶/kg (minimum threshold 2.0)`);
  
  if (sandboxState.salvage_days < 21) {
    if (sandboxState.salvage_days < 14) {
      excludeReasons.push(`Days since last salvage chemo is ${sandboxState.salvage_days} (absolute minimum recovery is 14 days)`);
    } else {
      holdReasons.push(`Malignant overlap risk: days since salvage is ${sandboxState.salvage_days} (recommended window is 21+ days)`);
    }
  }

  // --- 2. Calculate Stage 2 PK indices ---
  // Peak concentration scaling
  const BCNU_AUC = parseFloat((sandboxState.bsa * 4.5).toFixed(2));
  const BCNU_LungDamage = parseFloat((BCNU_AUC * (75 / sandboxState.dlco) * 0.07).toFixed(2));
  
  const Etop_Top2Score = parseFloat((sandboxState.bsa * 5.0 * (1.2 - 0.02 * sandboxState.chemo_lines)).toFixed(1));
  const Melp_RenalStress = parseFloat((sandboxState.bsa * 8.2 * (80 / sandboxState.crcl)).toFixed(2));
  
  // Melphalan 24-hour clearance check
  const clearanceRate = 0.46 * (sandboxState.crcl / 80);
  const melp_conc_24h = Math.exp(-clearanceRate * 24) * 8.0;
  const Melp_ClearancePassed = melp_conc_24h < 0.05;
  if (!Melp_ClearancePassed) {
    excludeReasons.push(`Melphalan clearance test failed: residual drug at 24h exceeds 0.05 mg/L`);
  }

  document.getElementById("lbl-lung-index").textContent = BCNU_LungDamage;
  document.getElementById("lbl-top2-score").textContent = Etop_Top2Score;
  document.getElementById("lbl-renal-stress").textContent = Melp_RenalStress;
  
  const clearBadge = document.getElementById("lbl-melp-clearance");
  if (Melp_ClearancePassed) {
    clearBadge.textContent = "PASSED";
    clearBadge.className = "f-val text-success";
  } else {
    clearBadge.textContent = "FAILED";
    clearBadge.className = "f-val text-danger";
  }

  // --- 3. Run Simulated ML head predictions (XGBoost & SHAP) ---
  // SHAP waterfall attribution parameters
  const baseValueVal = 1.6; // Log odds baseline
  const shap = {
    infection: sandboxState.infection ? -8.0 : 0.0,
    lvef: sandboxState.lvef < 45 ? -5.0 : sandboxState.lvef < 50 ? -1.2 : 0.2,
    dlco: sandboxState.dlco < 50 ? -5.0 : sandboxState.dlco < 60 ? -1.5 : 0.3,
    crcl: sandboxState.crcl < 40 ? -4.5 : sandboxState.crcl < 55 ? -1.0 : 0.4,
    ecog: sandboxState.ecog >= 3 ? -6.0 : sandboxState.ecog === 2 ? -1.5 : sandboxState.ecog === 1 ? 0.3 : 0.8,
    cd34: sandboxState.cd34 < 2.0 ? -4.0 : sandboxState.cd34 < 3.0 ? -1.1 : 0.5,
    hct_ci: sandboxState.hct_ci >= 4 ? -2.2 : sandboxState.hct_ci >= 3 ? -1.0 : 0.2,
    prior: sandboxState.chemo_lines >= 4 ? -1.8 : sandboxState.chemo_lines === 3 ? -0.8 : 0.3
  };

  const totalLogOdds = baseValueVal + Object.values(shap).reduce((a, b) => a + b, 0);
  const engraftmentProb = 1 / (1 + Math.exp(-totalLogOdds));
  
  // Display Engraftment Probability
  const pEngPercent = (engraftmentProb * 100).toFixed(1);
  document.getElementById("verdict-engraft-prob").textContent = `${pEngPercent}%`;

  // Final Clinical Verdict
  let decision = "GO";
  if (excludeReasons.length > 0) {
    decision = "EXCLUDE";
  } else if (holdReasons.length > 0 || engraftmentProb < 0.70) {
    decision = "HOLD";
  }

  // Update SVG decision text if exists
  if (elements.svgDecisionText) {
    elements.svgDecisionText.textContent = `${decision} DECISION`;
  }

  // Update HTML flow diagram decision chips
  const goChip = document.querySelector(".decision-chips .chip-go");
  const holdChip = document.querySelector(".decision-chips .chip-hold");
  const excludeChip = document.querySelector(".decision-chips .chip-exclude");
  if (goChip && holdChip && excludeChip) {
    goChip.classList.toggle("active", decision === "GO");
    holdChip.classList.toggle("active", decision === "HOLD");
    excludeChip.classList.toggle("active", decision === "EXCLUDE");
  }


  // Update Verdict UI
  const banner = document.getElementById("verdict-banner");
  const badge = document.getElementById("verdict-badge");
  const rationale = document.getElementById("verdict-rationale");

  banner.className = "card verdict-card";
  if (decision === "GO") {
    banner.classList.add("decision-go");
    badge.textContent = "GO (BEAM ELIGIBLE)";
    rationale.innerHTML = `Patient is eligible for myeloablative conditioning. Organ reserves, stem cell yields, and performance indexes are within therapeutic limits.`;
  } else if (decision === "HOLD") {
    banner.classList.add("decision-hold");
    badge.textContent = "HOLD (PROVISIONAL HOLD)";
    
    let text = `<strong>Dosing held due to:</strong> `;
    if (holdReasons.length > 0) {
       text += holdReasons.join("; ") + ".";
    } else {
       text += `Borderline engraftment likelihood predicted (${pEngPercent}%). Optimize stem cell count or timing.`;
    }
    rationale.innerHTML = text;
  } else {
    banner.classList.add("decision-exclude");
    badge.textContent = "EXCLUDE (CRITICAL THRESHOLD)";
    rationale.innerHTML = `<strong>Patient excluded from standard myeloablative BEAM:</strong><ul><li>` + excludeReasons.join("</li><li>") + `</li></ul>Pivot to non-myeloablative regimens or convene MDT panel review.`;
  }

  // Update dashboard details based on sandbox outputs
  document.getElementById("lbl-neutropenia-window").innerHTML = decision === "EXCLUDE" 
    ? `<span class="text-danger">Undetermined / Severe risk of primary engraftment failure</span>`
    : `Days +7 to +${12 + Math.round(5 - sandboxState.cd34/2)} (${6 + Math.round(5 - sandboxState.cd34/2)} days duration)`;
  
  let surveillanceText = "Standard monitoring: routine PFTs at Day +100.";
  if (sandboxState.chemo_lines >= 3 || sandboxState.tp53 > 1.0) {
    surveillanceText = "High Risk for late effects: bone marrow biopses at D+100 and 12-months for t-MDS monitoring.";
  } else if (BCNU_LungDamage > 0.5) {
    surveillanceText = "High Pulmonary Risk: specialized lung diffusion checks at month +3, +6.";
  } else if (Melp_RenalStress > 2.0) {
    surveillanceText = "High Renal Risk: check GFR filtration capacity quarterly.";
  }
  document.getElementById("lbl-surveillance-focus").textContent = surveillanceText;

  // --- 4. Redraw Visual Charts ---
  drawPKCharts();
  drawSHAPChart(shap, baseValueVal);
  drawCBCChart(decision);
  drawLateEffectsChart();
  drawOrganHeatmap(BCNU_LungDamage, Melp_RenalStress);

  // --- 5. Refresh protocol CTCAE grades + Mini-BEAM visibility ---
  if (state.activeTab === "protocol" && activeProtocolNodeId) {
    renderNodeDetail(activeProtocolNodeId);
  }
  updateMiniBEAMVisibility();
}

// Helper to draw dual PK curves
function drawPKCharts() {
  const drawPK = (svgId, drug1, drug2) => {
    const svg = document.getElementById(svgId);
    if (!svg) return;
    svg.innerHTML = "";
    
    const width = 400;
    const height = 220;
    const padding = { top: 20, right: 20, bottom: 30, left: 40 };
    
    // Axes lines
    svg.appendChild(createSVGLine(padding.left, height - padding.bottom, width - padding.right, height - padding.bottom, "#475569", 1));
    svg.appendChild(createSVGLine(padding.left, padding.top, padding.left, height - padding.bottom, "#475569", 1));

    // Axis labels
    svg.appendChild(createSVGText(width/2, height - 8, "Time (Hours Post Infusion)", 10, "middle"));
    
    // Gridlines & scales
    const maxVal = 10;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (height - padding.top - padding.bottom) * (1 - i/4);
      const val = (maxVal * i / 4).toFixed(1);
      svg.appendChild(createSVGLine(padding.left, y, width - padding.right, y, "rgba(71, 85, 105, 0.15)", 0.8));
      svg.appendChild(createSVGText(padding.left - 8, y + 3, val, 9, "end"));
    }
    
    // Hour indicators
    for (let i = 0; i <= 24; i += 6) {
      const x = padding.left + (width - padding.left - padding.right) * (i/24);
      svg.appendChild(createSVGLine(x, height - padding.bottom, x, height - padding.bottom + 4, "#475569", 1));
      svg.appendChild(createSVGText(x, height - padding.bottom + 14, `${i}h`, 9, "middle"));
    }

    // Solve PK curves
    const points1 = [];
    const points2 = [];
    const steps = 60;
    
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * 24;
      const x = padding.left + (width - padding.left - padding.right) * (t/24);
      
      // Solver formulas
      let val1 = 0;
      let val2 = 0;
      
      if (drug1 === "BCNU") {
        // 2-compartment
        val1 = sandboxState.bsa * 4.2 * (0.8 * Math.exp(-1.9 * t) + 0.2 * Math.exp(-0.35 * t));
      } else if (drug1 === "AraC") {
        val1 = sandboxState.bsa * 3.8 * (0.75 * Math.exp(-3.5 * t) + 0.25 * Math.exp(-0.3 * t));
      }
      
      if (drug2 === "Etoposide") {
        val2 = sandboxState.bsa * 3.5 * Math.exp(-0.17 * t);
      } else if (drug2 === "Melphalan") {
        const clearanceRate = 0.46 * (sandboxState.crcl / 80);
        val2 = sandboxState.bsa * 3.8 * Math.exp(-clearanceRate * t);
      }

      const y1 = padding.top + (height - padding.top - padding.bottom) * (1 - Math.min(val1, maxVal)/maxVal);
      const y2 = padding.top + (height - padding.top - padding.bottom) * (1 - Math.min(val2, maxVal)/maxVal);
      
      points1.push(`${x},${y1}`);
      points2.push(`${x},${y2}`);
    }

    svg.appendChild(createSVGPath(points1.join(" L "), drug1 === "BCNU" ? "#ea580c" : "#3b82f6", 2));
    svg.appendChild(createSVGPath(points2.join(" L "), drug2 === "Etoposide" ? "#f59e0b" : "#10b981", 2));
  };

  drawPK("svg-pk-1", "BCNU", "Etoposide");
  drawPK("svg-pk-2", "AraC", "Melphalan");
}

// Draw SHAP Waterfall
function drawSHAPChart(shap, baseValue) {
  const svg = document.getElementById("svg-shap-elig");
  if (!svg) return;
  svg.innerHTML = "";

  const width = 400;
  const height = 240;
  const padding = { top: 20, right: 30, bottom: 30, left: 100 };

  const variables = [
    { label: "Base LogOdds", val: baseValue },
    { label: "Active Infection", val: shap.infection },
    { label: "Cardiac (LVEF)", val: shap.lvef },
    { label: "Lung (DLCO)", val: shap.dlco },
    { label: "Renal (CrCl)", val: shap.crcl },
    { label: "ECOG Score", val: shap.ecog },
    { label: "CD34+ Cell Yield", val: shap.cd34 },
    { label: "Comorbid HCT-CI", val: shap.hct_ci },
    { label: "Prior Chemotherapy", val: shap.prior }
  ];

  // Gridlines
  svg.appendChild(createSVGLine(padding.left, height - padding.bottom, width - padding.right, height - padding.bottom, "#475569", 1));
  const minVal = -15;
  const maxVal = 5;
  const mapX = (val) => padding.left + (width - padding.left - padding.right) * ((val - minVal) / (maxVal - minVal));

  for (let val = minVal; val <= maxVal; val += 5) {
    const x = mapX(val);
    svg.appendChild(createSVGLine(x, padding.top, x, height - padding.bottom, "rgba(71, 85, 105, 0.15)", 0.8));
    svg.appendChild(createSVGText(x, height - padding.bottom + 12, val, 9, "middle"));
  }

  // Draw bars
  const barHeight = 12;
  const rowSpacing = 20;
  let runningTotal = 0;

  variables.forEach((item, index) => {
    const y = padding.top + index * rowSpacing;
    const val = item.val;
    const startX = mapX(runningTotal);
    runningTotal += val;
    const endX = mapX(runningTotal);
    
    // Label
    svg.appendChild(createSVGText(padding.left - 8, y + 8, item.label, 9.5, "end"));

    if (val === 0) return; // Skip zero values

    const isPositive = val > 0;
    const rectX = isPositive ? startX : endX;
    const rectW = Math.abs(endX - startX);
    const rectColor = isPositive ? "#3b82f6" : "#ef4444";

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", rectX);
    rect.setAttribute("y", y);
    rect.setAttribute("width", Math.max(rectW, 1));
    rect.setAttribute("height", barHeight);
    rect.setAttribute("rx", 2);
    rect.setAttribute("fill", rectColor);
    svg.appendChild(rect);

    // Dynamic SHAP text indicators
    const textX = isPositive ? endX + 4 : startX - 4;
    const textAnchor = isPositive ? "start" : "end";
    const prefix = isPositive ? "+" : "";
    svg.appendChild(createSVGText(textX, y + 9, `${prefix}${val.toFixed(1)}`, 8, textAnchor, rectColor, "bold"));
  });

  // Vertical line at 0
  const zeroX = mapX(0);
  svg.appendChild(createSVGLine(zeroX, padding.top, zeroX, height - padding.bottom, "#94a3b8", 1, "3,3"));
}

// Draw CBC Trajectory
function drawCBCChart(decision) {
  const svg = document.getElementById("svg-cbc");
  if (!svg) return;
  svg.innerHTML = "";

  const width = 400;
  const height = 220;
  const padding = { top: 20, right: 30, bottom: 30, left: 40 };

  // Axes lines
  svg.appendChild(createSVGLine(padding.left, height - padding.bottom, width - padding.right, height - padding.bottom, "#475569", 1));
  svg.appendChild(createSVGLine(padding.left, padding.top, padding.left, height - padding.bottom, "#475569", 1));

  // Day indicators
  for (let day = 0; day <= 30; day += 5) {
    const x = padding.left + (width - padding.left - padding.right) * (day/30);
    svg.appendChild(createSVGLine(x, height - padding.bottom, x, height - padding.bottom + 4, "#475569", 1));
    svg.appendChild(createSVGText(x, height - padding.bottom + 14, `D+${day}`, 9, "middle"));
  }

  // ANC Scale gridlines (nadir scale: 0 to 20 representing 0 to 2000 cells/μL)
  const maxAnc = 20;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (height - padding.top - padding.bottom) * (1 - i/4);
    const val = i * 500;
    svg.appendChild(createSVGLine(padding.left, y, width - padding.right, y, "rgba(71, 85, 105, 0.15)", 0.8));
    svg.appendChild(createSVGText(padding.left - 6, y + 3, val, 9, "end"));
  }

  // Draw curves points
  const pointsANC = [];
  const pointsPLT = [];
  const steps = 30;
  
  // Calculate nadir day and depth based on inputs
  const nadirDay = 9;
  let ancNadirDepth = 0.5; // (50 cells/μL)
  let pltNadirDepth = 8;   // (8k/μL)
  
  if (sandboxState.cd34 < 2.5) {
    ancNadirDepth = 0.1; // extreme nadir
    pltNadirDepth = 3;
  }
  
  // Solve simulated recovery curves
  for (let day = 0; day <= steps; day++) {
    const x = padding.left + (width - padding.left - padding.right) * (day/30);
    
    let anc = 15; // baseline ~1500
    let plt = 150; // baseline ~150k
    
    if (decision === "EXCLUDE") {
      // Failed engraftment trajectory
      if (day < 6) {
        anc = 15 - 2.4 * day;
        plt = 150 - 24 * day;
      } else {
        anc = 0.2 + 0.05 * Math.sin(day);
        plt = 4 + 0.1 * Math.sin(day);
      }
    } else {
      // Recovering trajectory
      if (day <= nadirDay) {
        anc = 15 - (15 - ancNadirDepth) * Math.sin((day / nadirDay) * (Math.PI / 2));
        plt = 150 - (150 - pltNadirDepth) * Math.sin((day / nadirDay) * (Math.PI / 2));
      } else {
        // Recovery slope modified by CD34 stem cell yield
        const recFactor = 0.06 * sandboxState.cd34;
        const speed = Math.min(1, (day - nadirDay) * recFactor);
        anc = ancNadirDepth + (16 - ancNadirDepth) * speed;
        plt = pltNadirDepth + (130 - pltNadirDepth) * speed;
      }
    }

    const yAnc = padding.top + (height - padding.top - padding.bottom) * (1 - Math.min(anc, maxAnc)/maxAnc);
    const yPlt = padding.top + (height - padding.top - padding.bottom) * (1 - Math.min(plt, 200)/200);

    pointsANC.push(`${x},${yAnc}`);
    pointsPLT.push(`${x},${yPlt}`);
  }

  // Highlight neutropenic threshold area (< 500 cells/μL)
  const neutropenicThresholdY = padding.top + (height - padding.top - padding.bottom) * (1 - 5/maxAnc);
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", padding.left);
  rect.setAttribute("y", neutropenicThresholdY);
  rect.setAttribute("width", width - padding.left - padding.right);
  rect.setAttribute("height", height - padding.bottom - neutropenicThresholdY);
  rect.setAttribute("fill", "rgba(239, 68, 68, 0.05)");
  svg.appendChild(rect);

  svg.appendChild(createSVGPath(pointsANC.join(" L "), "#10b981", 2));
  svg.appendChild(createSVGPath(pointsPLT.join(" L "), "#f59e0b", 2));
}

// Draw GFR and MDS Hazard Curves
function drawLateEffectsChart() {
  const svg = document.getElementById("svg-late");
  if (!svg) return;
  svg.innerHTML = "";

  const width = 400;
  const height = 220;
  const padding = { top: 20, right: 30, bottom: 30, left: 40 };

  // Axes lines
  svg.appendChild(createSVGLine(padding.left, height - padding.bottom, width - padding.right, height - padding.bottom, "#475569", 1));
  svg.appendChild(createSVGLine(padding.left, padding.top, padding.left, height - padding.bottom, "#475569", 1));

  // Year indicators
  for (let yr = 0; yr <= 15; yr += 3) {
    const x = padding.left + (width - padding.left - padding.right) * (yr/15);
    svg.appendChild(createSVGLine(x, height - padding.bottom, x, height - padding.bottom + 4, "#475569", 1));
    svg.appendChild(createSVGText(x, height - padding.bottom + 14, `${yr}y`, 9, "middle"));
  }

  // Hazard scale gridlines (0 to 40%)
  const maxScale = 40;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (height - padding.top - padding.bottom) * (1 - i/4);
    const val = `${i * 10}%`;
    svg.appendChild(createSVGLine(padding.left, y, width - padding.right, y, "rgba(71, 85, 105, 0.15)", 0.8));
    svg.appendChild(createSVGText(padding.left - 6, y + 3, val, 9, "end"));
  }

  // Draw curves points
  const pointsGFR = [];
  const pointsMDS = [];
  const steps = 15;

  const renalStress = sandboxState.bsa * 8.2 * (80 / sandboxState.crcl);
  // Calculate t-MDS hazard based on prior lines and CHIP mutations VAF
  const tMdsBaseCoeff = 0.05 * Math.pow(sandboxState.chemo_lines, 2) + 0.3 * (sandboxState.tp53 + sandboxState.ppm1d);

  for (let yr = 0; yr <= steps; yr++) {
    const x = padding.left + (width - padding.left - padding.right) * (yr/15);
    
    // GFR decline percentage
    const gfrDecline = Math.min(35, 0.8 * renalStress * yr);
    
    // t-MDS hazard percentage
    const mdsHazard = Math.min(39, tMdsBaseCoeff * Math.pow(yr, 1.2));

    const yGfr = padding.top + (height - padding.top - padding.bottom) * (gfrDecline/maxScale);
    const yMds = padding.top + (height - padding.top - padding.bottom) * (1 - mdsHazard/maxScale);

    pointsGFR.push(`${x},${yGfr}`);
    pointsMDS.push(`${x},${yMds}`);
  }

  svg.appendChild(createSVGPath(pointsGFR.join(" L "), "#3b82f6", 2));
  svg.appendChild(createSVGPath(pointsMDS.join(" L "), "#ef4444", 2));
}

// Update organ risk block colors
function drawOrganHeatmap(lungDmg, renalStr) {
  const getRiskClass = (val, thresholds) => {
    if (val >= thresholds[1]) return "risk-high";
    if (val >= thresholds[0]) return "risk-mod";
    return "risk-low";
  };
  const getRiskLabel = (riskClass) => {
    if (riskClass === "risk-high") return "HIGH RISK";
    if (riskClass === "risk-mod") return "MOD RISK";
    return "LOW RISK";
  };

  const updateOrgan = (domId, score, thresholds) => {
    const el = document.querySelector(`[data-organ="${domId}"]`);
    if (!el) return;
    const rc = getRiskClass(score, thresholds);
    el.className = `organ-block ${rc}`;
    el.querySelector(".organ-score").textContent = getRiskLabel(rc);
  };

  // Cardiac: dependent on LVEF and HCT-CI
  const cardiacScore = (75 - sandboxState.lvef) * 0.05 + sandboxState.hct_ci * 0.1;
  updateOrgan("cardiac", cardiacScore, [0.8, 1.4]);

  // Lung: BCNU lung index
  updateOrgan("lung", lungDmg, [0.35, 0.6]);

  // Renal: Melphalan stress
  updateOrgan("renal", renalStr, [1.5, 2.5]);

  // CNS: dependent on age & BSA (acting as proxy for distribution)
  const cnsScore = sandboxState.age * 0.01 + sandboxState.bsa * 0.15;
  updateOrgan("cns", cnsScore, [0.75, 1.1]);

  // Gonadal: almost always high standard toxicity in adults
  const gonadalScore = sandboxState.age > 40 ? 1.5 : 0.8;
  updateOrgan("gonadal", gonadalScore, [0.5, 1.0]);

  // Hepatic: dependent on prior lines and age
  const hepaticScore = sandboxState.chemo_lines * 0.2 + sandboxState.hct_ci * 0.1;
  updateOrgan("hepatic", hepaticScore, [0.7, 1.2]);
}

// SVG helpers
function createSVGLine(x1, y1, x2, y2, stroke, width, dash = "") {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("stroke", stroke);
  line.setAttribute("stroke-width", width);
  if (dash) line.setAttribute("stroke-dasharray", dash);
  return line;
}

function createSVGText(x, y, content, size, anchor, fill = "#94a3b8", weight = "normal") {
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", x);
  text.setAttribute("y", y);
  text.setAttribute("font-size", size);
  text.setAttribute("text-anchor", anchor);
  text.setAttribute("fill", fill);
  text.setAttribute("font-weight", weight);
  text.setAttribute("font-family", "var(--font-sans)");
  text.textContent = content;
  return text;
}

function createSVGPath(pointsData, stroke, width) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M ${pointsData}`);
  path.setAttribute("stroke", stroke);
  path.setAttribute("stroke-width", width);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke-linecap", "round");
  return path;
}

// ==========================================================================
// 8. Stochastic Bone Marrow Grid Animation (Canvas)
// ==========================================================================

function resetMarrowSimulation() {
  pauseMarrowSimulation();
  marrowSimDay = 0;
  document.getElementById("marrow-day-val").textContent = "0";

  const canvas = document.getElementById("marrow-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, MARROW_CANVAS_WIDTH, MARROW_CANVAS_HEIGHT);
  
  // Set play button state
  document.getElementById("btn-marrow-play").textContent = "▶ Run Simulation";
  
  // Initialize niches
  marrowNiches = [];
  const rows = 5;
  const cols = 8;
  const spacingX = MARROW_CANVAS_WIDTH / (cols + 1);
  const spacingY = MARROW_CANVAS_HEIGHT / (rows + 1);
  
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      marrowNiches.push({
        x: spacingX * (c + 1),
        y: spacingY * (r + 1),
        occupiedBy: null // 'normal' | 'tp53' | 'ppm1d' | null
      });
    }
  }

  // Populate total niches label
  document.getElementById("val-total-niches").textContent = marrowNiches.length;
  document.getElementById("val-occupied-niches").textContent = "0";
  document.getElementById("val-normal-cell-ratio").textContent = "100%";
  document.getElementById("val-chip-cell-ratio").textContent = "0%";

  // Create migrating particles (cells) based on stem cell yield inputs
  marrowCells = [];
  const count = Math.round(sandboxState.cd34 * 12);
  const mutantRatioTP53 = sandboxState.tp53 / 100;
  const mutantRatioPPM1D = sandboxState.ppm1d / 100;
  
  for (let i = 0; i < count; i++) {
    const isTP53 = Math.random() < mutantRatioTP53;
    const isPPM1D = !isTP53 && Math.random() < mutantRatioPPM1D;
    
    marrowCells.push({
      x: Math.random() * MARROW_CANVAS_WIDTH,
      y: Math.random() * MARROW_CANVAS_HEIGHT,
      vx: (Math.random() - 0.5) * 3,
      vy: (Math.random() - 0.5) * 3,
      type: isTP53 ? "tp53" : isPPM1D ? "ppm1d" : "normal",
      status: "migrating" // 'migrating' | 'engrafted'
    });
  }

  drawMarrowCanvas(ctx);
}

function startMarrowSimulation() {
  if (marrowSimRunning) return;
  marrowSimRunning = true;
  document.getElementById("btn-marrow-play").textContent = "⏸ Pause";

  const canvas = document.getElementById("marrow-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  marrowSimInterval = setInterval(() => {
    // Tick Days
    marrowSimDay += 0.2;
    const currentDay = Math.floor(marrowSimDay);
    document.getElementById("marrow-day-val").textContent = currentDay;

    if (currentDay >= 30) {
      pauseMarrowSimulation();
      return;
    }

    // Update cells positions (stochastic Monte Carlo random walk)
    marrowCells.forEach(cell => {
      if (cell.status === "engrafted") return;

      // Add random displacement (diffusion)
      cell.vx += (Math.random() - 0.5) * 0.8;
      cell.vy += (Math.random() - 0.5) * 0.8;
      
      // Speed cap
      const speed = Math.sqrt(cell.vx * cell.vx + cell.vy * cell.vy);
      if (speed > 4) {
        cell.vx = (cell.vx / speed) * 4;
        cell.vy = (cell.vy / speed) * 4;
      }

      cell.x += cell.vx;
      cell.y += cell.vy;

      // Boundary check
      if (cell.x < 0 || cell.x > MARROW_CANVAS_WIDTH) cell.vx *= -1;
      if (cell.y < 0 || cell.y > MARROW_CANVAS_HEIGHT) cell.vy *= -1;

      // Check collision with unoccupied niches
      marrowNiches.forEach(niche => {
        if (niche.occupiedBy !== null) return;
        
        const dx = cell.x - niche.x;
        const dy = cell.y - niche.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < 12) {
          // Engraftment niche occupancy trigger!
          niche.occupiedBy = cell.type;
          cell.status = "engrafted";
          cell.x = niche.x;
          cell.y = niche.y;
        }
      });
    });

    // Solve clonal expansions on niches as chemotherapy damage clears
    if (currentDay > 10 && Math.random() < 0.05) {
      // If we have high CHIP VAF, clones outcompete normal cells in niche space
      const hasTP53 = sandboxState.tp53 > 0;
      const hasPPM1D = sandboxState.ppm1d > 0;
      
      if (hasTP53 || hasPPM1D) {
        // Pick an occupied niche of normal cells, swap with a mutant clone
        const normalNiches = marrowNiches.filter(n => n.occupiedBy === "normal");
        if (normalNiches.length > 0) {
          const target = normalNiches[Math.floor(Math.random() * normalNiches.length)];
          target.occupiedBy = hasTP53 ? "tp53" : "ppm1d";
        }
      }
    }

    // Recalculate Niche Stats labels
    const occupied = marrowNiches.filter(n => n.occupiedBy !== null).length;
    const normalCount = marrowNiches.filter(n => n.occupiedBy === "normal").length;
    const chipCount = marrowNiches.filter(n => n.occupiedBy === "tp53" || n.occupiedBy === "ppm1d").length;
    
    document.getElementById("val-occupied-niches").textContent = occupied;
    
    if (occupied > 0) {
      const normRatio = Math.round((normalCount / occupied) * 100);
      const chipRatio = 100 - normRatio;
      document.getElementById("val-normal-cell-ratio").textContent = `${normRatio}%`;
      document.getElementById("val-chip-cell-ratio").textContent = `${chipRatio}%`;
    }

    drawMarrowCanvas(ctx);
  }, 33); // ~30 fps
}

function pauseMarrowSimulation() {
  marrowSimRunning = false;
  clearInterval(marrowSimInterval);
  document.getElementById("btn-marrow-play").textContent = "▶ Resume";
}

function drawMarrowCanvas(ctx) {
  ctx.fillStyle = "#040810";
  ctx.fillRect(0, 0, MARROW_CANVAS_WIDTH, MARROW_CANVAS_HEIGHT);

  // 1. Draw vessel grid niches (green rectangles representing vessel grids)
  marrowNiches.forEach(niche => {
    ctx.strokeStyle = "rgba(16, 185, 129, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(niche.x - 8, niche.y - 8, 16, 16);
    
    // Draw occupants inside niches
    if (niche.occupiedBy) {
      ctx.fillStyle = niche.occupiedBy === "tp53" 
        ? "#7c3aed" // TP53 Purple
        : niche.occupiedBy === "ppm1d" 
          ? "#ec4899" // PPM1D Magenta
          : "#2563eb"; // Normal blue
      ctx.beginPath();
      ctx.arc(niche.x, niche.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // 2. Draw migrating cells
  marrowCells.forEach(cell => {
    if (cell.status === "engrafted") return;
    
    ctx.fillStyle = cell.type === "tp53" 
      ? "rgba(124, 58, 237, 0.6)" 
      : cell.type === "ppm1d" 
        ? "rgba(236, 72, 153, 0.6)" 
        : "rgba(37, 99, 235, 0.6)";
        
    ctx.beginPath();
    ctx.arc(cell.x, cell.y, 4, 0, Math.PI * 2);
    ctx.fill();
  });
}


// ==========================================================================
// 9. Treatment Protocol Timeline Engine
// ==========================================================================

let activeProtocolNodeId = null;

// --- 9.1  Static protocol node data ---
const etoAraOrderSet = {
  ivMeds: [
    { drug: "Etoposide", dose: "200 mg/m² in 500 mL NS", freq: "Once over 4h", indication: "TopII inhibitor — BEAM conditioning" },
    { drug: "Cytarabine (Ara-C)", dose: "400 mg/m² in 500 mL NS", freq: "Once over 2h (after Etoposide)", indication: "Antimetabolite — BEAM conditioning" },
    { drug: "Ondansetron", dose: "8 mg", freq: "IV Q8h", indication: "Antiemetic" },
    { drug: "Normal Saline 0.9%", dose: "100 mL/hr", freq: "Continuous", indication: "IV hydration" },
    { drug: "Dexamethasone eye drops", dose: "1 drop each eye", freq: "Q6h while on Ara-C", indication: "Ara-C conjunctivitis prophylaxis" }
  ],
  poMeds: [
    { drug: "Acyclovir", dose: "400 mg", freq: "PO BID", indication: "Viral prophylaxis" },
    { drug: "Fluconazole", dose: "200 mg", freq: "PO daily", indication: "Antifungal prophylaxis" },
    { drug: "Loperamide", dose: "2–4 mg", freq: "PO Q4h PRN diarrhea", indication: "Ara-C GI effect management" },
    { drug: "Sucralfate suspension", dose: "1 g in 10 mL", freq: "PO QID", indication: "Mucositis prophylaxis" }
  ],
  labs: [
    { test: "CBC with differential", freq: "Daily AM", threshold: "Track myelosuppression onset" },
    { test: "CMP", freq: "Daily", threshold: "Creatinine: Ara-C accumulation risk" },
    { test: "LFTs", freq: "Every other day", threshold: "ALT >5× ULN → Etoposide dose review" },
    { test: "Neurological exam", freq: "Daily", threshold: "New ataxia or dysarthria → hold Ara-C immediately" }
  ],
  nursing: [
    { action: "Vital signs", freq: "Q4h", notes: "Etoposide hypotension risk — slow infusion if SBP <90 mmHg" },
    { action: "Infusion rate monitoring", freq: "Q30 min during Etoposide", notes: "Hypotension from rapid infusion — slow rate, hold if SBP <80" },
    { action: "Neurological check (cerebellar)", freq: "Daily", notes: "Assess finger-to-nose, gait — Ara-C cerebellar toxicity" },
    { action: "Mucositis assessment", freq: "Q8h", notes: "WHO oral mucositis scale — Grade 3+ → PCA, dietary consult" },
    { action: "Strict I&O", freq: "Q8h", notes: "Urine output target >1 mL/kg/hr — below → increase IV fluids, notify MD" }
  ]
};

const etoAraBranches = [
  {
    condition: "Etoposide-induced hypotension (SBP <90 mmHg during infusion)",
    action: "Slow infusion rate 50%. Bolus 250 mL NS. Resume at half-rate when stable. Monitor BP Q15 min.",
    escalation: "SBP <80 mmHg unresponsive to fluids → hold infusion, vasopressor support, ICU consult"
  },
  {
    condition: "Ara-C cerebellar toxicity (new ataxia, dysarthria, nystagmus)",
    action: "Hold Ara-C immediately. Neurology consult. Stat head CT to rule out bleed.",
    escalation: "Confirmed cerebellar toxicity → discontinue all remaining Ara-C doses, notify MDT"
  },
  {
    condition: "Oral mucositis Grade 3+ (unable to swallow, requires IV fluids only)",
    action: "Add PCA morphine for pain control. Dietitian consult. Consider TPN if oral intake <50%.",
    escalation: "Mucositis Grade 4 (life-threatening) → GI consult, ICU-level supportive care"
  }
];

const protocolNodes = [
  {
    id: "neg6",
    dayLabel: "Day −6",
    dayNum: -6,
    phase: "conditioning",
    phaseColor: "#ea580c",
    icon: "💊",
    summary: "BCNU (Carmustine) 300 mg/m²",
    drugs: [
      { name: "BCNU (Carmustine)", dose: "300 mg/m²", route: "IV infusion", duration: "2 hours", color: "#ea580c" }
    ],
    ctcaeWatch: [
      { organ: "Pulmonary", key: "pulmonary" },
      { organ: "CNS / Cognitive", key: "cns" },
      { organ: "Hepatic", key: "hepatic" }
    ],
    orderSet: {
      ivMeds: [
        { drug: "BCNU (Carmustine)", dose: "300 mg/m² in 500 mL NS", freq: "Once over 2h", indication: "Myeloablative conditioning — Day −6 only" },
        { drug: "Ondansetron", dose: "8 mg", freq: "IV 30 min pre-BCNU, then Q8h × 24h", indication: "Antiemetic prophylaxis" },
        { drug: "Dexamethasone", dose: "10 mg", freq: "IV once pre-infusion", indication: "Antiemetic adjunct" },
        { drug: "Normal Saline 0.9%", dose: "125 mL/hr", freq: "Continuous × 12h", indication: "IV hydration + renal protection" },
        { drug: "Pantoprazole", dose: "40 mg", freq: "IV daily", indication: "GI mucosal protection" }
      ],
      poMeds: [
        { drug: "Lorazepam", dose: "0.5–1 mg", freq: "PO Q6h PRN", indication: "Breakthrough nausea / anxiety" },
        { drug: "Acyclovir", dose: "400 mg", freq: "PO BID", indication: "Viral prophylaxis (HSV/VZV)" },
        { drug: "Fluconazole", dose: "200 mg", freq: "PO daily", indication: "Antifungal prophylaxis" }
      ],
      labs: [
        { test: "CBC with differential", freq: "Daily AM", threshold: "Baseline for conditioning reference" },
        { test: "CMP (electrolytes, creatinine, LFTs)", freq: "Daily", threshold: "LFTs: flag if AST/ALT >3× ULN → hepatology" },
        { test: "SpO₂ continuous monitoring", freq: "During infusion + Q4h", threshold: "<94% → escalate immediately" },
        { test: "Pulmonary assessment", freq: "Pre and post BCNU", threshold: "New crackles or wheeze → pulmonology consult" }
      ],
      nursing: [
        { action: "Vital signs (BP, HR, SpO₂, Temp, RR)", freq: "Q4h (Q1h during infusion)", notes: "Watch for bronchospasm during infusion" },
        { action: "IV site / extravasation check", freq: "Q1h during infusion", notes: "BCNU is a vesicant — extravasation causes tissue necrosis" },
        { action: "Neurological status check", freq: "Q8h", notes: "BCNU crosses BBB — confusion or seizure → hold and notify MD" },
        { action: "Oral hygiene protocol", freq: "Q4h while awake", notes: "Begin immediately — BCNU initiates mucositis cascade" }
      ]
    },
    decisionBranches: [
      {
        condition: "SpO₂ drops below 94% or DLCO >15% decline from baseline",
        action: "Reduce BCNU infusion rate 50%. Hold if no improvement in 30 min. O₂ supplementation. Stat pulmonology consult.",
        escalation: "SpO₂ <88% or respiratory distress persists → stat CXR, consider ICU transfer"
      },
      {
        condition: "Signs of cardiac decompensation (hypotension, HR >130, chest pain)",
        action: "Hold BCNU immediately. Stat 12-lead ECG and troponin. Cardiology consult within 1 hour.",
        escalation: "Troponin >0.04 ng/mL → CCU transfer, hold remaining conditioning"
      },
      {
        condition: "ALT/AST >3× ULN on daily labs",
        action: "Hepatology consult. Complete BCNU infusion today. Flag for Etoposide dose review Day −5.",
        escalation: "Bilirubin >2× ULN → consider full BEAM hold, MDT review"
      }
    ]
  },

  ...[-5, -4, -3, -2].map(d => ({
    id: `neg${Math.abs(d)}`,
    dayLabel: `Day −${Math.abs(d)}`,
    dayNum: d,
    phase: "conditioning",
    phaseColor: "#2563eb",
    icon: "💊",
    summary: "Etoposide 200 mg/m² + Ara-C 400 mg/m²",
    drugs: [
      { name: "Etoposide", dose: "200 mg/m²", route: "IV infusion", duration: "4 hours", color: "#f59e0b" },
      { name: "Ara-C (Cytarabine)", dose: "400 mg/m²", route: "IV infusion", duration: "2 hours (after Etoposide)", color: "#3b82f6" }
    ],
    ctcaeWatch: [
      { organ: "Hematologic", key: "hematologic" },
      { organ: "CNS / Cognitive", key: "cns" },
      { organ: "Mucositis (GI)", key: "mucositis" }
    ],
    orderSet: etoAraOrderSet,
    decisionBranches: etoAraBranches
  })),

  {
    id: "neg1",
    dayLabel: "Day −1",
    dayNum: -1,
    phase: "conditioning",
    phaseColor: "#0d9488",
    icon: "⚠️",
    summary: "Melphalan 140 mg/m² + 24h Clearance Check",
    drugs: [
      { name: "Melphalan", dose: "140 mg/m²", route: "IV infusion", duration: "30 minutes (cold infusion)", color: "#10b981" }
    ],
    ctcaeWatch: [
      { organ: "Renal", key: "renal" },
      { organ: "Mucositis (GI)", key: "mucositis" },
      { organ: "Hematologic", key: "hematologic" }
    ],
    orderSet: {
      ivMeds: [
        { drug: "Melphalan", dose: "140 mg/m² in 250 mL NS (cold)", freq: "Once over 30 min — MUST be cold infusion", indication: "Myeloablative conditioning — final drug" },
        { drug: "Ondansetron", dose: "8 mg", freq: "IV 30 min pre-Melphalan, then Q8h × 48h", indication: "Antiemetic — Melphalan causes severe nausea" },
        { drug: "Fosaprepitant", dose: "150 mg", freq: "IV once pre-Melphalan", indication: "NK1 antagonist antiemetic — mandatory with Melphalan" },
        { drug: "Normal Saline 0.9%", dose: "200 mL/hr", freq: "Continuous × 12h post-infusion", indication: "Aggressive hydration for renal protection" },
        { drug: "Mesna", dose: "20% of Melphalan dose", freq: "IV at 0, 4, 8h post-Melphalan", indication: "Bladder / urothelial protection" }
      ],
      poMeds: [
        { drug: "Ice chips / ice water", dose: "Ad lib", freq: "During and 30 min after infusion", indication: "Oral cryotherapy — reduces Melphalan mucositis 30–40%" },
        { drug: "Acyclovir", dose: "400 mg", freq: "PO BID", indication: "Viral prophylaxis — continue through nadir" },
        { drug: "Fluconazole", dose: "200 mg", freq: "PO daily", indication: "Antifungal prophylaxis" }
      ],
      labs: [
        { test: "Melphalan 24h plasma level", freq: "At 24h post-infusion", threshold: "<0.05 mg/L required — MUST clear before Day 0 ASCT" },
        { test: "Creatinine + BUN", freq: "Q6h", threshold: "Cr rise >50% from baseline → nephrology consult, delay Day 0" },
        { test: "CBC", freq: "Daily AM", threshold: "Baseline before stem cell infusion" },
        { test: "Urinalysis", freq: "Daily", threshold: "Hematuria → Mesna dose review" }
      ],
      nursing: [
        { action: "Oral cryotherapy (ice chips)", freq: "Start 5 min before infusion, continue 30 min after", notes: "Evidence-based mucositis reduction — critical nursing intervention" },
        { action: "Vital signs", freq: "Q2h for 4h post-infusion, then Q4h", notes: "Melphalan anaphylaxis rare but possible — watch for urticaria, bronchospasm" },
        { action: "Urine output strict monitoring", freq: "Q4h", notes: "Target >100 mL/hr — below → bolus NS, notify MD" },
        { action: "Anaphylaxis readiness", freq: "Equipment at bedside during infusion", notes: "Epinephrine, diphenhydramine, hydrocortisone at bedside" }
      ]
    },
    decisionBranches: [
      {
        condition: "Melphalan 24h plasma level ≥0.05 mg/L (clearance FAILS)",
        action: "Delay Day 0 infusion by 24h. Repeat level at 48h. Nephrology consult for CrCl re-check.",
        escalation: "Level still ≥0.05 mg/L at 48h → MDT review, consider hemoperfusion"
      },
      {
        condition: "Creatinine rises >50% from baseline OR urine output <50 mL/hr for 2h",
        action: "Bolus 500 mL NS. Furosemide 20 mg IV if fluid-overloaded. Hold nephrotoxic meds. Nephrology consult.",
        escalation: "Oliguria persisting >4h despite fluids → dialysis access planning, ICU consult"
      },
      {
        condition: "Anaphylaxis during infusion (urticaria, bronchospasm, hypotension)",
        action: "Stop infusion immediately. Epinephrine 0.5 mg IM. Diphenhydramine 50 mg IV. Hydrocortisone 100 mg IV. Call code.",
        escalation: "Persistent anaphylaxis → ICU transfer"
      }
    ]
  },

  {
    id: "day0",
    dayLabel: "Day 0",
    dayNum: 0,
    phase: "infusion",
    phaseColor: "#7c3aed",
    icon: "🔬",
    summary: "CD34+ Stem Cell Infusion (ASCT)",
    drugs: [
      { name: "CD34+ Stem Cell Product", dose: "≥2 ×10⁶ cells/kg", route: "IV (thaw-and-infuse)", duration: "1–2 hours", color: "#7c3aed" }
    ],
    ctcaeWatch: [
      { organ: "Infection Risk", key: "infection" },
      { organ: "Hematologic", key: "hematologic" }
    ],
    orderSet: {
      ivMeds: [
        { drug: "Diphenhydramine", dose: "25 mg", freq: "IV 30 min pre-infusion", indication: "DMSO cryopreservant reaction prophylaxis" },
        { drug: "Acetaminophen", dose: "650 mg", freq: "PO/IV 30 min pre-infusion", indication: "Fever prophylaxis — DMSO infusion reaction" },
        { drug: "Filgrastim (G-CSF)", dose: "5 mcg/kg", freq: "SQ daily starting Day +1", indication: "Engraftment support — stimulate neutrophil recovery" },
        { drug: "Normal Saline 0.9%", dose: "TKO rate", freq: "IV — keep vein open", indication: "Access for immediate reaction management" }
      ],
      poMeds: [
        { drug: "Acyclovir", dose: "400 mg", freq: "PO BID — continue until engraftment", indication: "Viral prophylaxis" },
        { drug: "Fluconazole", dose: "200 mg", freq: "PO daily", indication: "Antifungal prophylaxis" },
        { drug: "Levofloxacin", dose: "500 mg", freq: "PO daily through neutropenic nadir", indication: "Bacterial prophylaxis" }
      ],
      labs: [
        { test: "CBC", freq: "Daily starting Day +1", threshold: "ANC <500 = neutropenic — escalate infection vigilance" },
        { test: "CMP", freq: "Daily", threshold: "Renal and electrolyte monitoring from Melphalan" },
        { test: "CMV / EBV viral load", freq: "Weekly from Day 0", threshold: "CMV >137 copies/mL → preemptive ganciclovir" }
      ],
      nursing: [
        { action: "Continuous vitals monitoring", freq: "Q15 min during infusion, Q1h × 4h after", notes: "DMSO garlic odor is normal — not an adverse reaction" },
        { action: "Product identity double-check", freq: "Before infusion — 2-nurse verification", notes: "Confirm patient ID, product label, cell count with cell lab" },
        { action: "Anaphylaxis response readiness", freq: "Equipment at bedside during full infusion", notes: "DMSO reactions: flushing, hypotension, bradycardia — usually self-limiting" }
      ]
    },
    decisionBranches: [
      {
        condition: "DMSO infusion reaction (hypotension, bradycardia, bronchospasm)",
        action: "Slow infusion to minimum rate. Diphenhydramine 50 mg IV. Atropine 0.5 mg IV if bradycardia. Resume at half-rate when stable.",
        escalation: "Anaphylaxis → stop infusion, epinephrine IM, call code"
      },
      {
        condition: "Cell product viability <70% on pre-infusion quality check",
        action: "Contact transplant team and cell lab immediately. Do not infuse outside protocol limits. Assess backup collection.",
        escalation: "No backup product → emergency MDT meeting"
      }
    ]
  },

  {
    id: "early-post",
    dayLabel: "Day +1–+6",
    dayNum: 1,
    phase: "early-post",
    phaseColor: "#0891b2",
    icon: "📋",
    summary: "G-CSF support — mucositis peak, daily monitoring",
    drugs: [
      { name: "Filgrastim (G-CSF)", dose: "5 mcg/kg", route: "SQ", duration: "Daily until ANC >1000 × 3 days", color: "#0891b2" }
    ],
    ctcaeWatch: [
      { organ: "Mucositis (GI)", key: "mucositis" },
      { organ: "Infection Risk", key: "infection" }
    ],
    orderSet: {
      ivMeds: [
        { drug: "Filgrastim (G-CSF)", dose: "5 mcg/kg", freq: "SQ daily", indication: "Neutrophil recovery — start Day +1" },
        { drug: "Normal Saline 0.9%", dose: "75–125 mL/hr", freq: "Continuous until oral intake adequate", indication: "Hydration — mucositis limiting PO" },
        { drug: "PCA Morphine (if mucositis Grade 2+)", dose: "1 mg/hr basal + 0.5 mg Q10 min PRN", freq: "Continuous", indication: "Pain control for severe mucositis" }
      ],
      poMeds: [
        { drug: "Acyclovir", dose: "400 mg", freq: "PO BID (IV if PO not tolerated)", indication: "Viral prophylaxis" },
        { drug: "Fluconazole", dose: "200 mg", freq: "PO daily (IV if needed)", indication: "Antifungal prophylaxis" },
        { drug: "Levofloxacin", dose: "500 mg", freq: "PO daily", indication: "Bacterial prophylaxis through nadir" }
      ],
      labs: [
        { test: "CBC with differential", freq: "Daily AM", threshold: "Track ANC for engraftment trajectory" },
        { test: "CMP", freq: "Daily", threshold: "Electrolyte replacement for GI losses" },
        { test: "Blood cultures", freq: "If temp ≥38.3°C", threshold: "Draw × 2 sets before starting antibiotics" }
      ],
      nursing: [
        { action: "Oral mucositis scoring", freq: "Q8h", notes: "WHO grade — Grade 3 = opioid pain management; Grade 4 = ICU consideration" },
        { action: "Vital signs + temp", freq: "Q4h", notes: "Temp ≥38.3°C = febrile neutropenia protocol — notify MD immediately" },
        { action: "Nutritional intake tracking", freq: "Every meal", notes: "<50% intake × 3 days → dietitian, TPN consideration" }
      ]
    },
    decisionBranches: [
      {
        condition: "Fever ≥38.3°C with ANC <500 cells/μL (febrile neutropenia)",
        action: "Blood cultures × 2 immediately. Start Piperacillin-Tazobactam 4.5 g IV Q6h (or Cefepime 2 g IV Q8h) within 1 hour.",
        escalation: "No improvement at 72h → add Vancomycin + Micafungin for antifungal escalation"
      },
      {
        condition: "Mucositis Grade 3+ — unable to swallow or maintain hydration",
        action: "Switch all PO meds to IV equivalents. Initiate TPN via central line. Escalate to PCA opioid.",
        escalation: "Aspiration risk → NPO, NG tube, pulmonary / speech therapy consult"
      }
    ]
  },

  {
    id: "nadir",
    dayLabel: "Day +7–+14",
    dayNum: 7,
    phase: "nadir",
    phaseColor: "#dc2626",
    icon: "🔴",
    summary: "Neutropenic Nadir — Maximum infection vulnerability",
    drugs: [],
    ctcaeWatch: [
      { organ: "Hematologic", key: "hematologic" },
      { organ: "Infection Risk", key: "infection" }
    ],
    orderSet: {
      ivMeds: [
        { drug: "Filgrastim (G-CSF)", dose: "5 mcg/kg", freq: "SQ daily — continue until ANC >1000 × 3 days", indication: "Engraftment support" },
        { drug: "Piperacillin-Tazobactam (if febrile)", dose: "4.5 g", freq: "IV Q6h", indication: "Empiric broad-spectrum antibiotics — febrile neutropenia" },
        { drug: "Packed RBC transfusion", dose: "1–2 units PRN", freq: "Transfuse if Hgb <8 g/dL or symptomatic", indication: "Anemia support during nadir" },
        { drug: "Platelet transfusion", dose: "1 apheresis unit PRN", freq: "Transfuse if PLT <10k/μL or active bleeding <50k", indication: "Thrombocytopenia management" }
      ],
      poMeds: [
        { drug: "Continue all prophylactic antimicrobials", dose: "As per prior orders", freq: "Unchanged", indication: "Critical during nadir — do not hold without MD order" }
      ],
      labs: [
        { test: "CBC with differential", freq: "Daily — BID if febrile", threshold: "ANC <100 = profound neutropenia; PLT <10k = transfuse" },
        { test: "Blood cultures", freq: "Each fever spike ≥38.3°C", threshold: "Gram-negative bacteremia most common source" },
        { test: "Galactomannan (Aspergillus)", freq: "Twice weekly", threshold: ">0.5 index → antifungal escalation to Voriconazole" },
        { test: "CMV viral load", freq: "Weekly", threshold: ">137 copies/mL → preemptive ganciclovir" }
      ],
      nursing: [
        { action: "Neutropenic precautions / reverse isolation", freq: "Continuous", notes: "N95 mask for visitors, no fresh flowers or raw foods, HEPA-filtered room preferred" },
        { action: "Vital signs + temp", freq: "Q4h — Q2h if febrile", notes: "Temp ≥38.3°C → cultures within 15 min, antibiotics within 60 min" },
        { action: "Central line care (PICC / Hickman)", freq: "Daily dressing change per protocol", notes: "CLABSIs are life-threatening in neutropenic patients" },
        { action: "Platelet transfusion monitoring", freq: "Post-transfusion count 1h after", notes: "Poor increment (<10k rise) = platelet refractoriness → HLA-matched platelets" }
      ]
    },
    decisionBranches: [
      {
        condition: "Febrile neutropenia not responding to 72h of empiric Pip-Tazo",
        action: "Add Vancomycin 25 mg/kg IV Q12h. Add Micafungin 100 mg IV daily. Pan-culture (blood × 2, urine, BAL if respiratory).",
        escalation: "Septic shock → ICU transfer, norepinephrine, infectious disease consult STAT"
      },
      {
        condition: "PLT <10k/μL or active bleeding with PLT <50k/μL",
        action: "Transfuse 1 apheresis platelet unit. Recheck count 1h post-transfusion. If poor increment → request HLA-matched platelets.",
        escalation: "Intracranial hemorrhage → neurosurgery consult, emergency platelets × 2 units"
      }
    ]
  },

  {
    id: "engraftment",
    dayLabel: "Day +15–+21",
    dayNum: 15,
    phase: "engraftment",
    phaseColor: "#d97706",
    icon: "📈",
    summary: "Engraftment Window — ANC recovery expected",
    drugs: [],
    ctcaeWatch: [
      { organ: "Hematologic", key: "hematologic" }
    ],
    orderSet: {
      ivMeds: [
        { drug: "Filgrastim (G-CSF)", dose: "5 mcg/kg", freq: "SQ daily — discontinue when ANC >1000 × 3 consecutive days", indication: "Continue until engraftment confirmed" }
      ],
      poMeds: [
        { drug: "Acyclovir", dose: "400 mg", freq: "PO BID — continue until Day +100", indication: "Viral prophylaxis during immunocompromised period" },
        { drug: "Fluconazole", dose: "200 mg", freq: "PO daily — continue until Day +75", indication: "Antifungal prophylaxis" },
        { drug: "Levofloxacin", dose: "500 mg", freq: "PO daily — discontinue when ANC >500 × 2 days", indication: "Bacterial prophylaxis — taper as ANC recovers" }
      ],
      labs: [
        { test: "CBC with differential", freq: "Daily", threshold: "ANC ≥500 × 3 days = neutrophil engraftment; ≥1000 = discontinue G-CSF" },
        { test: "CMP", freq: "Every other day", threshold: "Renal recovery from Melphalan — trending CrCl" },
        { test: "Reticulocyte count", freq: "Every 3 days", threshold: "Rising reticulocytes = early erythroid engraftment" }
      ],
      nursing: [
        { action: "Daily ANC trend reporting", freq: "Report each AM CBC to physician", notes: "Document exact day ANC first exceeds 500 — this is the neutrophil engraftment date" },
        { action: "Infection precautions — progressive relaxation", freq: "Reassess daily as ANC rises", notes: "Once ANC >500 stable → remove reverse isolation, allow fresh foods" },
        { action: "Discharge planning initiation", freq: "Once ANC consistently rising", notes: "Social work, home nursing, outpatient follow-up scheduling" }
      ]
    },
    decisionBranches: [
      {
        condition: "ANC fails to reach ≥500 cells/μL by Day +21",
        action: "Graft failure evaluation: bone marrow biopsy. Donor chimerism testing. Increase G-CSF to 10 mcg/kg. MDT urgent review.",
        escalation: "Primary graft failure confirmed → second transplant evaluation, HLA registry contact"
      },
      {
        condition: "Engraftment syndrome (fever, rash, pulmonary infiltrates with rising ANC)",
        action: "Methylprednisolone 1 mg/kg IV Q12h × 3 days (rapid taper). Continue G-CSF. Pulmonology consult.",
        escalation: "Respiratory failure from engraftment syndrome → ICU, high-dose methylprednisolone 2 mg/kg"
      }
    ]
  },

  {
    id: "recovery",
    dayLabel: "Day +22–+30",
    dayNum: 22,
    phase: "recovery",
    phaseColor: "#16a34a",
    icon: "✅",
    summary: "Recovery — Discharge planning, outpatient transition",
    drugs: [],
    ctcaeWatch: [],
    orderSet: {
      ivMeds: [],
      poMeds: [
        { drug: "Acyclovir", dose: "400 mg", freq: "PO BID — continue until Day +100", indication: "Outpatient viral prophylaxis" },
        { drug: "Fluconazole", dose: "200 mg", freq: "PO daily — continue until Day +75", indication: "Outpatient antifungal prophylaxis" },
        { drug: "TMP-SMX (Bactrim DS)", dose: "1 DS tab", freq: "PO BID 3× per week — start when ANC >500", indication: "PCP pneumonia prophylaxis" }
      ],
      labs: [
        { test: "CBC with differential", freq: "Twice weekly outpatient", threshold: "Confirm sustained engraftment — PLT >20k for safe discharge" },
        { test: "CMP", freq: "Weekly outpatient", threshold: "GFR / creatinine — long-term Melphalan renal impact tracking" },
        { test: "PFT (DLCO)", freq: "Schedule at Day +100", threshold: "DLCO at Day +100 vs baseline — BCNU late lung toxicity benchmark" }
      ],
      nursing: [
        { action: "Discharge education", freq: "Before discharge", notes: "Infection precautions, when to call clinic, medication schedule, dietary restrictions" },
        { action: "Outpatient lab schedule", freq: "Handed off at discharge", notes: "Patient must understand CBC monitoring schedule — missed labs = safety risk" },
        { action: "Follow-up appointment confirmation", freq: "Before discharge", notes: "Day +30 clinic, Day +100 clinic, and Day +365 late-effects review" }
      ]
    },
    decisionBranches: [
      {
        condition: "PLT <20k/μL at Day +28 preventing safe discharge",
        action: "Delay discharge. Outpatient platelet transfusion support if otherwise stable. Graft failure workup if PLT not rising.",
        escalation: "Persistent thrombocytopenia with no recovery trend → bone marrow biopsy"
      },
      {
        condition: "New fever or infection signs during recovery phase",
        action: "Return to hospital for evaluation. Blood cultures × 2. Do not delay — immune recovery is incomplete.",
        escalation: "Sepsis presentation → emergency readmission, empiric broad-spectrum antibiotics"
      }
    ]
  }
];

// --- 9.2  Dynamic CTCAE grading ---
function getCtcaeGrade(organKey) {
  const lngDmg = parseFloat((sandboxState.bsa * 4.5 * (75 / sandboxState.dlco) * 0.07).toFixed(2));
  const renStr = parseFloat((sandboxState.bsa * 8.2 * (80 / sandboxState.crcl)).toFixed(2));
  const cardSc = (75 - sandboxState.lvef) * 0.05 + sandboxState.hct_ci * 0.1;
  const cnsSc  = sandboxState.age * 0.01 + sandboxState.bsa * 0.15;
  const hepSc  = sandboxState.chemo_lines * 0.2 + sandboxState.hct_ci * 0.1;
  const g = (score, t) => score < t[0] ? 1 : score < t[1] ? 2 : score < t[2] ? 3 : 4;
  switch (organKey) {
    case "pulmonary":   return g(lngDmg, [0.2, 0.4, 0.6]);
    case "renal":       return g(renStr, [1.0, 2.0, 3.0]);
    case "cardiac":     return g(cardSc, [0.5, 0.9, 1.4]);
    case "cns":         return g(cnsSc,  [0.6, 0.9, 1.1]);
    case "hepatic":     return g(hepSc,  [0.5, 0.9, 1.3]);
    case "hematologic": return sandboxState.cd34 < 2.5 ? 4 : sandboxState.cd34 < 3.5 ? 3 : 2;
    case "mucositis":   return sandboxState.chemo_lines >= 4 ? 3 : sandboxState.chemo_lines >= 3 ? 2 : 1;
    case "infection":   return sandboxState.infection ? 4 : sandboxState.cd34 < 2.5 ? 3 : 2;
    default: return 1;
  }
}

function ctcaeColor(g) {
  return g >= 4 ? "#dc2626" : g === 3 ? "#ea580c" : g === 2 ? "#d97706" : "#16a34a";
}

function ctcaeLabel(g) {
  return g >= 4 ? "Grade 4 — Life-threatening" : g === 3 ? "Grade 3 — Severe" : g === 2 ? "Grade 2 — Moderate" : "Grade 1 — Mild";
}

// --- 9.3  Render rail ---
function renderProtocolTimeline() {
  const rail = document.getElementById("timeline-rail");
  if (!rail) return;
  rail.innerHTML = "";

  protocolNodes.forEach(node => {
    const el = document.createElement("div");
    el.className = `tnode phase-${node.phase}${activeProtocolNodeId === node.id ? " tnode-active" : ""}`;
    el.setAttribute("data-node-id", node.id);

    const drugLine = node.drugs.length
      ? node.drugs.map(d => d.name).join(" + ")
      : "Monitoring / Support";

    el.innerHTML = `
      <div class="tnode-day" style="background:${node.phaseColor}">${node.dayLabel}</div>
      <div class="tnode-icon">${node.icon}</div>
      <div class="tnode-drug">${drugLine}</div>
    `;
    el.addEventListener("click", () => toggleProtocolNode(node.id));
    rail.appendChild(el);
  });

  if (activeProtocolNodeId) renderNodeDetail(activeProtocolNodeId);
  updateMiniBEAMVisibility();
}

function toggleProtocolNode(nodeId) {
  if (activeProtocolNodeId === nodeId) {
    activeProtocolNodeId = null;
    const panel = document.getElementById("timeline-detail-panel");
    if (panel) panel.style.display = "none";
  } else {
    activeProtocolNodeId = nodeId;
  }
  renderProtocolTimeline();
}

// --- 9.4  Render expanded detail panel ---
function renderNodeDetail(nodeId) {
  const node = protocolNodes.find(n => n.id === nodeId);
  if (!node) return;
  const panel = document.getElementById("timeline-detail-panel");
  if (!panel) return;
  panel.style.display = "block";

  // Drugs section
  const drugsHtml = node.drugs.length ? `
    <div class="dp-section">
      <div class="dp-section-title">Chemotherapy / Treatment</div>
      ${node.drugs.map(d => `
        <div class="dp-drug-row">
          <span class="dp-drug-dot" style="background:${d.color}"></span>
          <div><strong>${d.name}</strong> — ${d.dose} · ${d.route} · ${d.duration}</div>
        </div>`).join("")}
    </div>` : "";

  // CTCAE section
  const ctcaeHtml = node.ctcaeWatch.length ? `
    <div class="dp-section">
      <div class="dp-section-title">Expected Toxicity — CTCAE (Patient-Specific)</div>
      <div class="ctcae-grid">
        ${node.ctcaeWatch.map(w => {
          const grade = getCtcaeGrade(w.key);
          const col   = ctcaeColor(grade);
          const lbl   = ctcaeLabel(grade);
          return `<div class="ctcae-item" style="border-left:3px solid ${col}">
            <div class="ctcae-organ">${w.organ}</div>
            <div class="ctcae-grade" style="color:${col}">${lbl}</div>
          </div>`;
        }).join("")}
      </div>
    </div>` : "";

  // Order set
  const os = node.orderSet;
  const li = (items, type) => {
    if (!items || !items.length) return "";
    return items.map(it => {
      if (type === "labs")    return `<li><strong>${it.test}</strong> — ${it.freq} <span class="order-threshold">${it.threshold}</span></li>`;
      if (type === "nursing") return `<li><strong>${it.action}</strong> (${it.freq}) — <em>${it.notes}</em></li>`;
      return `<li><strong>${it.drug}</strong> ${it.dose || ""} — ${it.freq || ""} <span class="order-indication">[${it.indication}]</span></li>`;
    }).join("");
  };

  const orderHtml = `
    <div class="dp-section">
      <div class="dp-section-title">
        Order Set
        <button class="btn btn-secondary btn-sm" onclick="printDayOrders('${nodeId}')">🖨️ Print ${node.dayLabel} Orders</button>
      </div>
      <div class="order-set-grid">
        ${os.ivMeds && os.ivMeds.length ? `<div class="order-cat"><div class="order-cat-hdr iv-hdr">IV Medications</div><ul class="order-list">${li(os.ivMeds, "iv")}</ul></div>` : ""}
        ${os.poMeds && os.poMeds.length ? `<div class="order-cat"><div class="order-cat-hdr po-hdr">PO Medications</div><ul class="order-list">${li(os.poMeds, "po")}</ul></div>` : ""}
        ${os.labs  && os.labs.length  ? `<div class="order-cat"><div class="order-cat-hdr lab-hdr">Laboratory Orders</div><ul class="order-list">${li(os.labs, "labs")}</ul></div>` : ""}
        ${os.nursing && os.nursing.length ? `<div class="order-cat"><div class="order-cat-hdr nsg-hdr">Nursing Orders</div><ul class="order-list">${li(os.nursing, "nursing")}</ul></div>` : ""}
      </div>
    </div>`;

  // Decision branches
  const branchHtml = node.decisionBranches && node.decisionBranches.length ? `
    <div class="dp-section">
      <div class="dp-section-title">Clinical Decision Branches</div>
      ${node.decisionBranches.map(b => `
        <div class="branch-item">
          <div class="branch-row if-row"><span class="branch-lbl if-lbl">IF</span>${b.condition}</div>
          <div class="branch-row then-row"><span class="branch-lbl then-lbl">THEN</span>${b.action}</div>
          <div class="branch-row esc-row"><span class="branch-lbl esc-lbl">ESCALATE</span>${b.escalation}</div>
        </div>`).join("")}
    </div>` : "";

  panel.innerHTML = `
    <div class="dp-header" style="border-left:4px solid ${node.phaseColor}">
      <div>
        <span class="dp-day-badge" style="background:${node.phaseColor}">${node.dayLabel}</span>
        <strong style="margin-left:10px">${node.summary}</strong>
      </div>
      <button class="btn btn-icon" onclick="toggleProtocolNode('${nodeId}')">✕</button>
    </div>
    <div class="dp-body">
      ${drugsHtml}${ctcaeHtml}${orderHtml}${branchHtml}
    </div>`;

  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// --- 9.5  Print day orders ---
function printDayOrders(nodeId) {
  const node = protocolNodes.find(n => n.id === nodeId);
  if (!node) return;
  const os = node.orderSet;

  const pl = (items, type) => {
    if (!items || !items.length) return "<li><em>None</em></li>";
    return items.map(it => {
      if (type === "labs")    return `<li>${it.test} — ${it.freq} (${it.threshold})</li>`;
      if (type === "nursing") return `<li>${it.action} (${it.freq}): ${it.notes}</li>`;
      return `<li>${it.drug} ${it.dose || ""} — ${it.freq || ""} [${it.indication}]</li>`;
    }).join("");
  };

  const win = window.open("", "_blank");
  win.document.write(`<!DOCTYPE html><html><head>
    <title>BEAM — ${node.dayLabel} Orders</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:12px;margin:20mm;color:#000}
      h1{font-size:16px;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:14px}
      h2{font-size:12px;margin-top:16px;background:#f0f0f0;padding:4px 8px;border-left:3px solid #555}
      ul{margin:6px 0 12px 20px}li{margin-bottom:4px;line-height:1.5}
      .meta{font-size:11px;margin-bottom:14px;line-height:2}
      .sig{margin-top:30px;border-top:1px solid #000;width:220px;padding-top:4px;font-size:11px}
      .footer{margin-top:40px;border-top:1px solid #ccc;padding-top:8px;font-size:9px;color:#666}
      @media print{body{margin:10mm}}
    </style></head><body>
    <h1>BEAM Protocol — ${node.dayLabel} Order Set</h1>
    <div class="meta">
      <strong>Patient:</strong> _________________________ &nbsp; <strong>MRN:</strong> _____________<br>
      <strong>Date:</strong> ${new Date().toLocaleDateString()} &nbsp; <strong>Weight:</strong> _______ kg &nbsp; <strong>BSA:</strong> ${sandboxState.bsa} m²<br>
      <strong>Treatment Day:</strong> ${node.dayLabel} — ${node.summary}
    </div>
    ${os.ivMeds && os.ivMeds.length ? `<h2>IV Medications</h2><ul>${pl(os.ivMeds, "iv")}</ul>` : ""}
    ${os.poMeds && os.poMeds.length ? `<h2>PO / Oral Medications</h2><ul>${pl(os.poMeds, "po")}</ul>` : ""}
    ${os.labs && os.labs.length   ? `<h2>Laboratory Orders</h2><ul>${pl(os.labs, "labs")}</ul>` : ""}
    ${os.nursing && os.nursing.length ? `<h2>Nursing Orders</h2><ul>${pl(os.nursing, "nursing")}</ul>` : ""}
    <div class="sig">Physician Signature</div>
    <div class="footer">
      Generated by BEAM Pipeline 3 — ${new Date().toLocaleString()}<br>
      This is a simulation tool. All orders require physician review and validation before clinical use.
    </div>
  </body></html>`);
  win.document.close();
  win.print();
}

// --- 9.6  Mini-BEAM alternative pathway ---
function updateMiniBEAMVisibility() {
  const section = document.getElementById("mini-beam-section");
  if (!section) return;

  let excludeCount = 0, holdCount = 0;
  if (sandboxState.ecog >= 3)      excludeCount++;
  if (sandboxState.lvef < 45)      excludeCount++;
  if (sandboxState.dlco < 50)      excludeCount++;
  if (sandboxState.crcl < 40)      excludeCount++;
  if (sandboxState.infection)      excludeCount++;
  if (sandboxState.cd34 < 2.0)     excludeCount++;
  if (sandboxState.salvage_days < 21) holdCount++;

  const shap = {
    inf:  sandboxState.infection ? -8.0 : 0,
    lvef: sandboxState.lvef < 45 ? -5.0 : sandboxState.lvef < 50 ? -1.2 : 0.2,
    dlco: sandboxState.dlco < 50 ? -5.0 : sandboxState.dlco < 60 ? -1.5 : 0.3,
    crcl: sandboxState.crcl < 40 ? -4.5 : sandboxState.crcl < 55 ? -1.0 : 0.4,
    ecog: sandboxState.ecog >= 3  ? -6.0 : sandboxState.ecog === 2 ? -1.5 : 0.3,
    cd34: sandboxState.cd34 < 2.0 ? -4.0 : sandboxState.cd34 < 3.0 ? -1.1 : 0.5,
    hci:  sandboxState.hct_ci >= 4 ? -2.2 : sandboxState.hct_ci >= 3 ? -1.0 : 0.2,
    pri:  sandboxState.chemo_lines >= 4 ? -1.8 : sandboxState.chemo_lines === 3 ? -0.8 : 0.3
  };
  const prob = 1 / (1 + Math.exp(-(1.6 + Object.values(shap).reduce((a, b) => a + b, 0))));
  const verdict = excludeCount > 0 ? "EXCLUDE" : (holdCount > 0 || prob < 0.70) ? "HOLD" : "GO";

  if (verdict === "GO") { section.style.display = "none"; return; }

  section.style.display = "block";
  const body = document.getElementById("mini-beam-body");
  if (!body) return;

  const renalStd   = (sandboxState.bsa * 8.2 * (80 / sandboxState.crcl)).toFixed(1);
  const renalMini  = (sandboxState.bsa * 8.2 * (80 / sandboxState.crcl) * 0.21).toFixed(1);

  const rationale = [
    sandboxState.dlco < 60      && `DLCO ${sandboxState.dlco}% — reduced BCNU (60 mg/m²) lowers pulmonary toxicity risk`,
    sandboxState.crcl < 60      && `CrCl ${sandboxState.crcl} mL/min — Melphalan renal stress reduced from ${renalStd} → ~${renalMini}`,
    sandboxState.ecog >= 2      && `ECOG ${sandboxState.ecog} — reduced-intensity conditioning better tolerated`,
    sandboxState.hct_ci >= 3    && `HCT-CI ${sandboxState.hct_ci} — significant comorbidity burden supports dose reduction`,
    sandboxState.age > 65       && `Age ${sandboxState.age} — age-adjusted organ reserve favors reduced intensity`,
    "MDT review required before proceeding — confirm Mini-BEAM eligibility"
  ].filter(Boolean);

  body.innerHTML = `
    <div class="mb-intro">
      Verdict is <strong>${verdict}</strong>. Standard myeloablative BEAM not recommended.
      Mini-BEAM applies ~80% dose reduction to preserve disease control while reducing treatment-related mortality risk.
    </div>
    <div class="mb-compare">
      <div class="mb-col">
        <div class="mb-col-hdr excluded-hdr">Standard BEAM (${verdict})</div>
        <div class="mb-col-body">
          <div class="mb-row"><strong>BCNU:</strong> 300 mg/m² Day −6</div>
          <div class="mb-row"><strong>Etoposide:</strong> 200 mg/m²/day × Days −5 to −2</div>
          <div class="mb-row"><strong>Ara-C:</strong> 400 mg/m²/day × Days −5 to −2</div>
          <div class="mb-row"><strong>Melphalan:</strong> 140 mg/m² Day −1</div>
          <div class="mb-row mb-note">TRM risk: ~3–8% (fit patients)</div>
        </div>
      </div>
      <div class="mb-arrow">→</div>
      <div class="mb-col">
        <div class="mb-col-hdr alt-hdr">Mini-BEAM (Alternative)</div>
        <div class="mb-col-body">
          <div class="mb-row"><strong>BCNU:</strong> 60 mg/m² Day −5</div>
          <div class="mb-row"><strong>Etoposide:</strong> 75 mg/m²/day × Days −4 to −1</div>
          <div class="mb-row"><strong>Ara-C:</strong> 100 mg/m²/12h × 8 doses</div>
          <div class="mb-row"><strong>Melphalan:</strong> 30 mg/m² Day −1</div>
          <div class="mb-row mb-note">Non-myeloablative intent</div>
        </div>
      </div>
    </div>
    <div class="mb-rationale">
      <strong>Rationale for this patient:</strong>
      <ul>${rationale.map(r => `<li>${r}</li>`).join("")}</ul>
    </div>`;
}



