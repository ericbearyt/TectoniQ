import urllib.request
import json
import os

print("Downloading medical wordlist...")
url_medical = "https://raw.githubusercontent.com/glutanimate/wordlist-medicalterms-en/master/wordlist.txt"
try:
    response = urllib.request.urlopen(url_medical)
    medical_words = response.read().decode('utf-8').splitlines()
    print(f"Downloaded {len(medical_words)} medical terms.")
except Exception as e:
    print(f"Error downloading medical words: {e}")
    medical_words = []

# For symptoms, allergies and common conditions, let's add a curated list manually to ensure high quality
# since we might not have a clean raw text API for everything instantly.
# We'll use the existing CLINICAL_KEYWORDS from keyterm_extractor as a base,
# then add massive lists of symptoms and allergies.

base_categories = {
    # Symptoms
    "symptom": ["chest pain", "palpitations", "dyspnea", "shortness of breath", "sob", "edema", "syncope", "cough", "wheezing", "headache", "dizziness", "nausea", "vomiting", "abdominal pain", "diarrhea", "back pain", "joint pain", "fever", "chills", "fatigue", "malaise", "sweating", "weight loss", "weight gain"],
    # Allergies
    "allergy": ["peanut allergy", "penicillin allergy", "sulfa allergy", "latex allergy", "dust allergy", "pollen allergy", "pet dander allergy", "shellfish allergy", "tree nut allergy", "milk allergy", "egg allergy", "soy allergy", "wheat allergy", "bee sting allergy", "nsaid allergy", "iodine allergy", "contrast dye allergy", "amoxicillin allergy", "aspirin allergy", "cat allergy", "dog allergy", "mold allergy"],
    # Conditions
    "condition": ["hypertension", "htn", "heart failure", "chf", "atrial fibrillation", "afib", "coronary artery disease", "cad", "myocardial infarction", "mi", "diabetes", "diabetes mellitus", "type 2 diabetes", "t2dm", "hyperlipidemia", "hypercholesterolemia", "obesity", "hypothyroidism", "hyperthyroidism", "asthma", "copd", "pneumonia", "bronchitis", "pulmonary embolism", "pe", "stroke", "cva", "tia", "seizure", "migraine", "depression", "anxiety", "dementia", "alzheimer", "chronic kidney disease", "ckd", "acute kidney injury", "aki", "cancer", "malignancy", "carcinoma", "lymphoma", "gerd", "reflux", "ibs", "crohn", "arthritis", "osteoporosis"],
    # Medications
    "medication": ["metformin", "lisinopril", "atorvastatin", "metoprolol", "aspirin", "warfarin", "insulin", "levothyroxine", "amlodipine", "omeprazole", "hydrochlorothiazide", "hctz", "ibuprofen", "acetaminophen", "amoxicillin", "azithromycin", "citalopram", "albuterol", "gabapentin", "sertraline", "losartan", "simvastatin", "pantoprazole"],
    # Findings
    "finding": ["proteinuria", "tumor", "anemia", "leukocytosis", "thrombocytopenia", "hyperglycemia", "hyponatremia", "hyperkalemia", "elevated creatinine", "elevated troponin"],
    # Procedures
    "procedure": ["echocardiogram", "ekg", "ecg", "colonoscopy", "endoscopy", "mri", "ct scan", "ultrasound", "x-ray", "biopsy", "surgery"]
}

final_dict = {}

# 1. Add general medical words (from the massive list)
# We will classify them generally as 'MedicalTerm' unless overriden.
for word in medical_words:
    word = word.strip().lower()
    if len(word) > 3: # Skip very short abbreviations to avoid noise
        final_dict[word] = "MedicalTerm"

# 2. Add base categories (these override general terms)
for cat, words in base_categories.items():
    for word in words:
        final_dict[word.lower()] = cat.capitalize()

output_path = "data/medical_terminology.json"
os.makedirs(os.path.dirname(output_path), exist_ok=True)
with open(output_path, "w") as f:
    json.dump(final_dict, f, indent=2)

print(f"Successfully generated {output_path} with {len(final_dict)} terms.")
