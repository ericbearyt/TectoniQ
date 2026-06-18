/**
 * TectoniQ — app.js
 * Main controller: wires upload → backend → render pipeline
 * Also handles export toggle (JSON ↔ XML) and demo fixture loading.
 */

const BACKEND_URL = "http://127.0.0.1:5050";
const DEMO_FIXTURE_URL = "demo/sample_patient.json";

// ─── State ────────────────────────────────────────────────────────────────
let docData = null;        // Parsed document model from backend
let exportFormat = "json"; // "json" | "xml"

// ─── DOM References ───────────────────────────────────────────────────────
const fileInput        = document.getElementById("file-input");
const browseBtn        = document.getElementById("browse-btn");
const uploadArea       = document.getElementById("upload-area");
const uploadProgress   = document.getElementById("upload-progress");
const uploadError      = document.getElementById("upload-error");
const progressBar      = document.getElementById("progress-bar");
const loadDemoBtn      = document.getElementById("load-demo-btn");
const bannerSubtitle   = document.getElementById("banner-subtitle");
const chunkProgress    = document.getElementById("chunk-progress");
const chunkProgressLabel = document.getElementById("chunk-progress-label");
const chunkBarWrap     = document.getElementById("chunk-bar-wrap");
const chunkDetail      = document.getElementById("chunk-detail");
const statSections     = document.getElementById("stat-sections").querySelector(".stat-value");
const statTerms        = document.getElementById("stat-terms").querySelector(".stat-value");
const statPages        = document.getElementById("stat-pages").querySelector(".stat-value");
const statNer          = document.getElementById("stat-ner").querySelector(".stat-value");
const statusDot        = document.getElementById("status-dot");
const statusLabel      = document.getElementById("status-label");
const timelineContainer = document.getElementById("timeline-container");
const termDrawer       = document.getElementById("term-drawer");
const drawerContent    = document.getElementById("drawer-content");
const drawerClose      = document.getElementById("drawer-close");
const keywordGrid      = document.getElementById("keyword-grid");
const keywordSearch    = document.getElementById("keyword-search");
const exportPreviewCode = document.getElementById("export-preview-code");
const downloadBtn      = document.getElementById("download-btn");
const exportMeta       = document.getElementById("export-meta");
const alertsSection    = document.getElementById("alerts-section");
const alertsList       = document.getElementById("alerts-list");
const patientCard      = document.getElementById("patient-card");
const sidebarPatientName = document.getElementById("sidebar-patient-name");
const sidebarPatientMeta = document.getElementById("sidebar-patient-meta");

// History DOM References
const historyGrid = document.getElementById("history-grid");
const historySearch = document.getElementById("history-search");
const historyEmptyState = document.getElementById("history-empty-state");
let historyListCached = []; // cache history list for frontend filtering

// ─── Navigation ───────────────────────────────────────────────────────────
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", e => {
    e.preventDefault();
    const targetPanel = item.dataset.panel;
    if (!targetPanel) return;

    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));

    item.classList.add("active");
    document.getElementById(targetPanel)?.classList.add("active");

    if (targetPanel === "panel-history") {
      loadHistory();
    }
  });
});

// ─── Backend Health Check ─────────────────────────────────────────────────
async function checkBackendHealth() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      statusDot.className = "status-dot online";
      statusLabel.textContent = data.gemini_key_configured
        ? "Backend online · Gemini ✓"
        : "Backend online · No Gemini key";
    } else {
      throw new Error("Non-OK response");
    }
  } catch {
    statusDot.className = "status-dot offline";
    statusLabel.textContent = "Backend offline";
  }
}

// ─── Upload Handling ──────────────────────────────────────────────────────
browseBtn.addEventListener("click", e => {
  e.stopPropagation();
  fileInput.click();
});

uploadArea.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) processFile(fileInput.files[0]);
});

// Drag & drop
uploadArea.addEventListener("dragover", e => {
  e.preventDefault();
  uploadArea.classList.add("drag-over");
});

uploadArea.addEventListener("dragleave", () => {
  uploadArea.classList.remove("drag-over");
});

uploadArea.addEventListener("drop", e => {
  e.preventDefault();
  uploadArea.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) processFile(file);
});

