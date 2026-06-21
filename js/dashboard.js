/* ============================================================
   DASHBOARD POPULATE — single-patient framing
   Fills Dashboard, Patient Registry, Treatment/Care Plans,
   Timeline, Patient Card, and Analytics tabs from the shared
   window.PATIENT_DATA record.
   Depends on Chart.js (CDN). Lazy-renders charts per tab.
   ============================================================ */

(function () {
  "use strict";

  const D = window.PATIENT_DATA;
  if (!D) return;

  const GRAY = "#5a5a5a";
  const GRAYS = ["#4a4a4a", "#6b6b6b", "#888", "#a3a3a3", "#b0b0b0", "#c4c4c4", "#787878", "#9a9a9a"];
  const FLAG_RED = "#b04a4a";

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function setText(id, text) { const n = $(id); if (n) n.textContent = text; }

  // ── DASHBOARD ───────────────────────────────────────────────
  function renderDashboard() {
    setText("kpi-total-patients", "1");
    setText("kpi-active-treatments", String(D.stats.activeMeds));
    setText("kpi-pending-results", String(D.stats.labsFlagged));
    setText("kpi-appointments", String(D.stats.episodes));

    // Problems by body system (bar)
    const bySystem = {};
    D.activeConditions.forEach(function (c) {
      bySystem[c.system] = (bySystem[c.system] || 0) + 1;
    });
    makeChart("chart-problems", "bar", {
      labels: Object.keys(bySystem),
      datasets: [{ data: Object.values(bySystem), backgroundColor: GRAY, borderRadius: 4 }],
    }, { plugins: { legend: { display: false } }, scales: { y: { ticks: { stepSize: 1 } } } });

    // Lab status donut (in-range vs flagged)
    const flagged = D.stats.labsFlagged;
    const inRange = D.stats.labsTracked - flagged;
    makeChart("chart-labstatus", "doughnut", {
      labels: ["In range", "Out of range"],
      datasets: [{ data: [inRange, flagged], backgroundColor: [GRAY, FLAG_RED] }],
    }, { plugins: { legend: { position: "bottom" } } });

    // Encounters per year (line)
    const byYear = {};
    D.episodes.forEach(function (e) {
      const y = e.start.slice(0, 4);
      byYear[y] = (byYear[y] || 0) + 1;
    });
    const years = Object.keys(byYear).sort();
    makeChart("chart-encounters", "line", {
      labels: years,
      datasets: [{ data: years.map(function (y) { return byYear[y]; }), borderColor: GRAY, backgroundColor: "rgba(90,90,90,0.1)", fill: true, tension: 0.3 }],
    }, { plugins: { legend: { display: false } }, scales: { y: { ticks: { stepSize: 1 } } } });

    // Recent activity feed
    const feed = $("dash-activity");
    if (feed) {
      feed.innerHTML = "";
      D.episodes.slice().reverse().slice(0, 6).forEach(function (e) {
        const row = el("div", "activity-item");
        row.appendChild(el("span", "activity-item__date", fmt(e.start)));
        row.appendChild(el("span", "activity-item__text", e.title));
        feed.appendChild(row);
      });
    }
  }

  // ── PATIENT REGISTRY (one real patient) ─────────────────────
  function renderRegistry() {
    const tbody = $("registry-tbody");
    if (!tbody) return;
    const p = D.demographics;
    tbody.innerHTML = "";
    const tr = el("tr");
    const primaryDx = D.activeConditions[0].name;
    const cells = [
      "1", p.name, p.mrn, p.age + " / " + p.sex.charAt(0),
      primaryDx, "—", "Michael Rubin",
      D.stats.activeMeds + " meds", p.firstVisit || D.stats.firstVisit,
    ];
    cells.forEach(function (c) { tr.appendChild(el("td", null, c)); });
    const statusTd = el("td");
    statusTd.appendChild(el("span", "badge badge--active", p.status));
    tr.appendChild(statusTd);
    tbody.appendChild(tr);
  }

  // ── CARE / TREATMENT PLANS (medications + procedures) ───────
  function renderTreatments() {
    setText("tx-active", String(D.medications.filter(function (m) { return m.status === "Active"; }).length));
    setText("tx-completed", "1"); // appendectomy
    setText("tx-scheduled", "0");

    const tbody = $("treatments-tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    D.medications.forEach(function (m, i) {
      const tr = el("tr");
      const cells = [
        "RX-" + String(i + 1).padStart(2, "0"),
        D.demographics.name, m.category, m.name,
        m.started, "Ongoing", m.dose,
      ];
      cells.forEach(function (c) { tr.appendChild(el("td", null, c)); });
      const st = el("td");
      st.appendChild(el("span", "badge badge--active", "Active"));
      tr.appendChild(st);
      tbody.appendChild(tr);
    });
    // Add the appendectomy as a completed procedure row.
    const proc = el("tr");
    ["PR-01", D.demographics.name, "Surgical Procedure", "Appendectomy", "10/13/2025", "10/23/2025", "1 / 1"].forEach(function (c) {
      proc.appendChild(el("td", null, c));
    });
    const st = el("td");
    st.appendChild(el("span", "badge badge--completed", "Completed"));
    proc.appendChild(st);
    tbody.appendChild(proc);
  }

  // ── TIMELINE (episodes as bars on a shared date axis) ───────
  function renderTimeline() {
    const wrap = $("timeline-rows");
    if (!wrap) return;
    wrap.innerHTML = "";

    const TYPE_COLOR = {
      "Inpatient": "#4a4a4a", "Outpatient": "#d0d0d0",
      "Surgical Procedure": "#5e5e5e", "MRI / CT scan": "#c4c4c4",
      "Chemotherapy": "#6b6b6b",
    };

    // Date range across all episodes.
    const times = D.episodes.map(function (e) { return new Date(e.start).getTime(); })
      .concat(D.episodes.map(function (e) { return new Date(e.end).getTime(); }));
    let min = Math.min.apply(null, times);
    let max = Math.max.apply(null, times);
    const span = (max - min) || 1;

    D.episodes.forEach(function (e, i) {
      const row = el("div", "timeline-row");
      row.appendChild(el("span", "timeline-row__label", (i + 1) + ". " + e.doctor + " · " + e.specialty));
      const track = el("div", "timeline-row__track timeline-row__track--filled");
      const s = new Date(e.start).getTime();
      const en = new Date(e.end).getTime();
      const leftPct = ((s - min) / span) * 100;
      const widthPct = Math.max(2, ((en - s) / span) * 100);
      const bar = el("div", "timeline-bar");
      bar.style.left = leftPct + "%";
      bar.style.width = widthPct + "%";
      bar.style.background = TYPE_COLOR[e.type] || "#888";
      bar.title = e.title + "  (" + fmt(e.start) + (e.end !== e.start ? " → " + fmt(e.end) : "") + ")";
      bar.appendChild(el("span", "timeline-bar__label", e.title));
      track.appendChild(bar);
      row.appendChild(track);
      wrap.appendChild(row);
    });

    // Axis with year ticks.
    const axis = $("timeline-axis");
    if (axis) {
      axis.innerHTML = "";
      const startY = new Date(min).getFullYear();
      const endY = new Date(max).getFullYear();
      for (let y = startY; y <= endY; y++) {
        const t = new Date(y + "-01-01").getTime();
        const pct = Math.max(0, Math.min(100, ((t - min) / span) * 100));
        const tick = el("span", "timeline-axis__tick", String(y));
        tick.style.left = pct + "%";
        axis.appendChild(tick);
      }
    }
  }

  // ── PATIENT CARD ────────────────────────────────────────────
  function renderPatientCard() {
    const p = D.demographics;
    setHTML("pc-name", p.name);
    setHTML("pc-line1", "MRN: " + p.mrn + "  |  Age: " + p.age + "  |  Sex: " + p.sex);
    setHTML("pc-line2", "Primary: " + D.activeConditions[0].name + "  |  Active problems: " + D.stats.activeProblems);
    setHTML("pc-line3", "Care team: " + D.careTeam[0].name + " (" + D.careTeam[0].specialty + ")");
    setHTML("pc-line4", "First visit: " + D.stats.firstVisit + "  |  Last visit: " + D.stats.lastVisit);
    setText("pc-avatar", p.initials);

    // Diagnosis & history list
    const hist = $("pc-history");
    if (hist) {
      hist.innerHTML = "";
      D.activeConditions.forEach(function (c) {
        const r = el("div", "pc-list-row");
        r.appendChild(el("span", "pc-list-row__main", c.name));
        r.appendChild(el("span", "pc-list-row__sub", c.system + " · noted " + c.noted));
        hist.appendChild(r);
      });
    }

    // Care-team / referral network
    const net = $("pc-network");
    if (net) {
      net.innerHTML = "";
      D.careTeam.forEach(function (m) {
        const r = el("div", "pc-list-row");
        r.appendChild(el("span", "pc-list-row__main", m.name));
        r.appendChild(el("span", "pc-list-row__sub", m.specialty + " · " + m.note));
        net.appendChild(r);
      });
    }

    // Conditions-by-system mini chart
    const bySystem = {};
    D.activeConditions.forEach(function (c) { bySystem[c.system] = (bySystem[c.system] || 0) + 1; });
    makeChart("chart-pc-systems", "bar", {
      labels: Object.keys(bySystem),
      datasets: [{ data: Object.values(bySystem), backgroundColor: GRAYS, borderRadius: 4 }],
    }, { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { ticks: { stepSize: 1 } } } });

    // Admissions sub-table from episodes.
    const tb = $("pc-admissions");
    if (tb) {
      tb.innerHTML = "";
      D.episodes.forEach(function (e) {
        const tr = el("tr");
        [fmt(e.start), e.end !== e.start ? fmt(e.end) : "—", e.title, e.risk, "—", e.stage, e.doctor, e.specialty]
          .forEach(function (c) { tr.appendChild(el("td", null, c)); });
        tb.appendChild(tr);
      });
    }
  }

  // ── ANALYTICS ───────────────────────────────────────────────
  function renderAnalytics() {
    setText("an-survival", "—");
    setText("an-duration", yearsBetween(D.stats.firstVisit, D.stats.lastVisit));
    setText("an-readmission", String(D.episodes.filter(function (e) { return e.type === "Inpatient"; }).length));
    setText("an-cost", String(D.stats.totalLabsOnFile));

    // Lab values vs midpoint of range (outcomes-ish)
    makeChart("chart-an-labs", "bar", {
      labels: D.labs.map(function (l) { return l.flag ? l.name + " (" + l.flag + ")" : l.name; }),
      datasets: [{
        data: D.labs.map(function (l) {
          const span = (l.high - l.low) || 1;
          return Math.round(((l.value - l.low) / span) * 100);
        }),
        backgroundColor: D.labs.map(function (l) { return l.flag ? FLAG_RED : GRAY; }),
        borderRadius: 4,
      }],
    }, { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { min: -20, max: 120 } } });

    // Demographics / problems-by-system donut
    const bySystem = {};
    D.activeConditions.forEach(function (c) { bySystem[c.system] = (bySystem[c.system] || 0) + 1; });
    makeChart("chart-an-demo", "doughnut", {
      labels: Object.keys(bySystem),
      datasets: [{ data: Object.values(bySystem), backgroundColor: GRAYS }],
    }, { plugins: { legend: { position: "right" } } });

    // Encounters trend
    const byYear = {};
    D.episodes.forEach(function (e) { const y = e.start.slice(0, 4); byYear[y] = (byYear[y] || 0) + 1; });
    const years = Object.keys(byYear).sort();
    makeChart("chart-an-trend", "line", {
      labels: years,
      datasets: [{ data: years.map(function (y) { return byYear[y]; }), borderColor: GRAY, backgroundColor: "rgba(90,90,90,0.1)", fill: true, tension: 0.3 }],
    }, { plugins: { legend: { display: false } }, scales: { y: { ticks: { stepSize: 1 } } } });

    // Conditions by year (noted)
    const condYear = {};
    D.activeConditions.forEach(function (c) {
      const y = c.noted.slice(-4); condYear[y] = (condYear[y] || 0) + 1;
    });
    const cy = Object.keys(condYear).sort();
    makeChart("chart-an-cost", "bar", {
      labels: cy,
      datasets: [{ data: cy.map(function (y) { return condYear[y]; }), backgroundColor: GRAY, borderRadius: 4 }],
    }, { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { ticks: { stepSize: 1 } } } });
  }

  // ── HELPERS ─────────────────────────────────────────────────
  function setHTML(id, html) { const n = $(id); if (n) n.innerHTML = html; }

  function fmt(iso) {
    // Parse as local (not UTC) to avoid an off-by-one day when rendering.
    const parts = iso.split("-");
    if (parts.length !== 3) return iso;
    const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function yearsBetween(a, b) {
    const da = new Date(a), db = new Date(b);
    const months = Math.round((db - da) / (1000 * 60 * 60 * 24 * 30.4));
    return months + " mo";
  }

  const charts = {};
  function makeChart(canvasId, type, data, options) {
    const c = $(canvasId);
    if (!c || typeof Chart === "undefined") return;
    if (charts[canvasId]) return; // render once
    charts[canvasId] = new Chart(c.getContext("2d"), {
      type: type,
      data: data,
      options: Object.assign({ responsive: true, maintainAspectRatio: false }, options || {}),
    });
  }

  // ── LAZY RENDER PER TAB ─────────────────────────────────────
  const RENDERERS = {
    "dashboard": renderDashboard,
    "patients": renderRegistry,
    "treatments": renderTreatments,
    "timeline": renderTimeline,
    "patient-card": renderPatientCard,
    "analytics": renderAnalytics,
  };
  const done = {};

  function renderTab(tabId) {
    if (done[tabId] || !RENDERERS[tabId]) return;
    done[tabId] = true;
    RENDERERS[tabId]();
  }

  function activeTabFromDOM() {
    const panel = document.querySelector(".tab-panel.active");
    if (!panel) return null;
    return panel.id.replace("panel-", "");
  }

  document.addEventListener("DOMContentLoaded", function () {
    renderTab(activeTabFromDOM() || "dashboard");
  });
  document.querySelectorAll("[data-tab]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      setTimeout(function () { renderTab(btn.dataset.tab); }, 30);
    });
  });
  window.addEventListener("hashchange", function () {
    const id = window.location.hash.replace("#", "");
    setTimeout(function () { renderTab(id); }, 30);
  });
})();
