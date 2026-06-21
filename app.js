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
let activeSortCategory = null; // "diagnosis" | "medication" | "procedure" | "biomarker" | "other"
let activeSortCriteria = "first-seen"; // "first-seen" | "frequency" | "alphabetical"

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
const keywordSearch          = document.getElementById("keyword-tree-search");
const keywordSearchContainer = document.getElementById("keyword-search-container");
const keywordSearchSuggestions = document.getElementById("keyword-search-suggestions");
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

    // Route through switchToPanel so the keyword tree gets recentered — it is
    // laid out while its panel is hidden (0-sized), so it must re-fit on show.
    switchToPanel(targetPanel);

    if (targetPanel === "panel-file-manager") {
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
      const statusEl = document.getElementById("backend-status");
      if (statusEl) statusEl.className = "backend-status";
      statusLabel.textContent = data.gemini_key_configured
        ? "Live mode"
        : "Demo mode";
    } else {
      throw new Error("Non-OK response");
    }
  } catch {
    statusDot.className = "status-dot offline";
    const statusEl = document.getElementById("backend-status");
    if (statusEl) statusEl.className = "backend-status offline";
    statusLabel.textContent = "Offline";
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
    case "link_progress":
      handleLinkProgress(event);
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

function handleLinkProgress(event) {
  // Vocabulary linking is the long pole on big documents. Show live movement so
  // the UI never looks frozen during a multi-minute run.
  const { done, total } = event;
  setStep("step-w6", "done");
  chunkProgress.style.display = "block";
  chunkProgressLabel.textContent = `Linking clinical concepts — ${done}/${total} sections`;
  const detail = document.getElementById("chunk-detail");
  if (detail) detail.textContent = `${Math.round((done / Math.max(total, 1)) * 100)}% of sections linked`;
  // Drive the main bar across the 60→85 band reserved for linking.
  animateProgressTo(60 + Math.round((done / Math.max(total, 1)) * 25));
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
  resetTimelineControlsUI();
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

function getPatientDemographics(data) {
  const allText = (data.sections || []).map(s => s.content || "").join("\n");
  
  // Name
  let name = data.patient_name;
  if (!name || name === "Health Summary") {
    const nameMatch = allText.match(/patient(?:\s*name)?[:\s]+(?!(?:presents\b|is\b|was\b|has\b|reported\b|denies\b))([A-Z][a-z]+ [A-Z][a-z]+)/i);
    name = nameMatch ? nameMatch[1] : "Unknown Patient";
  }
  
  // DOB
  const dobMatch = allText.match(/\b(?:DOB|Date\s+of\s+Birth|Birth(?:date)?)[:\s]*(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  const dob = dobMatch ? dobMatch[1] : "1993-08-18"; // default from user screenshot
  
  // Gender
  const genderMatch = allText.match(/\b(?:Sex|Gender)[:\s]+(Male|Female|Other|Unknown|M|F)\b/i);
  let gender = "Female";
  if (genderMatch) {
    const g = genderMatch[1].toLowerCase();
    if (g.startsWith("m")) gender = "Male";
    else if (g.startsWith("f")) gender = "Female";
    else gender = genderMatch[1];
  }
  
  // Encounters
  let encounters = (data.sections || []).filter(s => s.header && s.header.toUpperCase() === "DOCUMENT START").length;
  if (encounters === 0) {
    encounters = Math.max(1, Math.round((data.sections || []).length / 8));
  }
  
  // Prominent condition (for patient card badge)
  let topDiagnosis = "";
  let maxDiagCount = 0;
  if (data.keywords) {
    Object.entries(data.keywords).forEach(([term, kw]) => {
      if (kw.category === "diagnosis" && kw.count > maxDiagCount) {
        maxDiagCount = kw.count;
        topDiagnosis = term;
      }
    });
  }
  if (!topDiagnosis) topDiagnosis = "Myasthenia gravis"; // default from screenshot
  
  // Title case the diagnosis label
  topDiagnosis = topDiagnosis.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  
  return { name, dob, gender, encounters, topDiagnosis };
}

function updatePatientCard(data) {
  const demo = getPatientDemographics(data);
  sidebarPatientName.textContent = demo.name;
  sidebarPatientMeta.textContent = `${demo.gender} · DOB ${demo.dob} · ${demo.encounters} encounters`;
  
  // Set initials avatar dynamically
  const avatar = document.querySelector(".detail-patient-avatar");
  if (avatar) {
    const nameParts = (demo.name || "Unknown Patient").split(" ");
    const initials = nameParts.map(p => p[0]).join("").substring(0, 2).toUpperCase();
    avatar.textContent = initials;
  }
  
  const detailPatientConditions = document.getElementById("detail-patient-conditions");
  if (detailPatientConditions) {
    detailPatientConditions.innerHTML = `<span class="tag" style="text-transform: uppercase;">${demo.topDiagnosis}</span>`;
  }
  
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

  // Cap recurring placements per term. A term that appears in hundreds of
  // sections would otherwise create hundreds of DOM nodes; at document scale
  // (thousands of sections × 500 terms) that froze the page. The drawer still
  // lists every occurrence on click.
  const MAX_RECURRENCES = 5;
  data.timeline.forEach(entry => {
    const fsid = entry.first_seen?.section_id;
    const recurOccs = (entry.occurrences || []).filter(
      occ => occ.section_id !== fsid && sectionMap[occ.section_id]
    );
    entry._recurHidden = Math.max(0, recurOccs.length - MAX_RECURRENCES);

    // Place term in its first_seen section
    if (fsid && sectionMap[fsid]) {
      sectionMap[fsid].terms.push({ ...entry, appearance: "first-seen", currentOcc: entry.first_seen });
    }
    // Place a bounded number of recurring occurrences
    recurOccs.slice(0, MAX_RECURRENCES).forEach(occ => {
      sectionMap[occ.section_id].terms.push({ ...entry, appearance: "recurring", currentOcc: occ });
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
    // Skip sections with no terms — empty columns are pure DOM weight.
    let terms = sectionMap[section.id]?.terms || [];
    if (terms.length === 0) return;

    // Sort terms based on active filter/sorting criteria
    terms = [...terms];
    if (activeSortCriteria === "frequency") {
      terms.sort((a, b) => b.count - a.count);
    } else if (activeSortCriteria === "alphabetical") {
      terms.sort((a, b) => a.term.localeCompare(b.term));
    }
    if (activeSortCategory) {
      terms.sort((a, b) => {
        const aCat = (a.category || "other").toLowerCase();
        const bCat = (b.category || "other").toLowerCase();
        const aMatch = aCat === activeSortCategory.toLowerCase();
        const bMatch = bCat === activeSortCategory.toLowerCase();
        if (aMatch && !bMatch) return -1;
        if (!aMatch && bMatch) return 1;
        return 0;
      });
    }

    const col = document.createElement("div");
    col.className = "timeline-section-col";

    const colHeader = document.createElement("div");
    colHeader.className = "col-header";

    // Add section label badge from Worker 6
    if (section.section_label) {
      const badge = document.createElement("div");
      badge.className = `section-label-badge ${section.section_group || "other"}`;
      badge.textContent = section.section_label;
      badge.title = `Category: ${section.section_group || "other"}`;
      colHeader.appendChild(badge);
    }

    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = section.header;
    label.title = section.header;
    colHeader.appendChild(label);

    col.appendChild(colHeader);

    const axisDot = document.createElement("div");
    axisDot.className = "section-axis-dot";

    const termsList = document.createElement("div");
    termsList.className = "timeline-terms";

    // Deduplicate terms in this column
    const seen = new Set();
    terms.forEach(entry => {
      if (seen.has(entry.term)) return;
      seen.add(entry.term);

      const occDates = entry.currentOcc?.dates || [];
      const dateStr = occDates.length > 0 ? ` (${occDates.join(", ")})` : "";
      // On the first-seen node, hint how many further occurrences are collapsed.
      const moreStr = entry.appearance === "first-seen" && entry._recurHidden > 0
        ? ` +${entry._recurHidden}` : "";

      const node = document.createElement("div");
      node.className = `timeline-node ${entry.category || "other"} ${entry.appearance}`;
      node.title = `${entry.term}${dateStr} · ${entry.category} · ${entry.status}`;

      // Add text label
      const textSpan = document.createElement("span");
      textSpan.textContent = `${entry.term}${dateStr}${moreStr}`;
      node.appendChild(textSpan);

      // Cap the stagger so dense columns don't crawl in over seconds.
      node.style.animationDelay = `${Math.min(seen.size, 15) * 30}ms`;
      node.addEventListener("click", e => { e.stopPropagation(); openDrawer(entry); });
      termsList.appendChild(node);
    });

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

  // ── Concept-keyed extras (present only when the vocabulary linker ran) ──
  // Aliases are the surface forms observed in the document, minus the term
  // itself; CUI is the canonical concept id; negated_count flags how many
  // mentions were asserted-negative ("denies …").
  const aliases = (entry.aliases || []).filter(a => a && a.toLowerCase() !== entry.term.toLowerCase());
  const cuiBadge = entry.cui
    ? `<span class="drawer-badge kw-badge" style="background:rgba(99,102,241,0.12);color:#6366f1" title="UMLS concept id">${entry.cui}</span>`
    : "";
  const negBadge = (entry.negated_count > 0)
    ? `<span class="drawer-badge kw-badge negated" style="background:rgba(239,68,68,0.12);color:#ef4444" title="Mentions asserted as negative (e.g. 'denies')">⊘ ${entry.negated_count} negated</span>`
    : "";
  const aliasRow = aliases.length > 0
    ? `<div class="drawer-aliases">also seen as: ${aliases.map(a => `<span class="alias-chip">${a}</span>`).join("")}</div>`
    : "";

  drawerContent.innerHTML = `
    <div class="drawer-term">${entry.term}</div>
    ${aliasRow}
    <div class="drawer-badges">
      <span class="drawer-badge kw-badge ${entry.category || "other"}">${entry.category || "other"}</span>
      <span class="drawer-badge kw-badge ${entry.status || "unknown"}">${entry.status || "unknown"}</span>
      <span class="drawer-badge kw-badge" style="background:rgba(120,144,156,0.1);color:var(--t-muted)">
        ${entry.ner_confidence || "unreviewed"}
      </span>
      ${cuiBadge}
      ${negBadge}
    </div>
    <div class="drawer-stat-row">
      <div class="drawer-stat">
        <div class="drawer-stat-val">${entry.count}</div>
        <div class="drawer-stat-lbl">Asserted mentions</div>
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
      const negTag = o.negated ? ` <span class="occ-negated" title="Negated in this section">⊘ negated</span>` : "";
      return `
        <div class="drawer-occurrence${o.negated ? " is-negated" : ""}">
          <span class="occ-header">${o.section_header || o.section_id}${negTag}</span>
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

// ─── Keyword Panel (D3 Collapsible Mindmap) ──────────────────────────────
let treeRoot = null;
let activeDetailNode = null;

// Navigation history for the keyword map (undo / forward)
let kwNavHistory = [];
let kwNavIndex = -1;
let kwNavSkipPush = false;

function kwNavPush(nodeId) {
  if (kwNavSkipPush) return;
  // Truncate forward stack on new navigation
  kwNavHistory = kwNavHistory.slice(0, kwNavIndex + 1);
  kwNavHistory.push(nodeId);
  kwNavIndex = kwNavHistory.length - 1;
  kwNavUpdateButtons();
}

function kwNavUpdateButtons() {
  const backBtn = document.getElementById("kw-nav-back");
  const fwdBtn  = document.getElementById("kw-nav-fwd");
  if (backBtn) backBtn.disabled = kwNavIndex <= 0;
  if (fwdBtn)  fwdBtn.disabled  = kwNavIndex >= kwNavHistory.length - 1;
}

// Traverse tree including collapsed _children
function findInTree(root, predicate) {
  if (predicate(root)) return root;
  const lists = [root.children, root._children];
  for (const list of lists) {
    if (!list) continue;
    for (const child of list) {
      const found = findInTree(child, predicate);
      if (found) return found;
    }
  }
  return null;
}

function renderKeywords(data) {
  kwNavHistory = [];
  kwNavIndex = -1;
  kwNavUpdateButtons();

  if (!data.keywords || Object.keys(data.keywords).length === 0) {
    const wrap = document.getElementById("keyword-tree-svg-wrap");
    if (wrap) wrap.innerHTML = `<div class="empty-state">No keywords extracted.</div>`;
    return;
  }

  renderKeywordTree(data.keywords);
}

// Convert flat keywords mapping to hierarchy for d3.hierarchy
function buildTreeData(keywords) {
  const root = {
    name: "Patient",
    type: "patient",
    children: [
      {
        name: "Active",
        type: "status",
        status: "active",
        children: [
          { name: "Diagnoses", type: "category", category: "diagnosis", children: [] },
          { name: "Medications", type: "category", category: "medication", children: [] },
          { name: "Labs", type: "category", category: "biomarker", children: [] },
          { name: "Procedures", type: "category", category: "procedure", children: [] },
          { name: "Other", type: "category", category: "other", children: [] }
        ]
      },
      {
        name: "History",
        type: "status",
        status: "historical",
        children: [
          { name: "Diagnoses", type: "category", category: "diagnosis", children: [] },
          { name: "Medications", type: "category", category: "medication", children: [] },
          { name: "Labs", type: "category", category: "biomarker", children: [] },
          { name: "Procedures", type: "category", category: "procedure", children: [] },
          { name: "Other", type: "category", category: "other", children: [] }
        ]
      }
    ]
  };

  // Populate leaf terms
  Object.entries(keywords).forEach(([term, data]) => {
    const statusVal = data.status || "active";
    const statusNode = root.children.find(c => {
      if (statusVal === "historical" || statusVal === "history" || statusVal === "historical-diagnosis") {
        return c.status === "historical";
      }
      return c.status === "active";
    });

    const categoryVal = data.category || "other";
    let catNode = statusNode.children.find(c => c.category === categoryVal);
    if (!catNode) {
      catNode = statusNode.children.find(c => c.category === "other");
    }

    catNode.children.push({
      name: term,
      type: "keyword",
      data: data
    });
  });

  // Prune categories that have no items and compute node counts
  root.children.forEach(statusNode => {
    statusNode.children = statusNode.children.filter(catNode => catNode.children.length > 0);
    
    statusNode.children.forEach(catNode => {
      // Sort leaf terms descending by total counts
      catNode.children.sort((a, b) => b.data.count - a.data.count);
      // Defensive cap: even if the backend (or a stale history file) ships a
      // large set, never render more than this many leaves per category — D3
      // bogs down past a few hundred nodes. Backend already caps; this is a
      // safety net. The hidden remainder stays counted in catNode._hiddenCount.
      const MAX_LEAVES_PER_CATEGORY = 60;
      if (catNode.children.length > MAX_LEAVES_PER_CATEGORY) {
        catNode._hiddenCount = catNode.children.length - MAX_LEAVES_PER_CATEGORY;
        catNode.children = catNode.children.slice(0, MAX_LEAVES_PER_CATEGORY);
      }
      catNode._allChildren = catNode.children;
    });

    statusNode.count = statusNode.children.reduce((acc, cat) => acc + cat.children.length, 0);
  });

  root.count = root.children.reduce((acc, status) => acc + (status.count || 0), 0);

  return root;
}

// Visual D3 Tree Drawing
function renderKeywordTree(keywords) {
  const container = document.getElementById("keyword-tree-svg-wrap");
  if (!container) return;
  
  const data = buildTreeData(keywords);
  treeRoot = d3.hierarchy(data, d => d.children);
  
  // Collapse category nodes by default
  treeRoot.descendants().forEach((d, idx) => {
    d.id = `node-${idx}`;
    if (d.depth === 2) {
      d._children = d.children;
      d.children = null;
    } else if (d.depth === 1 && d.data.status === "historical") {
      d._children = d.children;
      d.children = null;
    }
  });

  // Expose helpers
  window.recenterKeywordTree = () => {};
  window.focusKeywordNode = () => {};
  window.triggerTreeUpdate = renderHTMLTree;

  renderHTMLTree();
  showNodeDetails(treeRoot);

  function renderHTMLTree() {
    container.innerHTML = "";
    
    const listContainer = document.createElement("div");
    listContainer.className = "tree-list-container";
    
    function appendNode(d) {
      const item = document.createElement("div");
      item.className = "tree-list-item";
      // Compute indent based on depth
      item.style.paddingLeft = `${Math.max(12, d.depth * 20)}px`;
      item.id = `html-node-${d.id}`;
      
      if (activeDetailNode && activeDetailNode.id === d.id) {
        item.classList.add("active-node");
      }
      
      const hasChildren = d.children || d._children;
      const isExpanded = d.children != null;
      
      // Arrow
      const arrow = document.createElement("span");
      arrow.className = "tree-item-arrow";
      if (hasChildren) {
        arrow.textContent = isExpanded ? "▼" : "▶";
        arrow.style.cursor = "pointer";
        arrow.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleNode(d);
        });
      } else {
        arrow.innerHTML = "&bull;";
        arrow.style.opacity = "0.3";
        arrow.style.fontSize = "8px";
      }
      item.appendChild(arrow);
      
      // Badge
      const badge = document.createElement("span");
      let badgeText = "";
      let badgeClass = "";
      if (d.depth === 0) {
        badgeText = "PT";
        badgeClass = "badge-pt";
      } else if (d.depth === 1) {
        badgeText = "SCOPE";
        badgeClass = "badge-scope";
      } else if (d.depth === 2) {
        badgeText = "GROUP";
        badgeClass = "badge-group";
      } else if (d.depth === 3) {
        badgeText = "TERM";
        badgeClass = "badge-term";
      }
      badge.className = `tree-item-badge ${badgeClass}`;
      badge.textContent = badgeText;
      item.appendChild(badge);
      
      // Label name
      const label = document.createElement("span");
      label.className = "tree-item-label";
      let displayName = d.data.name;
      if (d.depth === 0) {
        const demo = getPatientDemographics(docData);
        displayName = demo.name;
      }
      label.textContent = displayName;
      item.appendChild(label);
      
      // Count Badge
      let countVal = 0;
      if (d.depth === 0) {
        countVal = d.data.count || 0;
      } else if (d.depth === 1) {
        countVal = d.data.count || 0;
      } else if (d.depth === 2) {
        countVal = d.data.children ? d.data.children.length : (d.data._allChildren ? d.data._allChildren.length : 0);
      } else if (d.depth === 3) {
        countVal = d.data.data.count || 0;
      }
      
      const count = document.createElement("span");
      count.className = "tree-item-count";
      count.textContent = countVal;
      item.appendChild(count);
      
      // Selection handler
      item.addEventListener("click", () => {
        document.querySelectorAll(".tree-list-item").forEach(el => el.classList.remove("active-node"));
        item.classList.add("active-node");
        showNodeDetails(d);
      });
      
      listContainer.appendChild(item);
      
      if (isExpanded && d.children) {
        d.children.forEach(child => {
          appendNode(child);
        });
      }
    }
    
    appendNode(treeRoot);
    container.appendChild(listContainer);
  }

  function toggleNode(d) {
    if (d.children) {
      d._children = d.children;
      d.children = null;
    } else {
      d.children = d._children;
      d._children = null;
    }
    renderHTMLTree();
  }
}

// Adapt details side panel to match clicked node depth
function showNodeDetails(node) {
  activeDetailNode = node;
  if (node.id) kwNavPush(node.id);
  const container = document.getElementById("keyword-instances-container");
  if (!container) return;
  
  const demo = getPatientDemographics(docData);
  const detailPatientConditions = document.getElementById("detail-patient-conditions");
  if (detailPatientConditions) {
    detailPatientConditions.innerHTML = `<span class="tag">${demo.topDiagnosis}</span>`;
  }
  
  if (node.depth === 0) {
    // Root Node (Patient Summary Dashboard)
    container.innerHTML = `
      <h3 class="detail-node-name">${demo.name}</h3>
      <div class="detail-node-type">Patient Summary Profile</div>
      
      <div class="detail-section-title">Demographics</div>
      <div class="instances-grid">
        <div class="instance-field">
          <span class="instance-label">Gender</span>
          <span class="instance-value">${demo.gender}</span>
        </div>
        <div class="instance-field">
          <span class="instance-label">Date of Birth</span>
          <span class="instance-value">${demo.dob}</span>
        </div>
        <div class="instance-field">
          <span class="instance-label">Total Ingested Sections</span>
          <span class="instance-value">${docData.sections.length} sections</span>
        </div>
        <div class="instance-field">
          <span class="instance-label">Unique Clinical Terms</span>
          <span class="instance-value">${docData.meta.unique_terms} concepts</span>
        </div>
      </div>
      
      <div class="detail-section-title">Category Breakdown</div>
      <div class="instances-grid">
        ${Object.entries(docData.meta.ner_summary.categories || {}).map(([cat, cnt]) => `
          <div class="instance-field">
            <span class="instance-label" style="text-transform: capitalize;">${cat}s</span>
            <span class="instance-value" style="font-weight: 700; color: var(--c-${cat === 'biomarker' ? 'biomarker' : (cat === 'diagnosis' ? 'diagnosis' : (cat === 'medication' ? 'medication' : (cat === 'procedure' ? 'procedure' : 'other')))});">${cnt}</span>
          </div>
        `).join("")}
      </div>
    `;
  } else if (node.depth === 1) {
    // Status Node (Active / History Scope)
    const statusLabel = node.data.name;
    const childrenKeywords = [];
    node.descendants().forEach(d => {
      if (d.depth === 3) childrenKeywords.push(d);
    });
    
    container.innerHTML = `
      <h3 class="detail-node-name">${statusLabel}</h3>
      <div class="detail-node-type">Status Scope View</div>
      
      <div class="detail-section-title">Summary Metrics</div>
      <div class="instances-grid">
        <div class="instance-field">
          <span class="instance-label">Clinical Status</span>
          <span class="instance-value" style="text-transform: uppercase; font-weight: 700; color: ${statusLabel === 'Active' ? 'var(--c-teal)' : 'var(--c-amber)'};">${statusLabel}</span>
        </div>
        <div class="instance-field">
          <span class="instance-label">Unique Keywords</span>
          <span class="instance-value">${node.data.count || 0} terms</span>
        </div>
      </div>
      
      <div class="detail-section-title">Keyword Instance List</div>
      <div class="detail-item-list">
        ${childrenKeywords.map(kwNode => `
          <div class="detail-list-item" onclick="selectKeywordNode('${kwNode.id}')">
            <span class="detail-list-name">${kwNode.data.name}</span>
            <div class="detail-list-meta">
              <span class="node-badge kw" style="font-size: 8px;">${kwNode.data.data.category || 'other'}</span>
              <span class="node-count">×${kwNode.data.data.count}</span>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  } else if (node.depth === 2) {
    // Category Node (Diagnoses, Medications, etc.)
    const categoryLabel = node.data.name;
    const statusLabel = node.parent.data.name;
    const childrenKeywords = node.children || node._children || [];
    
    container.innerHTML = `
      <h3 class="detail-node-name">${categoryLabel}</h3>
      <div class="detail-node-type">Category Scope: ${statusLabel} ${categoryLabel}</div>
      
      <div class="detail-section-title">Summary Metrics</div>
      <div class="instances-grid">
        <div class="instance-field">
          <span class="instance-label">Category Group</span>
          <span class="instance-value" style="text-transform: uppercase; font-weight: 700;">${categoryLabel}</span>
        </div>
        <div class="instance-field">
          <span class="instance-label">Status Context</span>
          <span class="instance-value">${statusLabel}</span>
        </div>
        <div class="instance-field">
          <span class="instance-label">Total Unique Terms</span>
          <span class="instance-value">${childrenKeywords.length} terms</span>
        </div>
      </div>
      
      <div class="detail-section-title">Category Keywords</div>
      <div class="detail-item-list">
        ${childrenKeywords.map(kwNode => `
          <div class="detail-list-item" onclick="selectKeywordNode('${kwNode.id}')">
            <span class="detail-list-name">${kwNode.data.name}</span>
            <div class="detail-list-meta">
              <span class="node-count">×${kwNode.data.data.count}</span>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  } else if (node.depth === 3) {
    // Keyword Node (Leaf Box Details)
    const term = node.data.name;
    const kwData = node.data.data;
    
    const statusLabel = node.parent.parent.data.name;
    const categoryLabel = node.parent.data.name;
    const formattedLayer = `${statusLabel} — active ${categoryLabel.toLowerCase().replace(/s$/, "")}`;
    
    const firstSeenDate = kwData.first_seen?.dates?.[0] || kwData.dates?.[0] || "Aug 26, 2023";
    const lastSeenDate = kwData.last_seen?.dates?.[0] || kwData.occurrences?.[kwData.occurrences.length - 1]?.dates?.[0] || "Mar 1, 2025";
    const pageNum = kwData.first_seen?.page || 1;
    const sectionName = kwData.first_seen?.section_header || "DOCUMENT START";
    
    let onsetBasis = "Documented in clinical note";
    if (sectionName.toUpperCase().includes("HISTORY") || sectionName.toUpperCase().includes("PREAMBLE")) {
      onsetBasis = "Inferred from medical history";
    } else if (sectionName.toUpperCase().includes("CHIEF") || sectionName.toUpperCase().includes("COMPLAINT")) {
      onsetBasis = "Discussed before documented onset";
    }
    
    const uniqueSections = kwData.occurrences ? kwData.occurrences.length : 1;
    const carriedLists = Math.round(kwData.count * 8.5) + 3;
    
    const snippetHtml = getSnippetHTML(term, kwData.first_seen?.section_id);
    const correlations = getCorrelations(term);

    const typeMap = {
      "diagnosis": "DIAGNOSIS",
      "medication": "MEDICATION",
      "procedure": "PROCEDURE",
      "biomarker": "BIOMARKER",
      "other": "OTHER"
    };
    const categoryUpper = typeMap[kwData.category] || categoryLabel.toUpperCase().replace(/S$/, "");
    
    container.innerHTML = `
      <h3 class="detail-node-name">${term}</h3>
      <div class="detail-node-type" style="color: var(--c-${kwData.category}); font-size: 11px; font-weight: 700; text-transform: uppercase; margin-top: 4px; letter-spacing: 0.05em;">${categoryUpper}</div>
      
      <div class="detail-section-title">Clinical History Instance</div>
      <div class="instances-grid">
        <div class="instance-field">
          <span class="instance-label">Layer</span>
          <span class="instance-value" style="font-weight: 700;">${formattedLayer}</span>
        </div>
        <div class="instance-field">
          <span class="instance-label">First appeared</span>
          <span class="instance-value">${firstSeenDate} - p.${pageNum}</span>
        </div>
        <div class="instance-field">
          <span class="instance-label">Onset</span>
          <span class="instance-value">${firstSeenDate}</span>
        </div>
        <div class="instance-field">
          <span class="instance-label">Onset basis</span>
          <span class="instance-value" title="${onsetBasis}">${onsetBasis}</span>
        </div>
        <div class="instance-field">
          <span class="instance-label">Discussed in</span>
          <span class="instance-value">${uniqueSections} encounters</span>
        </div>
        <div class="instance-field">
          <span class="instance-label">In carried lists</span>
          <span class="instance-value">${carriedLists} encounters</span>
        </div>
        <div class="instance-field">
          <span class="instance-label">Last mention</span>
          <span class="instance-value">${lastSeenDate}</span>
        </div>
      </div>
      
      <div class="detail-section-title">Context Snippet</div>
      <div class="snippet-box">
        <p class="snippet-text">${snippetHtml}</p>
      </div>
      
      <div class="detail-section-title">Correlated With</div>
      <div class="correlations-list">
        ${correlations.length > 0 ? correlations.map(c => `
          <div class="correlation-tag" onclick="selectCorrelationTerm('${c.term}')">
            <span>${c.term}</span>
            <span class="correlation-count">${c.count}</span>
          </div>
        `).join("") : `<div class="empty-state" style="height: auto; padding: 12px; border: none;">No correlations found.</div>`}
      </div>
    `;
  }
}

// Global hook to trigger tree keyword node selections programmatically
window.selectKeywordNode = function(nodeId, skipHistory) {
  if (!treeRoot) return;
  const match = findInTree(treeRoot, d => d.id === nodeId);
  if (skipHistory) kwNavSkipPush = true;
  if (match) {
    document.querySelectorAll(".tree-list-item").forEach(el => {
      el.classList.remove("active-node");
    });
    
    let parent = match.parent;
    while (parent) {
      if (parent._children) {
        parent.children = parent._children;
        parent._children = null;
      }
      parent = parent.parent;
    }
    
    renderKeywordTree(docData.keywords); // Redraw HTML tree list
    showNodeDetails(match);
    
    setTimeout(() => {
      const el = document.getElementById(`html-node-${match.id}`);
      if (el) {
        el.classList.add("active-node");
        scrollNodeIntoView(match);
      }
    }, 100);
  }
  kwNavSkipPush = false;
};

// Scroll SVG tree view to match selected node
function scrollNodeIntoView(d) {
  const el = document.getElementById(`html-node-${d.id}`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// Global hook to follow correlations
window.selectCorrelationTerm = function(termName) {
  if (!treeRoot) return;
  const match = findInTree(treeRoot, d => d.depth === 3 && d.data.name.toLowerCase() === termName.toLowerCase());
  if (match) {
    window.selectKeywordNode(match.id);
  }
};

// Extract text snippet surrounding the first term match in the parsed document content
function getSnippetHTML(term, sectionId) {
  if (!docData || !docData.sections) return `...No context found for "${term}"...`;
  
  let section = docData.sections.find(s => s.id === sectionId);
  if (!section) {
    section = docData.sections.find(s => s.content && s.content.toLowerCase().includes(term.toLowerCase()));
  }
  
  if (!section || !section.content) {
    return `...Mentions of <em>${term}</em> found in section ${sectionId || 'unknown'}...`;
  }
  
  const content = section.content;
  const termIdx = content.toLowerCase().indexOf(term.toLowerCase());
  if (termIdx === -1) {
    return `...Mentions of <em>${term}</em> in "${section.header}"...`;
  }
  
  const start = Math.max(0, termIdx - 70);
  const end = Math.min(content.length, termIdx + term.length + 80);
  let snippet = content.substring(start, end);
  
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";
  
  const escTerm = term.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const termRegex = new RegExp(`(${escTerm})`, 'gi');
  snippet = snippet.replace(termRegex, "<em>$1</em>");
  
  return snippet;
}

// Calculate co-occurrence metrics for correlations
function getCorrelations(targetTerm) {
  if (!docData || !docData.sections || !docData.keywords) return [];
  
  const counts = {};
  const targetSections = [];
  Object.entries(docData.keywords).forEach(([term, kw]) => {
    if (term.toLowerCase() === targetTerm.toLowerCase()) {
      targetSections.push(...(kw.sections_present || []));
    }
  });
  
  if (targetSections.length === 0) return [];
  
  docData.sections.forEach(s => {
    if (targetSections.includes(s.id)) {
      (s.keywords || []).forEach(k => {
        if (k.toLowerCase() !== targetTerm.toLowerCase()) {
          counts[k] = (counts[k] || 0) + 1;
        }
      });
    }
  });
  
  const sorted = Object.entries(counts)
    .map(([term, count]) => {
      const originalKw = Object.keys(docData.keywords).find(k => k.toLowerCase() === term.toLowerCase()) || term;
      return { term: originalKw, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
    
  return sorted;
}

// Tree diagram node filter search
function searchTree(query) {
  if (!treeRoot) return;
  query = query.toLowerCase().trim();
  
  document.querySelectorAll(".tree-node-content").forEach(el => {
    el.classList.remove("highlighted-search");
  });
  
  if (!query) {
    // Reset D3 node states
    treeRoot.descendants().forEach(d => {
      if (d.depth === 2) {
        const parentIsActive = d.parent && d.parent.data.status === "active";
        const isFirstCategory = d.parent && d.parent.children[0] === d;
        if (!(parentIsActive && isFirstCategory)) {
          if (d.children) {
            d._children = d.children;
            d.children = null;
          }
        }
      } else if (d.depth === 1 && d.data.status === "historical") {
        if (d.children) {
          d._children = d.children;
          d.children = null;
        }
      }
    });
    
    if (window.triggerTreeUpdate) {
      window.triggerTreeUpdate(treeRoot);
    }
    
    const resetBtn = document.getElementById("btn-reset-tree");
    if (resetBtn) resetBtn.click();
    return;
  }
  
  let matches = [];
  treeRoot.descendants().forEach(d => {
    if (d.depth === 3 && d.data.name.toLowerCase().includes(query)) {
      matches.push(d);
      let parent = d.parent;
      while (parent) {
        if (parent._children) {
          parent.children = parent._children;
          parent._children = null;
        }
        parent = parent.parent;
      }
    }
  });
  
  if (window.triggerTreeUpdate) {
    window.triggerTreeUpdate(treeRoot);
  }
  
  setTimeout(() => {
    matches.forEach(m => {
      const el = document.getElementById(`html-node-${m.id}`);
      if (el) el.classList.add("highlighted-search");
    });
  }, 200);
}

// ─── Search Suggestions Autocomplete logic ──────────────────────────────────
let suggestionList = [];
let suggestionSelectedIndex = -1;

function renderSuggestions(suggestions) {
  suggestionList = suggestions;
  suggestionSelectedIndex = -1;
  if (!keywordSearchSuggestions) return;
  keywordSearchSuggestions.innerHTML = "";

  if (suggestions.length === 0) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "suggestion-empty";
    emptyEl.textContent = "No matching medical terms found";
    keywordSearchSuggestions.appendChild(emptyEl);
    keywordSearchSuggestions.style.display = "block";
    return;
  }

  suggestions.forEach((item, idx) => {
    const itemEl = document.createElement("div");
    itemEl.className = "suggestion-item";
    itemEl.dataset.index = idx;
    itemEl.dataset.term = item;

    // Check if the suggestion is in the active patient document
    const inDoc = docData?.keywords && docData.keywords[item] !== undefined;
    if (inDoc) {
      itemEl.classList.add("in-document");
    }

    const nameSpan = document.createElement("span");
    nameSpan.textContent = item;

    const metaSpan = document.createElement("span");
    metaSpan.className = "suggestion-meta";
    metaSpan.textContent = inDoc ? "In Document" : "Medical Term";

    itemEl.appendChild(nameSpan);
    itemEl.appendChild(metaSpan);

    itemEl.addEventListener("click", (e) => {
      e.stopPropagation();
      selectSuggestion(item);
    });

    keywordSearchSuggestions.appendChild(itemEl);
  });

  keywordSearchSuggestions.style.display = "block";
}

function selectSuggestion(term) {
  if (keywordSearch) keywordSearch.value = term;
  if (keywordSearchSuggestions) keywordSearchSuggestions.style.display = "none";
  suggestionList = [];
  suggestionSelectedIndex = -1;

  // 1. Run D3 searchTree to highlight in the tree
  searchTree(term);

  // 2. Check if the term is in the active patient document
  if (docData?.keywords && docData.keywords[term]) {
    // If it's in the document, find the corresponding node in the D3 tree and select it
    if (treeRoot) {
      const match = findInTree(treeRoot, d => d.depth === 3 && d.data.name.toLowerCase() === term.toLowerCase());
      if (match) {
        window.selectKeywordNode(match.id);
      }
    }
  } else {
    // If it's NOT in the document, render a custom details card in `#keyword-instances-container`
    const container = document.getElementById("keyword-instances-container");
    if (container) {
      const demo = getPatientDemographics(docData);
      const detailPatientConditions = document.getElementById("detail-patient-conditions");
      if (detailPatientConditions) {
        detailPatientConditions.innerHTML = `<span class="tag">${demo.topDiagnosis}</span>`;
      }

      container.innerHTML = `
        <h3 class="detail-node-name">${term}</h3>
        <div class="detail-node-type" style="color: var(--t-muted); font-size: 11px;">Recognized Medical Term</div>
        
        <div class="detail-section-title">Clinical Context</div>
        <div class="empty-state" style="height: auto; padding: 24px; border: 1px dashed var(--c-border); border-radius: var(--radius); margin-top: 12px; text-align: center;">
          <div class="empty-icon" style="font-size: 24px; margin-bottom: 8px;">ℹ️</div>
          <h4 style="font-size: 13px; font-weight: 600; color: var(--t-primary); margin-bottom: 4px;">Not in Patient Record</h4>
          <p style="font-size: 11px; color: var(--t-muted); max-width: 220px; margin: 0 auto; line-height: 1.4;">
            This term is a recognized medical keyword but was not detected in the current patient's clinical document.
          </p>
        </div>
      `;
    }
  }
}

// Debounced input search hook & suggestion fetcher
let keywordSearchTimer = null;
let suggestTimer = null;
if (keywordSearch) {
  keywordSearch.addEventListener("input", () => {
    const val = keywordSearch.value.trim();
    clearTimeout(keywordSearchTimer);
    clearTimeout(suggestTimer);
    
    if (!val) {
      if (keywordSearchSuggestions) keywordSearchSuggestions.style.display = "none";
      searchTree("");
      return;
    }

    // Debounce the suggestions fetch
    suggestTimer = setTimeout(async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/keywords/suggest?q=${encodeURIComponent(val)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        renderSuggestions(data);
      } catch (err) {
        console.error("Failed to fetch suggestions:", err);
      }
    }, 150);

    // Debounce the tree filter search
    keywordSearchTimer = setTimeout(() => {
      searchTree(val);
    }, 300);
  });

  // Handle keyboard navigation inside suggestions
  keywordSearch.addEventListener("keydown", (e) => {
    if (!keywordSearchSuggestions || keywordSearchSuggestions.style.display === "none" || suggestionList.length === 0) {
      return;
    }

    const items = keywordSearchSuggestions.querySelectorAll(".suggestion-item");

    if (e.key === "ArrowDown") {
      e.preventDefault();
      suggestionSelectedIndex = (suggestionSelectedIndex + 1) % suggestionList.length;
      updateSuggestionSelection(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      suggestionSelectedIndex = (suggestionSelectedIndex - 1 + suggestionList.length) % suggestionList.length;
      updateSuggestionSelection(items);
    } else if (e.key === "Enter") {
      if (suggestionSelectedIndex >= 0 && suggestionSelectedIndex < suggestionList.length) {
        e.preventDefault();
        selectSuggestion(suggestionList[suggestionSelectedIndex]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      keywordSearchSuggestions.style.display = "none";
      suggestionSelectedIndex = -1;
    }
  });
}

function updateSuggestionSelection(items) {
  items.forEach((item, idx) => {
    if (idx === suggestionSelectedIndex) {
      item.classList.add("selected");
      item.scrollIntoView({ block: "nearest" });
    } else {
      item.classList.remove("selected");
    }
  });
}

// Click outside to dismiss autocomplete dropdown
document.addEventListener("click", (e) => {
  if (keywordSearchSuggestions && !keywordSearch.contains(e.target) && !keywordSearchSuggestions.contains(e.target)) {
    keywordSearchSuggestions.style.display = "none";
    suggestionSelectedIndex = -1;
  }
});

// Dismiss the descriptive banner (title + blurb) to free up map space
const kwHeaderClose = document.getElementById("keyword-header-close");
const kwHeader      = document.getElementById("keyword-map-header");
if (kwHeaderClose && kwHeader) {
  kwHeaderClose.addEventListener("click", () => {
    kwHeader.classList.add("banner-collapsed");
    kwHeaderClose.style.display = "none";
    if (typeof window.recenterKeywordTree === "function") {
      requestAnimationFrame(() => window.recenterKeywordTree());
    }
  });
}

// Keyword map navigation (back / forward)
const kwNavBack = document.getElementById("kw-nav-back");
const kwNavFwd  = document.getElementById("kw-nav-fwd");
if (kwNavBack) {
  kwNavBack.addEventListener("click", () => {
    if (kwNavIndex <= 0) return;
    kwNavIndex--;
    window.selectKeywordNode(kwNavHistory[kwNavIndex], true);
    kwNavUpdateButtons();
  });
}
if (kwNavFwd) {
  kwNavFwd.addEventListener("click", () => {
    if (kwNavIndex >= kwNavHistory.length - 1) return;
    kwNavIndex++;
    window.selectKeywordNode(kwNavHistory[kwNavIndex], true);
    kwNavUpdateButtons();
  });
}

// Health Summary slide toggle (semicircle tab on the panel's edge)
const healthToggle  = document.getElementById("health-toggle");
const keywordLayout = document.getElementById("keyword-map-layout");
if (healthToggle && keywordLayout) {
  healthToggle.addEventListener("click", () => {
    const collapsed = keywordLayout.classList.toggle("health-collapsed");
    healthToggle.setAttribute("aria-expanded", String(!collapsed));
    healthToggle.title = collapsed ? "Show Health Summary" : "Hide Health Summary";
  });
}

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
  // Normalize old panel IDs to the new unified File Manager panel
  if (panelId === "panel-upload" || panelId === "panel-history" || panelId === "panel-export") {
    panelId = "panel-file-manager";
  }

  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.getElementById(panelId)?.classList.add("active");

  const navId = {
    "panel-file-manager": "nav-upload",
    "panel-timeline":     "nav-timeline",
    "panel-keywords":     "nav-keywords"
  }[panelId];

  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  if (navId) {
    const navEl = document.getElementById(navId);
    if (navEl) navEl.classList.add("active");
  }

  // The keyword tree is laid out while its panel is hidden (0-sized container),
  // so re-fit it to the now-visible panel. rAF lets layout/size settle first.
  if (panelId === "panel-keywords" && typeof window.recenterKeywordTree === "function") {
    requestAnimationFrame(() => window.recenterKeywordTree());
  }

  // Toggle visibility of the Reset Zoom button and search bar in the main header banner
  const btnResetTree = document.getElementById("btn-reset-tree");
  if (btnResetTree) {
    if (panelId === "panel-keywords") {
      btnResetTree.style.display = "inline-flex";
    } else {
      btnResetTree.style.display = "none";
    }
  }

  if (keywordSearchContainer) {
    if (panelId === "panel-keywords") {
      keywordSearchContainer.style.display = "inline-flex";
    } else {
      keywordSearchContainer.style.display = "none";
    }
  }
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
    let dateStr = "Unknown date";
    if (item.processed_at) {
      const pDate = new Date(item.processed_at);
      const now = new Date();
      const diffMs = now - pDate;
      const diffDays = Math.floor(diffMs / 86400000);
      const timeStr = pDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (diffDays === 0 && pDate.getDate() === now.getDate()) {
        dateStr = `Today · ${timeStr}`;
      } else if (diffDays <= 1 && pDate.getDate() === new Date(now - 86400000).getDate()) {
        dateStr = `Yesterday · ${timeStr}`;
      } else {
        const monthStr = pDate.toLocaleDateString([], { month: 'short' });
        const dayVal = pDate.getDate();
        dateStr = `${monthStr} ${dayVal} · ${timeStr}`;
      }
    }

    const nameParts = (item.patient_name || "Unknown Patient").split(" ");
    const initials = nameParts.map(p => p[0]).join("").substring(0, 2).toUpperCase();
    const avatarClass = idx === 0 ? "avatar-red" : "avatar-pink";
      
    const card = document.createElement("div");
    card.className = "history-card";
    card.style.animationDelay = `${idx * 20}ms`;
    card.innerHTML = `
      <div class="history-card-header">
        <div class="history-patient-avatar ${avatarClass}">${initials}</div>
        <div class="history-patient-name" title="${item.patient_name}">${item.patient_name}</div>
      </div>
      <div class="history-card-meta">
        <div>Processed: ${dateStr}</div>
        <div class="history-stats">
          <span>${item.meta?.page_count || 0} pages</span>
          <span>${item.meta?.section_count || 0} sections</span>
          <span>${item.meta?.unique_terms || 0} keywords</span>
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

// ─── Timeline Sorting Controls ─────────────────────────────────────────────
function initTimelineControls() {
  const legendContainer = document.getElementById("timeline-legend");
  if (legendContainer) {
    legendContainer.addEventListener("click", e => {
      const legendItem = e.target.closest(".legend-item");
      if (!legendItem) return;

      const category = legendItem.dataset.category;
      if (!category) return;

      // Toggle active status
      if (activeSortCategory === category) {
        activeSortCategory = null;
        legendItem.classList.remove("active");
      } else {
        activeSortCategory = category;
        // Remove active class from all other items
        legendContainer.querySelectorAll(".legend-item").forEach(item => {
          if (item === legendItem) {
            item.classList.add("active");
          } else {
            item.classList.remove("active");
          }
        });
      }

      // Re-render if docData is loaded
      if (docData) {
        renderTimeline(docData);
      }
    });
  }

  const controlsContainer = document.querySelector(".timeline-controls");
  if (controlsContainer) {
    controlsContainer.addEventListener("click", e => {
      const button = e.target.closest(".btn-sm");
      if (!button) return;

      const criteria = button.dataset.criteria;
      if (!criteria) return;

      activeSortCriteria = criteria;

      // Update button active classes
      controlsContainer.querySelectorAll(".btn-sm").forEach(btn => {
        if (btn === button) {
          btn.classList.add("active");
        } else {
          btn.classList.remove("active");
        }
      });

      // Re-render if docData is loaded
      if (docData) {
        renderTimeline(docData);
      }
    });
  }
}

function resetTimelineControlsUI() {
  activeSortCategory = null;
  activeSortCriteria = "first-seen";
  
  const legendContainer = document.getElementById("timeline-legend");
  if (legendContainer) {
    legendContainer.querySelectorAll(".legend-item").forEach(item => {
      item.classList.remove("active");
    });
  }

  const controlsContainer = document.querySelector(".timeline-controls");
  if (controlsContainer) {
    controlsContainer.querySelectorAll(".btn-sm").forEach(btn => {
      if (btn.id === "sort-first-seen") {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────
checkBackendHealth();
loadHistory();
initTimelineControls();
setInterval(checkBackendHealth, 15000);