async function processFile(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    showError("Only PDF files are supported.");
    return;
  }

  showProgress();

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch(`${BACKEND_URL}/api/parse/stream`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    // Parse SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6);
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr);
          handleSSEEvent(event);
        } catch (parseErr) {
          console.warn("Failed to parse SSE event:", jsonStr);
        }
      }
    }

  } catch (err) {
    showError(`Processing failed: ${err.message}. Is the backend running at ${BACKEND_URL}?`);
    hideProgress();
  }
}

function handleSSEEvent(event) {
  switch (event.event) {
    case "pipeline_stage":
      handlePipelineStage(event);
      break;
    case "chunk_progress":
      handleChunkProgress(event);
      break;
    case "complete":
      handleComplete(event);
      break;
    case "error":
      showError(`Pipeline error: ${event.message}`);
      hideProgress();
      break;
  }
}

function handlePipelineStage(event) {
  const stageMap = {
    worker4: "step-w4",
    worker5: "step-w5",
    worker6: "step-w6",
    worker2: "step-w2",
    worker3: "step-w3",
  };
  const stepId = stageMap[event.stage];
  if (!stepId) return;

  if (event.status === "processing") {
    setStep(stepId, "active");
    // Update progress bar based on pipeline stage
    const progressMap = { worker4: 10, worker5: 20, worker6: 60, worker2: 75, worker3: 85 };
    animateProgressTo(progressMap[event.stage] || 0);
  } else if (event.status === "done") {
    setStep(stepId, "done");

    // If worker4 is done, set up chunk segments
    if (event.stage === "worker4" && event.total_chunks) {
      initChunkSegments(event.total_chunks);
    }
  }
}

function handleChunkProgress(event) {
  const { chunk, total, header, status } = event;

  chunkProgressLabel.textContent = `Chunk ${chunk}/${total} — ${header}`;

  if (status === "done") {
    // Fill the chunk segment
    const seg = document.getElementById(`chunk-seg-${chunk - 1}`);
    if (seg) {
      seg.classList.add("filled");
      seg.title = `${header} ✓`;
    }
    chunkDetail.textContent = `✓ ${header} (${event.sections_found || 0} sections found)`;

    // Update overall progress bar proportionally within worker5 range (20-60%)
    const chunkPct = 20 + ((chunk / total) * 40);
    animateProgressTo(chunkPct);
  } else if (status === "processing") {
    const seg = document.getElementById(`chunk-seg-${chunk - 1}`);
    if (seg) seg.classList.add("processing");
  }
}

function handleComplete(event) {
  docData = event.data;
  animateProgressTo(100);
  setStep("step-w3", "done");

  setTimeout(() => {
    renderAll(docData);
    switchToPanel("panel-timeline");
    loadHistory();
  }, 400);
}

function initChunkSegments(total) {
  chunkProgress.style.display = "block";
  chunkBarWrap.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const seg = document.createElement("div");
    seg.className = "chunk-segment";
    seg.id = `chunk-seg-${i}`;
    seg.style.width = `${100 / total}%`;
    seg.title = `Chunk ${i + 1}/${total}`;
    chunkBarWrap.appendChild(seg);
  }
  chunkProgressLabel.textContent = `Processing ${total} chunks…`;
}

// ─── Demo Fixture ─────────────────────────────────────────────────────────
loadDemoBtn.addEventListener("click", async () => {
  try {
    const res = await fetch(DEMO_FIXTURE_URL);
    if (!res.ok) throw new Error("Demo fixture not found.");
    docData = await res.json();
    renderAll(docData);
    switchToPanel("panel-timeline");
  } catch (err) {
    showError(`Could not load demo: ${err.message}`);
  }
});

// ─── Render Pipeline ──────────────────────────────────────────────────────
function renderAll(data) {
  updateBanner(data);
  renderTimeline(data);
  renderKeywords(data);
  renderExport(data);
  renderAlerts(data);
  updatePatientCard(data);
}

function updateBanner(data) {
  const { meta } = data;
  bannerSubtitle.textContent = `${meta.page_count} pages processed · ${meta.ner_summary.gemini_available ? "Gemini NER active" : "Gemini NER offline"}`;
  statSections.textContent = meta.section_count;
  statTerms.textContent    = meta.unique_terms;
  statPages.textContent    = meta.page_count;
  statNer.textContent      = meta.ner_summary.reviewed_terms;
}

