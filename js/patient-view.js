/* ============================================================
   PATIENT VIEW — live demo data
   Data extracted (once) from My Health Summary_Redactedv2.pdf
   Renders demographics, conditions, medications, labs.
   Depends on Chart.js (loaded via CDN in index.html).
   ============================================================ */

(function () {
  "use strict";

  const DATA = window.PATIENT_DATA || {};
  const PATIENT = DATA.demographics || {};
  const ACTIVE_CONDITIONS = DATA.activeConditions || [];
  const RESOLVED_CONDITIONS = DATA.resolvedConditions || [];
  const MEDICATIONS = DATA.medications || [];
  const LABS = DATA.labs || [];

  // ── HELPERS ─────────────────────────────────────────────────
  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  // ── RENDER: HEADER ──────────────────────────────────────────
  function renderHeader() {
    const avatar = document.getElementById("pv-avatar");
    const info = document.getElementById("pv-info");
    const allergies = document.getElementById("pv-allergies");
    if (!avatar || !info) return;

    avatar.textContent = PATIENT.initials;

    info.innerHTML = "";
    info.appendChild(el("span", "patient-header__name", PATIENT.name));
    info.appendChild(
      el(
        "span",
        "patient-header__detail",
        "DOB: " + PATIENT.dob + "  ·  Age: " + PATIENT.age + "  ·  " + PATIENT.sex
      )
    );
    info.appendChild(
      el("span", "patient-header__detail", PATIENT.language + "  ·  " + PATIENT.race)
    );
    info.appendChild(el("span", "patient-header__detail", PATIENT.institution));
    info.appendChild(
      el("span", "patient-header__detail", "Summary generated " + PATIENT.summaryDate)
    );

    if (allergies) {
      allergies.innerHTML = "";
      allergies.appendChild(
        el("span", "pv-allergy-note", "🚫 " + PATIENT.allergies)
      );
    }
  }

  // ── RENDER: CONDITIONS ──────────────────────────────────────
  function renderChips(targetId, items, dateKey, dateLabel) {
    const target = document.getElementById(targetId);
    if (!target) return;
    target.innerHTML = "";
    items.forEach(function (item) {
      const chip = el("div", "pv-chip");
      chip.appendChild(el("span", "pv-chip__name", item.name));
      const d = item[dateKey];
      if (d) chip.appendChild(el("span", "pv-chip__date", dateLabel + " " + d));
      target.appendChild(chip);
    });
  }

  // ── RENDER: MEDICATIONS ─────────────────────────────────────
  function renderMedications() {
    const target = document.getElementById("pv-medications");
    if (!target) return;
    target.innerHTML = "";
    MEDICATIONS.forEach(function (med) {
      const card = el("div", "pv-med-card");
      const head = el("div", "pv-med-card__head");
      head.appendChild(el("span", "pv-med-card__name", med.name));
      if (med.dose && med.dose !== "—") {
        head.appendChild(el("span", "pv-med-card__dose", med.dose));
      }
      card.appendChild(head);
      card.appendChild(el("p", "pv-med-card__instr", med.instructions));
      card.appendChild(
        el("span", "pv-med-card__date", "Started " + med.started)
      );
      target.appendChild(card);
    });
  }

  // ── RENDER: LAB CHART ───────────────────────────────────────
  function renderLabChart() {
    const canvas = document.getElementById("pv-lab-chart");
    if (!canvas || typeof Chart === "undefined") return;

    const labels = LABS.map(function (l) {
      return l.flag ? l.name + " (" + l.flag + ")" : l.name;
    });

    // Normalize each value to 0-100% of its reference range so labs with
    // wildly different units share one axis. Clamp to [-15, 115] so
    // out-of-range values visibly overshoot the band.
    const normalized = LABS.map(function (l) {
      const span = l.high - l.low || 1;
      const pct = ((l.value - l.low) / span) * 100;
      return Math.max(-15, Math.min(115, pct));
    });

    const barColors = LABS.map(function (l) {
      return l.flag ? "#b04a4a" : "#5a5a5a";
    });

    new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          {
            label: "Position within reference range (%)",
            data: normalized,
            backgroundColor: barColors,
            borderRadius: 4,
            barPercentage: 0.7,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                const l = LABS[ctx.dataIndex];
                let range;
                if (l.low === 0) range = "≤ " + l.high + " " + l.unit;
                else range = l.low + " – " + l.high + " " + l.unit;
                const status = l.flag === "H" ? " · HIGH" : l.flag === "L" ? " · LOW" : "";
                return l.value + " " + l.unit + "  (ref " + range + ")" + status;
              },
            },
          },
          annotation: false,
        },
        scales: {
          x: {
            min: -15,
            max: 115,
            title: { display: true, text: "0% = low bound · 100% = high bound" },
            grid: {
              color: function (ctx) {
                return ctx.tick.value === 0 || ctx.tick.value === 100
                  ? "#b0b0b0"
                  : "#ececec";
              },
            },
            ticks: {
              callback: function (v) {
                if (v === 0) return "Low";
                if (v === 100) return "High";
                return "";
              },
            },
          },
          y: {
            grid: { display: false },
            ticks: { font: { size: 11 } },
          },
        },
      },
    });
  }

  // ── INIT (only when the tab first becomes visible) ──────────
  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    renderHeader();
    renderChips("pv-conditions", ACTIVE_CONDITIONS, "noted", "noted");
    renderChips("pv-resolved", RESOLVED_CONDITIONS, "resolved", "resolved");
    renderMedications();
    renderLabChart();
  }

  // Render eagerly if the panel is already active, otherwise lazily on
  // first activation (Chart.js needs a visible canvas to size correctly).
  function maybeInit() {
    const panel = document.getElementById("panel-patient-view");
    if (panel && panel.classList.contains("active")) init();
  }

  document.addEventListener("DOMContentLoaded", maybeInit);
  document.querySelectorAll('[data-tab="patient-view"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      // Defer until the panel display:block has taken effect.
      setTimeout(init, 30);
    });
  });
  window.addEventListener("hashchange", function () {
    if (window.location.hash === "#patient-view") setTimeout(init, 30);
  });
  // In case the page loads with #patient-view in the URL.
  if (window.location.hash === "#patient-view") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(init, 30);
    });
  }
})();
