# Oncologist Dashboard

A modular, tab-based oncologist dashboard built as a responsive single-page web application. It features a collapsible sidebar, intuitive tabbed navigation, timeline visualizations, and detailed patient cards.

---

## Spin-Up Guide

### Step 1: Spin Up the TectoniQ Backend
If you want the dashboard to connect with your TectoniQ clinical data processing pipeline, start the backend server first.

1. Open a terminal and navigate to your `TectoniQ` project folder:
   ```bash
   cd /Users/ericnguyen/TectoniQ/backend
   ```
2. Activate your virtual environment and start the server:
   ```bash
   source .venv/bin/activate
   python app.py
   ```
   * The backend API will be running at: **[http://localhost:5050](http://localhost:5050)**

---

### Step 2: Spin Up the Dashboard Frontend
Serve the dashboard frontend assets using any local web server on port `3060`.

1. Open a new terminal window/tab and navigate to the dashboard directory:
   ```bash
   cd "/Users/ericnguyen/Oncologist Dashboard"
   ```
2. Start the local python web server:
   ```bash
   python3 -m http.server 3060
   ```
   *(Alternatively, you can use Node's static server: `npx -y serve -l 3060 .`)*

---

## Access the Dashboard

Once both servers are running, access the dashboard and API at:

* 🖥️ **Dashboard Frontend**: [http://localhost:3060](http://localhost:3060)
* ⚙️ **TectoniQ Backend API**: [http://localhost:5050](http://localhost:5050)