function updatePatientCard(data) {
  let name = data.patient_name;
  if (!name) {
    // Extract patient info from sections (heuristic: look for "patient:" patterns)
    const allContent = data.sections.map(s => s.content).join("\n");
    const nameMatch  = allContent.match(/patient(?:\s*name)?[:\s]+(?!(?:presents\b|is\b|was\b|has\b|reported\b|denies\b))([A-Z][a-z]+ [A-Z][a-z]+)/i);
    name = nameMatch ? nameMatch[1] : "Unknown Patient";
  }

  sidebarPatientName.textContent = name;
  sidebarPatientMeta.textContent = `${data.meta.section_count} sections`;
  patientCard.style.display = "flex";
}

// ─── Timeline Panel ───────────────────────────────────────────────────────
function renderTimeline(data) {
  if (!data.timeline || !data.sections) {
    timelineContainer.innerHTML = `<div class="empty-state">No timeline data available.</div>`;
    return;
  }

  // Group timeline entries by their sections_present
  const sectionMap = {};
  data.sections.forEach(s => {
    sectionMap[s.id] = { ...s, terms: [] };
  });

  data.timeline.forEach(entry => {
    // Place term in its first_seen section
    const fsid = entry.first_seen?.section_id;
    if (fsid && sectionMap[fsid]) {
      sectionMap[fsid].terms.push({ ...entry, appearance: "first-seen", currentOcc: entry.first_seen });
    }
    // Also place recurring occurrences
    entry.occurrences?.forEach(occ => {
      if (occ.section_id !== fsid && sectionMap[occ.section_id]) {
        sectionMap[occ.section_id].terms.push({ ...entry, appearance: "recurring", currentOcc: occ });
      }
    });
  });

  const orderedSections = data.sections;
  if (orderedSections.every(s => sectionMap[s.id].terms.length === 0)) {
    timelineContainer.innerHTML = `<div class="empty-state">No terms found in timeline.</div>`;
    return;
  }

  const track = document.createElement("div");
  track.className = "timeline-track";
  const row = document.createElement("div");
  row.className = "timeline-sections";

  orderedSections.forEach(section => {
    const col = document.createElement("div");
    col.className = "timeline-section-col";

    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = section.header;
    label.title = section.header;

    // Add section label badge from Worker 6
    if (section.section_label) {
      const badge = document.createElement("div");
      badge.className = `section-label-badge ${section.section_group || "other"}`;
      badge.textContent = section.section_label;
      badge.title = `Category: ${section.section_group || "other"}`;
      col.appendChild(badge);
    }

    const axisDot = document.createElement("div");
    axisDot.className = "section-axis-dot";

    const termsList = document.createElement("div");
    termsList.className = "timeline-terms";

    const terms = sectionMap[section.id]?.terms || [];
    // Deduplicate terms in this column
    const seen = new Set();
    terms.forEach(entry => {
      if (seen.has(entry.term)) return;
      seen.add(entry.term);

      const occDates = entry.currentOcc?.dates || [];
      const dateStr = occDates.length > 0 ? ` (${occDates.join(", ")})` : "";

      const node = document.createElement("div");
      node.className = `timeline-node ${entry.category || "other"} ${entry.appearance}`;
      node.textContent = `${entry.term}${dateStr}`;
      node.title = `${entry.term}${dateStr} · ${entry.category} · ${entry.status}`;
      // Cap the stagger so dense columns don't crawl in over seconds.
      node.style.animationDelay = `${Math.min(seen.size, 15) * 30}ms`;
      node.addEventListener("click", e => { e.stopPropagation(); openDrawer(entry); });
      termsList.appendChild(node);
    });

    col.appendChild(label);
    col.appendChild(axisDot);
    col.appendChild(termsList);
    row.appendChild(col);
  });

  track.appendChild(row);
  timelineContainer.innerHTML = "";
  timelineContainer.appendChild(track);
}

