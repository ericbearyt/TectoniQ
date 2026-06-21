# TectoniQ — Clinical Data Timeline Processor

> Parse PDF clinical documents into structured timelines, frequency maps, and AI-labelled clinical entities.

---

## What It Does

TectoniQ ingests a PDF clinical document (discharge summaries, progress notes, assessments) and runs it through a **3-worker pipeline**:

| Worker | Purpose |
|--------|---------|
| **Worker 1** | Extracts text, splits by section headers, tallies term frequency |
| **Worker 2** | Maps each term onto a 1D page/section timeline |
| **Worker 3** | Pipes top terms through the Gemini API for semantic clinical entity recognition |

The result is rendered in a dark-mode dashboard with:
- **Discovery Timeline** — terms plotted across document sections
- **Keyword Tree** — searchable grid of all clinical entities with badges
- **Export** — structured JSON or XML download

---

## Project Structure

```
TectoniQ/
├── index.html               ← Frontend entry point (open directly in browser)
├── style.css                ← Dark glassmorphism design system
├── app.js                   ← Frontend controller
├── demo/
│   └── sample_patient.json  ← Demo fixture (no PDF needed)
├── README.md
├── README_WORKERS.md        ← Worker pipeline deep-dive
└── backend/
    ├── app.py               ← Flask server (localhost:5000)
    ├── requirements.txt
    ├── .env.example
    └── workers/
        ├── worker1_frequency.py
        ├── worker2_timeline.py
        └── worker3_gemini_ner.py
```

---

## Prerequisites

- Python 3.10+
- A modern browser (Chrome, Firefox, Safari, Edge)
- A Gemini API key (optional — Worker 3 degrades gracefully without one)

---

## Quick Start

### 1 — Clone the repo

```bash
git clone <your-repo-url>
cd TectoniQ
```

### 2 — Set up the Python backend

```bash
cd backend

# Create and activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate      # macOS / Linux
# .venv\Scripts\activate       # Windows

# Install dependencies
pip install -r requirements.txt
```

### 3 — Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and add your Gemini API key:

```
GEMINI_API_KEY=your_key_here
```

> Worker 3 will skip Gemini NER and mark terms as `"unreviewed"` if the key is missing — the rest of the pipeline still works.

### 4 — Start the backend

```bash
python app.py
# → TectoniQ backend starting on http://localhost:5000
```

### 5 — Open the frontend

Open `index.html` directly in your browser (no build step required):

```bash
open ../index.html      # macOS
start ../index.html     # Windows
xdg-open ../index.html  # Linux
```

The sidebar status indicator will turn **green** once the frontend connects to the backend.

---

## Using the App

1. **Upload** — drag and drop a PDF, or click Browse
2. **Timeline** — explore terms plotted across sections; click any node for details
3. **Keywords** — search and filter all extracted clinical entities
4. **Export** — toggle JSON / XML, preview the output, download

### No PDF? Load the Demo

Click **"Load Demo Patient"** on the upload screen to see the app populated with a synthetic heart-failure patient case.

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/health` | Backend status + Gemini key check |
| `POST` | `/api/parse`  | Upload a PDF; returns structured JSON |

### Example

```bash
curl -X POST http://localhost:5000/api/parse \
  -F "file=@/path/to/your_document.pdf"
```

---

## Export Schema

See [README_WORKERS.md](./README_WORKERS.md) for the full output schema and worker contracts.

---

## Deploying to Vercel (Frontend)

The frontend is static HTML/CSS/JS — Vercel can serve it directly.

1. Push the repo to GitHub
2. Connect the repo to Vercel
3. Set the **Root Directory** to `/` (or wherever `index.html` lives)
4. Set **Output Directory** to `.` (no build step)
5. Update `BACKEND_URL` in `app.js` to point to your deployed Python backend URL

> The Python backend needs a separate host (e.g., [Railway](https://railway.app), [Render](https://render.com), or [Fly.io](https://fly.io)).

---

## License

MIT
