/* ============================================================
   ONCOLOGIST DASHBOARD — SKELETON JS
   Tab switching, sidebar toggle, hash routing
   Pure vanilla JS — no dependencies
   ============================================================ */

(function () {
  "use strict";

  // ── DOM REFERENCES ──────────────────────────────────────────
  const sidebar       = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const tabButtons    = document.querySelectorAll(".tab-btn");
  const sidebarLinks  = document.querySelectorAll(".sidebar__link");
  const tabPanels     = document.querySelectorAll(".tab-panel");

  // ── TAB MAPPING ─────────────────────────────────────────────
  // Maps tab IDs used in buttons/panels to readable names
  const TAB_IDS = [
    "dashboard",
    "patients",
    "treatments",
    "timeline",
    "patient-card",
    "analytics",
    "settings",
  ];

  // ── SIDEBAR TOGGLE ──────────────────────────────────────────
  function toggleSidebar() {
    document.body.classList.toggle("sidebar-expanded");

    // Update aria attribute
    const expanded = document.body.classList.contains("sidebar-expanded");
    sidebarToggle.setAttribute("aria-expanded", expanded);
    sidebar.setAttribute("aria-expanded", expanded);
  }

  sidebarToggle.addEventListener("click", toggleSidebar);

  // Close sidebar when clicking outside on mobile
  document.addEventListener("click", function (e) {
    if (window.innerWidth > 768) return;
    if (!document.body.classList.contains("sidebar-expanded")) return;
    if (sidebar.contains(e.target) || sidebarToggle.contains(e.target)) return;
    document.body.classList.remove("sidebar-expanded");
  });

  // ── TAB SWITCHING ───────────────────────────────────────────
  function activateTab(tabId) {
    // Validate
    if (!TAB_IDS.includes(tabId)) {
      tabId = TAB_IDS[0]; // fallback to dashboard
    }

    // Update tab buttons
    tabButtons.forEach(function (btn) {
      const isActive = btn.dataset.tab === tabId;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive);
    });

    // Update sidebar links
    sidebarLinks.forEach(function (link) {
      const isActive = link.dataset.tab === tabId;
      link.classList.toggle("active", isActive);
      if (isActive) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });

    // Update panels
    tabPanels.forEach(function (panel) {
      const isActive = panel.id === "panel-" + tabId;
      panel.classList.toggle("active", isActive);
      panel.setAttribute("aria-hidden", !isActive);
    });

    // Update URL hash (without scrolling)
    history.replaceState(null, "", "#" + tabId);
  }

  // Tab button click handlers
  tabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activateTab(btn.dataset.tab);
    });
  });

  // Sidebar link click handlers
  sidebarLinks.forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      activateTab(link.dataset.tab);

      // On mobile, close sidebar after navigation
      if (window.innerWidth <= 768) {
        document.body.classList.remove("sidebar-expanded");
      }
    });
  });

  // ── HASH ROUTING ────────────────────────────────────────────
  function restoreTabFromHash() {
    const hash = window.location.hash.replace("#", "");
    if (hash && TAB_IDS.includes(hash)) {
      activateTab(hash);
    } else {
      activateTab(TAB_IDS[0]);
    }
  }

  window.addEventListener("hashchange", restoreTabFromHash);

  // ── SEARCH INPUT ENHANCEMENT ────────────────────────────────
  const searchInput = document.getElementById("global-search");
  if (searchInput) {
    searchInput.addEventListener("focus", function () {
      this.parentElement.classList.add("focused");
    });
    searchInput.addEventListener("blur", function () {
      this.parentElement.classList.remove("focused");
    });
    // Stub: pressing Enter in search
    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        console.log("[Search stub] Query:", this.value);
      }
    });
  }

  // ── KEYBOARD NAVIGATION ─────────────────────────────────────
  document.addEventListener("keydown", function (e) {
    // Ctrl/Cmd + number to switch tabs
    if ((e.ctrlKey || e.metaKey) && e.key >= "1" && e.key <= "7") {
      e.preventDefault();
      const index = parseInt(e.key) - 1;
      if (TAB_IDS[index]) {
        activateTab(TAB_IDS[index]);
      }
    }

    // Ctrl/Cmd + B to toggle sidebar
    if ((e.ctrlKey || e.metaKey) && e.key === "b") {
      e.preventDefault();
      toggleSidebar();
    }

    // Ctrl/Cmd + K to focus search
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      if (searchInput) searchInput.focus();
    }
  });

  // ── INIT ────────────────────────────────────────────────────
  restoreTabFromHash();
})();