// ─── Term Drawer ──────────────────────────────────────────────────────────
function openDrawer(entry) {
  const catColor = getCategoryColor(entry.category);
  const firstSeenDates = entry.first_seen?.dates || [];
  const firstSeenDatesStr = firstSeenDates.length > 0 ? ` · ${firstSeenDates.join(", ")}` : "";

  drawerContent.innerHTML = `
    <div class="drawer-term">${entry.term}</div>
    <div class="drawer-badges">
      <span class="drawer-badge kw-badge ${entry.category || "other"}">${entry.category || "other"}</span>
      <span class="drawer-badge kw-badge ${entry.status || "unknown"}">${entry.status || "unknown"}</span>
      <span class="drawer-badge kw-badge" style="background:rgba(120,144,156,0.1);color:var(--t-muted)">
        ${entry.ner_confidence || "unreviewed"}
      </span>
    </div>
    <div class="drawer-stat-row">
      <div class="drawer-stat">
        <div class="drawer-stat-val">${entry.count}</div>
        <div class="drawer-stat-lbl">Total occurrences</div>
      </div>
      <div class="drawer-stat">
        <div class="drawer-stat-val">${entry.recurrence_gap}</div>
        <div class="drawer-stat-lbl">Section gap</div>
      </div>
    </div>
    <div class="drawer-section-title">First seen</div>
    <div class="drawer-occurrence" style="margin-bottom:16px">
      <span class="occ-header">${entry.first_seen?.section_header || "—"}</span>
      <span class="occ-page">p.${entry.first_seen?.page || "?"}${firstSeenDatesStr}</span>
    </div>
    <div class="drawer-section-title">All occurrences (${entry.occurrences?.length || 0})</div>
    ${(entry.occurrences || []).map(o => {
      const datesStr = o.dates && o.dates.length > 0 ? ` · ${o.dates.join(", ")}` : "";
      return `
        <div class="drawer-occurrence">
          <span class="occ-header">${o.section_header || o.section_id}</span>
          <span class="occ-page">p.${o.page}${datesStr}</span>
        </div>
      `;
    }).join("")}
  `;
  termDrawer.style.display = "block";
}

drawerClose.addEventListener("click", () => { termDrawer.style.display = "none"; });
document.addEventListener("click", e => {
  if (!termDrawer.contains(e.target)) termDrawer.style.display = "none";
});

// ─── Keyword Panel ────────────────────────────────────────────────────────
function renderKeywords(data) {
  if (!data.keywords || Object.keys(data.keywords).length === 0) {
    keywordGrid.innerHTML = `<div class="empty-state">No keywords extracted.</div>`;
    return;
  }

  buildKeywordCards(data.keywords, "");
}

function buildKeywordCards(keywords, filter) {
  keywordGrid.innerHTML = "";
  const entries = Object.entries(keywords)
    .filter(([term]) => !filter || term.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 200);

  if (entries.length === 0) {
    keywordGrid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">No keywords match your filter.</div>`;
    return;
  }

  entries.forEach(([term, data], idx) => {
    const card = document.createElement("div");
    card.className = "keyword-card";
    // Cap the stagger so large grids don't fade in over several seconds.
    card.style.animationDelay = `${Math.min(idx, 20) * 15}ms`;
    card.innerHTML = `
      <div class="kw-card-header">
        <div class="kw-term">${term}</div>
        <div class="kw-count">×${data.count}</div>
      </div>
      <div class="kw-badges">
        <span class="kw-badge ${data.category || "other"}">${data.category || "other"}</span>
        <span class="kw-badge ${data.status || "unknown"}">${data.status || "unknown"}</span>
      </div>
      <div class="kw-first-seen">
        First seen · ${data.first_seen?.section_header || "—"} · p.${data.first_seen?.page || "?"}
      </div>
    `;
    card.addEventListener("click", () => {
      // Find the matching timeline entry and open drawer
      const entry = { term, ...data, occurrences: data.occurrences || [] };
      openDrawer(entry);
      // Switch to timeline panel
      switchToPanel("panel-timeline");
    });
    keywordGrid.appendChild(card);
  });
}

let keywordSearchTimer = null;
keywordSearch.addEventListener("input", () => {
  if (!docData?.keywords) return;
  // Debounce: rebuilding up to 200 cards on every keystroke is janky.
  clearTimeout(keywordSearchTimer);
  keywordSearchTimer = setTimeout(() => {
    buildKeywordCards(docData.keywords, keywordSearch.value);
  }, 150);
});

// ─── Export Panel ─────────────────────────────────────────────────────────
function renderExport(data) {
  updateExportPreview(data);
  downloadBtn.disabled = false;

  const { meta } = data;
  exportMeta.textContent =
    `${meta.section_count} sections · ${meta.unique_terms} keywords · ${meta.page_count} pages`;
}

function updateExportPreview(data) {
  if (!data) return;
  if (exportFormat === "json") {
    exportPreviewCode.textContent = JSON.stringify(data, null, 2).slice(0, 3000) + "\n…";
  } else {
    exportPreviewCode.textContent = buildXML(data).slice(0, 3000) + "\n…";
  }
}

