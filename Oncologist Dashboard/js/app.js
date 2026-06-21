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
    "patient-view",
    "analytics",
    "settings",
    "faq",
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
    if ((e.ctrlKey || e.metaKey) && e.key >= "1" && e.key <= "8") {
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

  // ── DROPDOWNS & ACTIONS ─────────────────────────────────────
  const btnNotifications   = document.getElementById("btn-notifications");
  const btnHelp            = document.getElementById("btn-help");
  const userAvatar         = document.getElementById("user-avatar");
  
  const dropdownNotifications = document.getElementById("dropdown-notifications");
  const dropdownProfile       = document.getElementById("dropdown-profile");
  
  const notificationsBadge    = document.getElementById("notifications-badge");
  const notificationsList     = document.getElementById("notifications-list");
  const btnClearNotifications = document.getElementById("btn-clear-notifications");
  
  const profileBtnView        = document.getElementById("profile-btn-view");
  const profileBtnLogout      = document.getElementById("profile-btn-logout");
  const profileModal          = document.getElementById("profile-modal");
  const btnCloseProfileModal  = document.getElementById("btn-close-profile-modal");

  // Notifications State
  let notifications = [
    { id: 1, type: "critical", text: "Critical: Hb 6.8 g/dL for Patient John Doe", time: "10m ago", unread: true },
    { id: 2, type: "info", text: "New Patient Assignment: Jane Smith", time: "1h ago", unread: true },
    { id: 3, type: "warning", text: "Lab Results: CBC complete for Robert Johnson", time: "2h ago", unread: true },
    { id: 4, type: "success", text: "Milestone: Cycle 3 finished for Patient Linda White", time: "1d ago", unread: false }
  ];

  function closeAllDropdowns() {
    [dropdownNotifications, dropdownProfile].forEach(menu => {
      if (menu) {
        menu.classList.remove("active");
        menu.setAttribute("aria-hidden", "true");
      }
    });
    [btnNotifications, userAvatar].forEach(trigger => {
      if (trigger) {
        trigger.setAttribute("aria-expanded", "false");
      }
    });
  }

  function toggleDropdown(menu, trigger) {
    if (!menu) return;
    const isAlreadyActive = menu.classList.contains("active");
    closeAllDropdowns();
    if (!isAlreadyActive) {
      menu.classList.add("active");
      menu.setAttribute("aria-hidden", "false");
      if (trigger) trigger.setAttribute("aria-expanded", "true");
    }
  }

  // Bind trigger events
  if (btnNotifications) {
    btnNotifications.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleDropdown(dropdownNotifications, btnNotifications);
    });
  }

  if (btnHelp) {
    btnHelp.addEventListener("click", function (e) {
      e.stopPropagation();
      activateTab("faq");
    });
  }

  if (userAvatar) {
    userAvatar.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleDropdown(dropdownProfile, userAvatar);
    });
    
    // Support keyboard focus & activation for accessibility
    userAvatar.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleDropdown(dropdownProfile, userAvatar);
      }
    });
  }

  // Dismiss dropdowns when clicking outside
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".dropdown-container")) {
      closeAllDropdowns();
    }
  });

  // Handle ESC key to dismiss dropdowns and modal
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closeAllDropdowns();
      if (profileModal) {
        profileModal.classList.remove("active");
        profileModal.setAttribute("aria-hidden", "true");
      }
    }
  });

  // Render notifications
  function renderNotifications() {
    if (!notificationsList) return;
    notificationsList.innerHTML = "";

    const unreadCount = notifications.filter(n => n.unread).length;
    
    // Update Badge
    if (notificationsBadge) {
      if (unreadCount > 0) {
        notificationsBadge.style.display = "block";
      } else {
        notificationsBadge.style.display = "none";
      }
    }

    if (notifications.length === 0) {
      notificationsList.innerHTML = `
        <div style="padding: var(--space-md); text-align: center; color: var(--color-text-light); font-size: var(--font-size-sm);">
          No new notifications
        </div>
      `;
      return;
    }

    notifications.forEach(n => {
      const item = document.createElement("button");
      item.className = `notification-item ${n.unread ? "notification-item--unread" : ""}`;
      item.setAttribute("role", "menuitem");
      
      const dotType = n.unread ? `notification-item__dot--${n.type}` : "notification-item__dot--read";
      
      item.innerHTML = `
        <span class="notification-item__dot ${dotType}"></span>
        <div class="notification-item__text-wrap">
          <span class="notification-item__text">${n.text}</span>
          <span class="notification-item__time">${n.time}</span>
        </div>
      `;

      item.addEventListener("click", function () {
        n.unread = false;
        renderNotifications();
      });

      notificationsList.appendChild(item);
    });
  }

  // Clear Notifications
  if (btnClearNotifications) {
    btnClearNotifications.addEventListener("click", function (e) {
      e.stopPropagation();
      notifications = [];
      renderNotifications();
    });
  }

  // Profile Menu Actions
  if (profileBtnView && profileModal) {
    profileBtnView.addEventListener("click", function () {
      closeAllDropdowns();
      profileModal.classList.add("active");
      profileModal.setAttribute("aria-hidden", "false");
    });
  }

  if (btnCloseProfileModal && profileModal) {
    btnCloseProfileModal.addEventListener("click", function () {
      profileModal.classList.remove("active");
      profileModal.setAttribute("aria-hidden", "true");
    });
  }

  if (profileModal) {
    profileModal.addEventListener("click", function (e) {
      if (e.target === profileModal) {
        profileModal.classList.remove("active");
        profileModal.setAttribute("aria-hidden", "true");
      }
    });
  }

  if (profileBtnLogout) {
    profileBtnLogout.addEventListener("click", function () {
      closeAllDropdowns();
      if (confirm("Are you sure you want to sign out from the oncologist dashboard?")) {
        alert("Logout successful. Session cleared.");
        window.location.reload();
      }
    });
  }

  // FAQ Accordion Toggles
  const faqQuestions = document.querySelectorAll(".faq-question");
  faqQuestions.forEach(btn => {
    btn.addEventListener("click", function () {
      const item = btn.parentElement;
      const wasActive = item.classList.contains("active");
      
      // Close all first for accordion behavior
      document.querySelectorAll(".faq-item").forEach(i => i.classList.remove("active"));
      
      if (!wasActive) {
        item.classList.add("active");
      }
    });
  });

  // Initialize notifications render
  renderNotifications();

  // ── INIT ────────────────────────────────────────────────────
  restoreTabFromHash();
})();
