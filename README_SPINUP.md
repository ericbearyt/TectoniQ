# TectoniQ Spin-Up Procedure

This document provides step-by-step instructions on how to spin up the TectoniQ backend services and frontend application locally, along with the corresponding localhost URLs.

---

## Spin-Up Procedure

### Prerequisites
- **Python 3.10+**
- **Node.js** (for `npx` tool support)

---

### Step 1: Spin Up the Backend

1. **Navigate to the backend directory**:
   ```bash
   cd backend
   ```

2. **Set up a Python Virtual Environment**:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```

3. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure Environment Variables**:
   Create a `.env` file in the `backend/` directory:
   ```bash
   cp .env.example .env
   ```
   Open the `.env` file and enter your Gemini API key and port:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   FLASK_PORT=5050
   ```
   > *Note: If no Gemini API key is provided, the application will degrade gracefully and skip the AI-labelling step, while the rest of the parsing pipeline will run normally.*

5. **Start the Flask Backend Server**:
   ```bash
   python app.py
   ```
   The backend starts running at:
   - **Local Host URL**: `http://localhost:5050`

---

### Step 2: Spin Up the Frontend

Once the backend server is running and healthy, spin up the frontend server.

1. **Navigate to the project root directory**:
   ```bash
   cd ..
   ```

2. **Start the static file server**:
   Use `npx` to serve the static frontend assets on port `3050`:
   ```bash
   npx -y serve -l 3050 .
   ```
   The frontend starts running at:
   - **Local Host URL**: `http://localhost:3050`

---

### Alternative: Run Both Simultaneously

You can also spin up both servers in a single terminal window using the included startup shell script:

```bash
chmod +x start.sh
./start.sh
```

---

## Local Host Links

Once both steps are complete, you can access the services at:

* 💻 **Frontend Web App**: [http://localhost:3050](http://localhost:3050)
* 🧠 **Backend REST API**: [http://localhost:5050](http://localhost:5050) (Health Check: [http://localhost:5050/api/health](http://localhost:5050/api/health))