// Format toggle
document.getElementById("toggle-json").addEventListener("click", () => {
  setExportFormat("json");
});
document.getElementById("toggle-xml").addEventListener("click", () => {
  setExportFormat("xml");
});

function setExportFormat(fmt) {
  exportFormat = fmt;
  document.getElementById("toggle-json").classList.toggle("active", fmt === "json");
  document.getElementById("toggle-xml").classList.toggle("active", fmt === "xml");
  if (docData) updateExportPreview(docData);
}

// Download
downloadBtn.addEventListener("click", () => {
  if (!docData) return;
  let content, filename, mime;

  if (exportFormat === "json") {
    content  = JSON.stringify(docData, null, 2);
    filename = "tectoniQ_document.json";
    mime     = "application/json";
  } else {
    content  = buildXML(docData);
    filename = "tectoniQ_document.xml";
    mime     = "application/xml";
  }

  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});

// ─── XML Builder ──────────────────────────────────────────────────────────
function buildXML(data) {
  const esc = s => String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<document>\n`;

  // Meta
  xml += `  <meta>\n`;
  xml += `    <page_count>${data.meta?.page_count}</page_count>\n`;
  xml += `    <section_count>${data.meta?.section_count}</section_count>\n`;
  xml += `    <unique_terms>${data.meta?.unique_terms}</unique_terms>\n`;
  xml += `  </meta>\n`;

  // Sections
  xml += `  <sections>\n`;
  (data.sections || []).forEach(s => {
    xml += `    <section id="${esc(s.id)}">\n`;
    xml += `      <header>${esc(s.header)}</header>\n`;
    xml += `      <page>${esc(s.page)}</page>\n`;
    xml += `      <content>${esc(s.content?.slice(0, 500))}</content>\n`;
    if (s.duplicate_of) xml += `      <duplicate_of>${esc(s.duplicate_of)}</duplicate_of>\n`;
    xml += `      <keywords>\n`;
    (s.keywords || []).forEach(k => { xml += `        <keyword>${esc(k)}</keyword>\n`; });
    xml += `      </keywords>\n`;
    xml += `    </section>\n`;
  });
  xml += `  </sections>\n`;

  // Keywords
  xml += `  <keywords>\n`;
  Object.entries(data.keywords || {}).forEach(([term, d]) => {
    xml += `    <keyword term="${esc(term)}" category="${esc(d.category)}" status="${esc(d.status)}" count="${esc(d.count)}">\n`;
    xml += `      <first_seen section="${esc(d.first_seen?.section_id)}" page="${esc(d.first_seen?.page)}"/>\n`;
    xml += `    </keyword>\n`;
  });
  xml += `  </keywords>\n`;

  // Timeline
  xml += `  <timeline>\n`;
  (data.timeline || []).forEach(entry => {
    xml += `    <entry term="${esc(entry.term)}" category="${esc(entry.category)}" status="${esc(entry.status)}" count="${esc(entry.count)}">\n`;
    (entry.occurrences || []).forEach(o => {
      xml += `      <occurrence section="${esc(o.section_id)}" page="${esc(o.page)}"/>\n`;
    });
    xml += `    </entry>\n`;
  });
  xml += `  </timeline>\n`;
  xml += `</document>`;

  return xml;
}

// ─── Alerts (Duplicates) ──────────────────────────────────────────────────
function renderAlerts(data) {
  const dupes = (data.sections || []).filter(s => s.duplicate_of);
  if (dupes.length === 0) {
    alertsSection.style.display = "none";
    return;
  }

  alertsSection.style.display = "block";
  alertsList.innerHTML = dupes.map(s => `
    <div class="alert-item">
      <div>
        <div class="alert-header-name">${s.header}</div>
        <div class="alert-meta">Section ${s.id} · duplicate of ${s.duplicate_of} · p.${s.page}</div>
      </div>
    </div>
  `).join("");
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function switchToPanel(panelId) {
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.getElementById(panelId)?.classList.add("active");

  const navId = {
    "panel-upload":   "nav-upload",
    "panel-history":  "nav-history",
    "panel-timeline": "nav-timeline",
    "panel-keywords": "nav-keywords",
    "panel-export":   "nav-export",
  }[panelId];

  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  if (navId) document.getElementById(navId)?.classList.add("active");
}

function showProgress() {
  uploadProgress.style.display = "block";
  uploadError.style.display = "none";
  browseBtn.style.display = "none";
  // Reset steps
  ["step-w4","step-w5","step-w6","step-w2","step-w3"].forEach(id => setStep(id, "pending"));
  progressBar.style.width = "0%";
  // Reset chunk progress
  chunkProgress.style.display = "none";
  chunkBarWrap.innerHTML = "";
  chunkDetail.textContent = "";
}

function hideProgress() {
  uploadProgress.style.display = "none";
  browseBtn.style.display = "inline-flex";
}

function setStep(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `progress-step ${state}`;
  const dot = el.querySelector(".step-dot");
  if (dot) dot.className = `step-dot ${state}`;
}

function animateProgressTo(pct) {
  progressBar.style.width = `${pct}%`;
}

function showError(msg) {
  uploadError.textContent = msg;
  uploadError.style.display = "block";
}

function getCategoryColor(cat) {
  const map = {
    diagnosis:  "var(--c-diagnosis)",
    medication: "var(--c-medication)",
    procedure:  "var(--c-procedure)",
    biomarker:  "var(--c-biomarker)",
    other:      "var(--c-other)",
  };
  return map[cat] || map.other;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Patient History logic ────────────────────────────────────────────────
async function loadHistory() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/history`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    historyListCached = data;
    renderHistory(historyListCached);
  } catch (err) {
    console.error("Failed to load history:", err);
    historyGrid.innerHTML = `<div class="empty-state" style="grid-column: 1/-1; border-color: var(--c-rose); color: var(--c-rose);">Failed to load history list: ${err.message}</div>`;
    historyGrid.style.display = "grid";
    historyEmptyState.style.display = "none";
  }
}

function renderHistory(items) {
  if (!items || items.length === 0) {
    historyGrid.style.display = "none";
    historyEmptyState.style.display = "flex";
    return;
  }

  historyEmptyState.style.display = "none";
  historyGrid.style.display = "grid";
  historyGrid.innerHTML = "";

  items.forEach((item, idx) => {
    const dateStr = item.processed_at 
      ? new Date(item.processed_at).toLocaleString() 
      : "Unknown date";
      
    const card = document.createElement("div");
    card.className = "history-card";
    card.style.animationDelay = `${idx * 20}ms`;
    card.innerHTML = `
      <div class="history-card-header">
        <span class="history-patient-icon">👤</span>
        <div class="history-patient-name" title="${item.patient_name}">${item.patient_name}</div>
      </div>
      <div class="history-card-meta">
        <div>Processed: ${dateStr}</div>
        <div class="history-stats">
          <span>📄 ${item.meta?.page_count || 0} pages</span>
          <span>◈ ${item.meta?.section_count || 0} sections</span>
          <span>◉ ${item.meta?.unique_terms || 0} keywords</span>
        </div>
      </div>
      <button class="btn btn-ghost history-load-btn" data-id="${item.patient_id}">
        Load Patient Timeline
      </button>
    `;

    card.querySelector(".history-load-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      loadHistoryItem(item.patient_id);
    });

    historyGrid.appendChild(card);
  });
}

async function loadHistoryItem(patientId) {
  try {
    const btn = document.querySelector(`.history-load-btn[data-id="${patientId}"]`);
    if (btn) {
      btn.textContent = "Loading...";
      btn.disabled = true;
    }

    const res = await fetch(`${BACKEND_URL}/api/history/${patientId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    docData = data;
    renderAll(docData);
    switchToPanel("panel-timeline");
  } catch (err) {
    alert(`Failed to load patient history: ${err.message}`);
  } finally {
    const btn = document.querySelector(`.history-load-btn[data-id="${patientId}"]`);
    if (btn) {
      btn.textContent = "Load Patient Timeline";
      btn.disabled = false;
    }
  }
}

// Add history search filter listener
historySearch.addEventListener("input", () => {
  const query = historySearch.value.toLowerCase().trim();
  if (!query) {
    renderHistory(historyListCached);
    return;
  }
  const filtered = historyListCached.filter(item => 
    item.patient_name.toLowerCase().includes(query)
  );
  renderHistory(filtered);
});

// ─── Init ─────────────────────────────────────────────────────────────────
checkBackendHealth();
loadHistory();
setInterval(checkBackendHealth, 15000);
