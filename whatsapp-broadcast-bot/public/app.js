/* ── State ───────────────────────────────────────────────────────── */
const state = {
  approvals: {},   // id → { id, mediaType, caption, createdAt, hasPreview }
  stats: { sentToday: 0, pending: 0, failed: 0, targetGroupCount: 0 },
  groups: { mainGroup: "", targetGroups: [] },
  timers: {},      // id → setInterval handle for countdown
  allGroups: [],   // full list from /api/groups/all
  chat: { openJid: null, openName: "", participantCount: 0 },
  status: "disconnected",
};

/* ── Socket.IO ───────────────────────────────────────────────────── */
const socket = io();

socket.on("init", ({ status, pending, logs, stats, qr }) => {
  setStatus(status, qr);
  // Rebuild approval state
  state.approvals = {};
  for (const item of pending) state.approvals[item.id] = item;
  renderApprovals();
  renderMiniApprovals();
  // Seed activity feed
  for (const entry of [...logs].reverse()) addActivityItem(entry.type, entry.data, entry.ts);
  // Update stats from server
  if (stats) updateStats({ ...stats, pending: pending.length });
});

socket.on("bot:connected", () => {
  setStatus("connected");
  addActivity("bot:connected", {});
  loadAllGroups(); // Fetch groups now that bot is connected
});
socket.on("bot:disconnected", () => { setStatus("disconnected"); addActivity("bot:disconnected", {}); });
socket.on("status:update", ({ status, qr }) => setStatus(status, qr));

socket.on("approval:new", (data) => {
  state.approvals[data.id] = data;
  renderApprovals();
  renderMiniApprovals();
  updatePendingCount();
  addActivity("approval:new", data);
  showToast(" New Approval Request", `${data.mediaType} — ID ${data.id}`, "warn");
});

socket.on("approval:resolved", ({ id, decision }) => {
  delete state.approvals[id];
  clearInterval(state.timers[id]);
  delete state.timers[id];
  renderApprovals();
  renderMiniApprovals();
  updatePendingCount();
  addActivity("approval:resolved", { id, decision });
});

socket.on("approval:expired", ({ id }) => {
  delete state.approvals[id];
  clearInterval(state.timers[id]);
  delete state.timers[id];
  renderApprovals();
  renderMiniApprovals();
  updatePendingCount();
  addActivity("approval:expired", { id });
});

socket.on("broadcast:start", (d) => addActivity("broadcast:start", d));
socket.on("broadcast:sent", (d) => { state.stats.sentToday++; updateStatsUI(); addActivity("broadcast:sent", d); });
socket.on("broadcast:failed", (d) => { state.stats.failed++; updateStatsUI(); addActivity("broadcast:failed", d); });
socket.on("broadcast:complete", (d) => { addActivity("broadcast:complete", d); showToast("✅ Broadcast Complete", `Sent: ${d.sent} | Failed: ${d.failed}`, d.failed > 0 ? "warn" : "success"); });
socket.on("stats:update", (s) => updateStats(s));
socket.on("groups:updated", (g) => { state.groups = g; });

// Auto-reload when server signals a public/ file change (dev hot-reload)
socket.on("reload", () => { window.location.reload(); });

socket.on("chat:message", (msg) => {
  // If this group is currently open in the chat panel, OR the global feed is active
  if (state.chat.openJid === "GLOBAL" || (state.chat.openJid && msg.jid === state.chat.openJid)) {
    appendChatBubble(msg, false);
  }
  // Update the group row in the picker with a live activity indicator
  updateGroupLiveIndicator(msg.jid, msg.text);
});

socket.on("system:qr", (url) => {
  const modal = document.getElementById("qr-modal");
  const img = document.getElementById("qr-image");
  if (modal && img) {
    img.src = url;
    modal.style.display = "flex";
  }
});

socket.on("system:connected", () => {
  const modal = document.getElementById("qr-modal");
  if (modal) modal.style.display = "none";
});

/* ── Initial data load ───────────────────────────────────────────── */
async function loadInitialData() {
  try {
    const [statusRes, groupsRes] = await Promise.all([
      fetch("/api/status").then(r => r.json()),
      fetch("/api/groups").then(r => r.json()),
    ]);
    updateStats({
      sentToday: statusRes.sentToday || 0,
      pending: statusRes.pending || 0,
      failed: statusRes.failed || 0,
      targetGroupCount: statusRes.targetGroupCount || 0,
    });
    state.groups = groupsRes;
    setStatus(statusRes.status, statusRes.qr);
      if (statusRes.status === "connected") {
        loadAllGroups(); // Only fetch group details when the bot is connected
      }
  const pageTitle = document.getElementById("page-title");
  if (pageTitle) pageTitle.textContent = titles[name] || name;
  if (name === "groups") loadAllGroups();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    console.error('loadInitialData failed', e);
  }
}

/* ── Status ──────────────────────────────────────────────────────── */
function setStatus(status, qr) {
  state.status = status;
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  const pill = document.getElementById("status-pill");
  if (dot) dot.className = "status-dot " + status;

  if (text && pill) {
    if (status === "connected") {
      text.textContent = "Connected";
      pill.style.borderColor = "rgba(16, 185, 129, 0.3)";
    } else if (status === "connecting") {
      text.textContent = "Connecting...";
      pill.style.borderColor = "rgba(99, 102, 241, 0.3)";
    } else {
      text.textContent = "Disconnected";
      pill.style.borderColor = "rgba(239, 68, 68, 0.3)";
    }
  }

  // Handle overview Setup QR panel visibility
  const sessionCard = document.getElementById("session-card");
  const qrContainer = document.getElementById("qr-container");
  if (sessionCard && qrContainer) {
    if (status === "disconnected") {
      sessionCard.style.display = "block";
      if (qr) {
        qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qr)}&color=255-255-255&bgcolor=0-0-0" style="width: 180px; height: 180px; filter: invert(1);" alt="QR Code" />`;
      } else {
        qrContainer.innerHTML = `<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px;">Generating QR Code...</div>`;
      }
    } else if (status === "connecting") {
      sessionCard.style.display = "block";
      qrContainer.innerHTML = `<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px;">Establishing connection...</div>`;
    } else {
      sessionCard.style.display = "none";
      // Ensure any previously rendered QR is cleared when connected
      try { qrContainer.innerHTML = ''; } catch (e) { /* noop */ }
    }
  }
}

/* Make showSection available globally for inline onclick handlers */
function showSection(name, navEl) {
  const content = document.getElementById(`section-${name}`) || document.querySelector(`.content-section[data-section="${name}"]`) || document.querySelector(`[data-section="${name}"]`);
  if (!content) return;

  // Hide all content sections, show the requested one
  document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
  content.classList.add('active');

  // Update navigation active state (sidebar + mobile)
  document.querySelectorAll('.mobile-nav-item, .nav-item').forEach(btn => {
    const target = btn.dataset.section || btn.getAttribute('data-section') || btn.dataset.target;
    if (target === name) btn.classList.add('active'); else btn.classList.remove('active');
  });

  // If caller provided a specific nav element, ensure it's marked active too
  if (navEl && navEl.classList) {
    document.querySelectorAll('.mobile-nav-item, .nav-item').forEach(b => b.classList.remove('active'));
    navEl.classList.add('active');
  }

  // trigger load hooks for some sections
  if (name === 'groups') loadAllGroups();
  if (name === 'approvals') renderApprovals();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Attach event listeners instead of relying on inline onclick attributes
document.addEventListener('DOMContentLoaded', () => {
  // Nav buttons (sidebar + mobile)
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(btn => {
    // ensure cursor is interactive
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', (e) => {
      const s = btn.dataset.section;
      if (s) showSection(s, btn);
    });
  });

  // Card links that navigate to full views (have data-section)
  document.querySelectorAll('.card-link[data-section]').forEach(a => {
    a.addEventListener('click', (e) => {
      const s = a.dataset.section;
      if (s) showSection(s, a);
    });
  });

  // Ensure initial active section is synced
  const initial = document.querySelector('.nav-item.active[data-section], .mobile-nav-item.active[data-section]');
  if (initial && initial.dataset.section) showSection(initial.dataset.section, initial);
  // Render current UI state now that DOM is ready
  try { renderApprovals(); } catch (e) { /* noop */ }
  try { renderMiniApprovals(); } catch (e) { /* noop */ }
  try { updatePendingCount(); } catch (e) { /* noop */ }
  try { updateStatsUI(); } catch (e) { /* noop */ }
});

// expose to global scope so inline handlers work even if this file is loaded as a module
window.showSection = showSection;

async function doLogout() {
  showConfirmModal("Log Out", "Are you sure you want to log out of the dashboard?", async () => {
    try {
      await fetch("/auth/logout", { method: "POST" });
    } catch (e) { }
    window.location.href = "/login.html";
  });
}

async function resetSession() {
  showConfirmModal("Reset Session", "Are you sure you want to log out and reset the WhatsApp session? This will clear credentials and generate a new QR code.", async () => {
    showToast("Session Reset", "Disconnecting & clearing credentials...", "warn");
    try {
      const res = await fetch("/api/session/reset", { method: "POST" });
      if (!res.ok) throw new Error("Failed to trigger session reset");
      showToast("Reset Triggered", "Generating a new QR code shortly...", "success");
    } catch (err) {
      showToast("Reset Failed", err.message, "error");
    }
  });
}

/* ── Custom Confirm Modal ────────────────────────────────────────── */
function showConfirmModal(title, message, onConfirm) {
  let modal = document.getElementById("custom-confirm-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "custom-confirm-modal";
    modal.className = "modal-overlay";
    modal.innerHTML = `
      <div class="modal-card">
        <h3 id="confirm-title"></h3>
        <p id="confirm-msg"></p>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="confirm-cancel">Cancel</button>
          <button class="btn btn-primary" id="confirm-ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-msg").textContent = message;

  const okBtn = document.getElementById("confirm-ok");
  const cancelBtn = document.getElementById("confirm-cancel");

  const newOkBtn = okBtn.cloneNode(true);
  const newCancelBtn = cancelBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOkBtn, okBtn);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

  newCancelBtn.onclick = () => {
    modal.classList.remove("show");
    setTimeout(() => { if (!modal.classList.contains("show")) modal.style.display = "none"; }, 300);
  };

  newOkBtn.onclick = () => {
    modal.classList.remove("show");
    setTimeout(() => { if (!modal.classList.contains("show")) modal.style.display = "none"; }, 300);
    onConfirm();
  };

  modal.style.display = "flex";
  // Force reflow for animation
  void modal.offsetWidth;
  modal.classList.add("show");
}

/* ── Stats ───────────────────────────────────────────────────────── */
function updateStats(s) {
  if (s.sentToday !== undefined) state.stats.sentToday = s.sentToday;
  if (s.pending !== undefined) state.stats.pending = s.pending;
  if (s.failed !== undefined) state.stats.failed = s.failed;
  if (s.targetGroupCount !== undefined) state.stats.targetGroupCount = s.targetGroupCount;
  updateStatsUI();
}

function updateStatsUI() {
  setText("stat-sent", state.stats.sentToday);
  setText("stat-pending", state.stats.pending);
  setText("stat-failed", state.stats.failed);
  setText("stat-groups", state.stats.targetGroupCount);
  setText("ov-sent", state.stats.sentToday);
  setText("ov-pending", state.stats.pending);
  setText("ov-failed", state.stats.failed);
  setText("ov-groups", state.stats.targetGroupCount);
}

function updatePendingCount() {
  const count = Object.keys(state.approvals).length;
  state.stats.pending = count;
  updateStatsUI();
  const badge = document.getElementById("badge-pending");
  if (badge) {
    badge.textContent = count;
    badge.className = "badge" + (count > 0 ? " visible" : "");
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ── Approvals ───────────────────────────────────────────────────── */
function renderApprovals() {
  const grid = document.getElementById("approval-grid");
  const approvals = Object.values(state.approvals);

  if (!grid) {
    console.warn('renderApprovals: approval-grid element not found');
    return;
  }

  if (approvals.length === 0) {
    grid.innerHTML = `<div class="empty-state full">
      <div>No pending approvals right now</div>
      <div class="empty-sub">Post an image in the Main group to get started</div>
    </div>`;
    return;
  }

  grid.innerHTML = "";
  for (const item of approvals) {
    grid.appendChild(buildApprovalCard(item));
    startCountdown(item.id, item.createdAt);
  }
  updatePendingCount();
}

function buildApprovalCard(item) {
  const div = document.createElement("div");
  div.className = "approval-card";
  div.id = `card-${item.id}`;

  const svgIcon = item.mediaType === "video"
    ? `<svg viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`
    : `<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;

  // Always attempt to load the image — onerror adds img-broken class to hide it and retries
  const noPreviewFallback = `<div id="no-prev-${item.id}" style="width:48px;height:48px;fill:rgba(255,255,255,0.2)">${svgIcon}</div>`;
  const thumbnailSrc = item.thumbnail ? `data:image/jpeg;base64,${item.thumbnail}` : null;
  const previewSrc = item.hasPreview ? `/api/media/${item.id}` : thumbnailSrc || `/api/media/${item.id}`;

  let mediaTag = `<img src="${previewSrc}" alt=""
    onload="this.classList.remove('img-broken');this.closest('.approval-preview').style.cssText='';var n=document.getElementById('no-prev-${item.id}');if(n)n.remove();"
    onerror="this.classList.add('img-broken');schedulePreviewRetry('${item.id}', '${item.mediaType}')" />`;

  if (item.mediaType === "video" && item.hasPreview) {
    mediaTag = `<video src="/api/media/${item.id}" controls autoplay loop muted playsinline style="width:100%; max-height:450px; background:#000;"></video>`;
  } else if (item.mediaType === "video" && thumbnailSrc) {
    mediaTag = `<img src="${thumbnailSrc}" alt="Video preview"
      onload="this.classList.remove('img-broken');this.closest('.approval-preview').style.cssText='';var n=document.getElementById('no-prev-${item.id}');if(n)n.remove();"
      onerror="this.classList.add('img-broken');schedulePreviewRetry('${item.id}', '${item.mediaType}')" />`;
  }

  const previewHTML = `<div class="approval-preview" id="preview-wrap-${item.id}">${mediaTag}${noPreviewFallback}<div class="preview-overlay">${item.mediaType}</div></div>`;

  div.innerHTML = `
    ${previewHTML}
    <div class="approval-body">
      <div class="approval-header">
        <span class="approval-id">${item.id}</span>
      </div>
      <div class="approval-caption">${item.caption || "<em>No description provided</em>"}</div>
      <div class="approval-timer" id="timer-${item.id}">
        <svg viewBox="0 0 24 24" width="16" height="16" style="flex-shrink:0;fill:currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
        <span>Calculating...</span>
      </div>
      <div class="approval-actions">
        <button class="btn-approve" onclick="doApprove('${item.id}')">Approve</button>
        <button class="btn-reject"  onclick="doReject('${item.id}')">Reject</button>
      </div>
    </div>`;
  return div;
}

/* Retry loading preview image for newly-arrived approvals whose media
   download may still be in progress on the server. */
const _previewRetries = {};
function schedulePreviewRetry(id, mediaType, attempt) {
  attempt = attempt || 1;
  if (attempt > 10) return; // Give up after 10 tries (~30 seconds)
  const delay = attempt * 3000;
  _previewRetries[id] = setTimeout(() => {
    const wrap = document.getElementById(`preview-wrap-${id}`);
    if (!wrap) return; // Card was removed (approved/rejected)
    // Create a fresh img to test availability
    const tester = new Image();
    tester.onload = () => {
      // Image is now available — update the card's img src to force reload
      const existingImg = wrap.querySelector('img');
      if (existingImg) {
        existingImg.onerror = null;
        existingImg.src = `/api/media/${id}?t=${Date.now()}`;
        wrap.style.cssText = '';
        const noPreview = document.getElementById(`no-prev-${id}`);
        if (noPreview) noPreview.remove();
      }
    };
    tester.onerror = () => schedulePreviewRetry(id, mediaType, attempt + 1);
    tester.src = `/api/media/${id}?t=${Date.now()}`;
  }, delay);
}

function startCountdown(id, createdAt) {
  if (state.timers[id]) clearInterval(state.timers[id]);
  const TIMEOUT = (parseFloat(30)) * 60000; // matches server default
  const tick = () => {
    const el = document.getElementById(`timer-${id}`);
    if (!el) { clearInterval(state.timers[id]); return; }
    const elapsed = Date.now() - createdAt;
    const remaining = Math.max(0, TIMEOUT - elapsed);
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const span = el.querySelector("span");
    if (span) span.textContent = `Expires in ${mins}m ${secs.toString().padStart(2, "0")}s`;
    if (remaining < 300000) el.style.color = "var(--danger)";
  };
  tick();
  state.timers[id] = setInterval(tick, 1000);
}

function renderMiniApprovals() {
  const list = document.getElementById("ov-approval-list");
  const approvals = Object.values(state.approvals);
  if (!list) {
    console.warn('renderMiniApprovals: ov-approval-list element not found');
    return;
  }
  if (approvals.length === 0) {
    list.innerHTML = `<div class="empty-state">No pending approvals</div>`;
    return;
  }
  list.innerHTML = "";
  for (const item of approvals.slice(0, 5)) {
    const div = document.createElement("div");
    div.className = "approval-mini-item";
    div.onclick = () => showSection("approvals", document.querySelector("[data-section=approvals]"));

    const svgIcon = item.mediaType === "video"
      ? `<svg viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`
      : `<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;

    div.innerHTML = `
      <div class="mini-icon">${svgIcon}</div>
      <div class="mini-body">
        <div class="mini-id">${item.id}</div>
        <div class="mini-caption">${item.caption || "No description"}</div>
      </div>`;
    list.appendChild(div);
  }
}
let currentApprovalId = null;

// ── Broadcast Modal Persistence (localStorage) ──────────────────────────
const BROADCAST_PREFS_KEY = "broadcast_prefs_v1";

function saveBroadcastPrefs() {
  const selectedJids = Array.from(document.querySelectorAll(".broadcast-group-cb:checked")).map(cb => cb.value);
  const delayVal = document.getElementById("broadcast-delay-input")?.value || "5";
  try {
    localStorage.setItem(BROADCAST_PREFS_KEY, JSON.stringify({ selectedJids, delay: delayVal }));
  } catch (e) { }
}

function loadBroadcastPrefs() {
  try {
    const raw = localStorage.getItem(BROADCAST_PREFS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { }
  return null;
}

function doApprove(id) {
  currentApprovalId = id;
  const card = document.getElementById(`card-${id}`);
  if (card) { card.style.opacity = "0.5"; card.style.pointerEvents = "none"; }

  // Load saved preferences
  const prefs = loadBroadcastPrefs();
  const savedJids = prefs?.selectedJids ? new Set(prefs.selectedJids) : null;
  const savedDelay = prefs?.delay || "5";

  // Set delay input
  const delayInput = document.getElementById("broadcast-delay-input");
  if (delayInput) delayInput.value = savedDelay;

  // Populate groups list
  const list = document.getElementById("broadcast-groups-list");
  if (list) {
    list.innerHTML = "";
    if (state.allGroups && state.allGroups.length > 0) {
      state.allGroups.forEach(g => {
        // Use saved selection if available, otherwise default to target groups
        const isChecked = savedJids ? savedJids.has(g.jid) : (g.isTarget && !g.isMain);
        const item = document.createElement("label");
        item.className = "broadcast-group-item";
        item.innerHTML = `
          <input type="checkbox" class="broadcast-group-cb" value="${g.jid}" ${isChecked ? 'checked' : ''} />
          <span class="broadcast-group-name">${escapeHtml(g.name || g.jid)}</span>
        `;
        // Save prefs whenever a checkbox changes
        item.querySelector("input").addEventListener("change", saveBroadcastPrefs);
        list.appendChild(item);
      });
    } else {
      list.innerHTML = `<div style="padding:10px;color:var(--text-faint);font-size:12px;">No groups found. Go to Group Manager tab first.</div>`;
    }
  }

  // Reset the toggle button
  updateSelectToggleBtn();
  document.getElementById("broadcast-modal").style.display = "flex";
}

function updateSelectToggleBtn() {
  const btn = document.getElementById("select-toggle-btn");
  if (!btn) return;
  const checkboxes = document.querySelectorAll(".broadcast-group-cb");
  const checked = document.querySelectorAll(".broadcast-group-cb:checked");
  const allSelected = checkboxes.length > 0 && checked.length === checkboxes.length;
  btn.textContent = allSelected ? "Deselect All" : "Select All";
}

function toggleSelectAllBroadcastGroups() {
  const checkboxes = document.querySelectorAll(".broadcast-group-cb");
  const checked = document.querySelectorAll(".broadcast-group-cb:checked");
  const allSelected = checkboxes.length > 0 && checked.length === checkboxes.length;
  // If all selected → deselect all, otherwise select all
  checkboxes.forEach(cb => { cb.checked = !allSelected; });
  updateSelectToggleBtn();
  saveBroadcastPrefs();
}

function closeBroadcastModal() {
  document.getElementById("broadcast-modal").style.display = "none";
  if (currentApprovalId) {
    const card = document.getElementById(`card-${currentApprovalId}`);
    if (card) { card.style.opacity = "1"; card.style.pointerEvents = ""; }
  }
  currentApprovalId = null;
}

async function confirmBroadcast() {
  if (!currentApprovalId) return;
  const id = currentApprovalId;
  const btn = document.getElementById("broadcast-confirm-btn");
  btn.classList.add("loading");

  const delayMs = parseInt(document.getElementById("broadcast-delay-input").value, 10) || 0;
  const targetGroups = Array.from(document.querySelectorAll(".broadcast-group-cb:checked")).map(cb => cb.value);

  // Persist these choices for next time
  saveBroadcastPrefs();

  try {
    const r = await fetch(`/api/approve/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetGroups, delayMs })
    });
    if (!r.ok) throw new Error((await r.json()).error);
    delete state.approvals[id];
    renderApprovals();
    renderMiniApprovals();
    showToast("✅ Approved", `Broadcasting #${id} to ${targetGroups.length} group(s)`, "success");
  } catch (e) {
    showToast("Error", e.message, "error");
  }

  btn.classList.remove("loading");
  closeBroadcastModal();
}

async function doReject(id) {
  const card = document.getElementById(`card-${id}`);
  if (card) { card.style.opacity = "0.5"; card.style.pointerEvents = "none"; }
  try {
    const r = await fetch(`/api/reject/${id}`, { method: "POST" });
    if (!r.ok) throw new Error((await r.json()).error);
    delete state.approvals[id];
    renderApprovals();
    renderMiniApprovals();
    showToast("Rejected", `Request #${id} discarded`, "warn");
  } catch (e) {
    if (card) { card.style.opacity = "1"; card.style.pointerEvents = ""; }
    showToast("Error", e.message, "error");
  }
}

/* ── Activity ────────────────────────────────────────────────────── */
function addActivity(type, data, ts) {
  addActivityItem(type, data, ts || Date.now());
}

const ACTIVITY_ICONS = {
  "bot:connected": "success",
  "bot:disconnected": "error",
  "approval:new": "info",
  "approval:resolved": "success",
  "approval:expired": "warn",
  "broadcast:start": "info",
  "broadcast:sent": "success",
  "broadcast:failed": "error",
  "broadcast:complete": "success",
};

const ACTIVITY_LABELS = {
  "bot:connected": () => "<strong>Bot connected</strong>",
  "bot:disconnected": () => "<strong>Bot disconnected</strong>",
  "approval:new": (d) => `<strong>New request</strong> &mdash; ${d.id} (${d.mediaType})`,
  "approval:resolved": (d) => `<strong>Request ${d.id}</strong> ${d.decision === "yes" ? "approved" : "rejected"}`,
  "approval:expired": (d) => `<strong>Request ${d.id}</strong> expired`,
  "broadcast:start": (d) => `<strong>Broadcast started</strong> &mdash; ${d.count} targets`,
  "broadcast:sent": (d) => `<strong>Sent</strong> to <code>${getGroupName(d.jid)}</code>`,
  "broadcast:failed": (d) => `<strong>Failed</strong> to <code>${getGroupName(d.jid)}</code>`,
  "broadcast:complete": (d) => `<strong>Complete</strong> &mdash; ${d.sent} sent, ${d.failed} failed`,
};

function getGroupName(jid) {
  if (!jid) return "";
  if (state.groups.mainGroup && state.groups.mainGroup.jid === jid) return state.groups.mainGroup.name || jid;
  if (state.groups.targetGroups) {
    const found = state.groups.targetGroups.find(g => g.jid === jid);
    if (found && found.name && found.name !== jid) return found.name;
  }
  return jid.length > 24 ? jid.slice(0, 18) + "…" : jid;
}

function addActivityItem(type, data, ts) {
  const iconClass = ACTIVITY_ICONS[type] || "info";
  const label = (ACTIVITY_LABELS[type] || (() => type))(data);
  const time = new Date(ts).toLocaleTimeString();

  const item = document.createElement("div");
  item.className = "activity-item";
  item.innerHTML = `
    <span class="activity-icon ${iconClass}"></span>
    <span class="activity-text">${label}</span>
    <span class="activity-time">${time}</span>`;

  // Full feed
  const feed = document.getElementById("activity-feed");
  if (feed) feed.prepend(item.cloneNode(true));

  // Overview mini feed (max 8 items)
  const ov = document.getElementById("ov-activity-list");
  if (ov) {
    ov.prepend(item.cloneNode(true));
    while (ov.children.length > 8) ov.removeChild(ov.lastChild);
  }
}

function clearActivityUI() {
  const feed = document.getElementById("activity-feed");
  if (feed) feed.innerHTML = "";
}

/* ── Groups Picker ────────────────────────────────────────────────── */

async function loadAllGroups() {
  const list = document.getElementById("all-groups-list");
  const status = document.getElementById("groups-list-status");
  if (!list) return;

  if (state.status !== "connected") {
    list.innerHTML = `<div class="empty-state"><div class="empty-sub">Bot is offline — group list is unavailable until connection is restored.</div></div>`;
    return;
  }

  try {
    if (status) status.textContent = "Loading groups…";
    list.innerHTML = `<div class="empty-state"><div class="empty-sub" id="groups-list-status">Loading groups…</div></div>`;

    const res = await fetch('/api/groups/all');
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Failed to load groups');

    state.allGroups = payload;
    renderGroupPicker(state.allGroups);
  } catch (e) {
    if (list) list.innerHTML = `<div class="empty-state"><div class="empty-sub" style="color:var(--danger)">${escapeHtml(e.message)}</div></div>`;
  }
}

function renderGroupPicker(groups) {
  const list = document.getElementById("all-groups-list");
  if (!list) return;
  if (!groups || !groups.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-sub">No groups found</div></div>`;
    return;
  }
  list.innerHTML = "";
  for (const g of state.allGroups) {
    list.appendChild(buildPickerRow(g));
  }

  if (!state.chat.openJid) {
    openGlobalFeed();
  }
}

function buildPickerRow(g) {
  const row = document.createElement("div");
  row.className = "picker-row" + (g.isMain ? " picker-row--main" : "");
  row.dataset.jid = g.jid;
  row.dataset.name = (g.name || "").toLowerCase();
  const initials = (g.name || "G").slice(0, 2).toUpperCase();
  const hue = [...g.jid].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const badges = (g.isMain ? `<span class="picker-badge picker-badge--main">Source</span>` : "")
    + (g.isTarget ? `<span class="picker-badge picker-badge--target">Broadcast</span>` : "");
  const safeJid = g.jid.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  // Create an escaped version of the JSON string for the HTML attribute
  // e.g. "Name" -> &quot;Name&quot;
  const safeNameHtml = escapeHtml(JSON.stringify(g.name || g.jid));

  row.innerHTML = `
    <div class="picker-avatar" style="background:hsl(${hue},55%,32%)">${initials}</div>
    <div class="picker-info">
      <div class="picker-name">${escapeHtml(g.name || g.jid)} ${badges}</div>
      <div class="picker-sub">${g.participantCount} member${g.participantCount !== 1 ? "s" : ""}</div>
    </div>
    <div class="picker-actions">
      <label class="picker-toggle" title="Add as broadcast target">
        <input type="checkbox" ${g.isTarget ? "checked" : ""} ${g.isMain ? "disabled" : ""}
          onchange="updatePickerTarget('${safeJid}', this.checked)" />
        <span class="picker-toggle-track"></span>
      </label>
      <button class="picker-chat-btn" onclick="openGroupChat('${safeJid}', ${safeNameHtml}, ${g.participantCount})" title="Open chat">
        <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
      </button>
    </div>`;
  return row;
}

function updateGroupLiveIndicator(jid, text) {
  const row = document.querySelector(`.picker-row[data-jid="${jid.replace(/"/g, "&quot;")}"]`);
  if (!row) return;
  const sub = row.querySelector(".picker-sub");
  if (!sub) return;
  const originalHtml = sub.dataset.originalHtml || sub.innerHTML;
  if (!sub.dataset.originalHtml) sub.dataset.originalHtml = originalHtml;

  sub.innerHTML = `<span style="color:var(--success);font-weight:500;">💬 ${escapeHtml(text).substring(0, 30)}${text.length > 30 ? "..." : ""}</span>`;
  clearTimeout(row.liveIndicatorTimer);
  row.liveIndicatorTimer = setTimeout(() => {
    sub.innerHTML = originalHtml;
  }, 4000);
}

function updatePickerTarget(jid, checked) {
  const g = state.allGroups.find(x => x.jid === jid);
  if (g) g.isTarget = checked;
}

function filterGroupsList(query) {
  const q = (query || "").toLowerCase();
  for (const row of document.querySelectorAll(".picker-row")) {
    row.style.display = (row.dataset.name || "").includes(q) ? "" : "none";
  }
}

async function saveGroupsFromPicker() {
  const btn = document.getElementById("groups-save-btn");
  if (btn) { btn.classList.add("loading"); btn.disabled = true; }
  try {
    const targets = state.allGroups.filter(g => g.isTarget && !g.isMain).map(g => g.jid);
    const r = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetGroups: targets }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    showSaveMsg("✓ Broadcast targets saved!", "ok");
    showToast("✅ Saved", `${targets.length} broadcast target${targets.length !== 1 ? "s" : ""} saved`, "success");
    setTimeout(loadAllGroups, 600);
  } catch (e) {
    showSaveMsg("Error: " + e.message, "err");
  } finally {
    if (btn) { btn.classList.remove("loading"); btn.disabled = false; }
  }
}

/* ── Group Chat ─────────────────────────────────────────────────── */

function openGlobalFeed() {
  state.chat.openJid = "GLOBAL";
  state.chat.openName = "All Groups Live Feed";
  state.chat.participantCount = 0;

  const avatarEl = document.getElementById("chat-header-avatar");
  if (avatarEl) { avatarEl.textContent = ""; avatarEl.style.background = `var(--accent)`; }
  setText("chat-header-name", "All Groups Live Feed");
  setText("chat-header-sub", "Live messages from all groups");

  const emptyEl = document.getElementById("chat-empty");
  if (emptyEl) emptyEl.style.display = "none";
  const activeEl = document.getElementById("chat-active");
  if (activeEl) activeEl.style.display = "flex";

  const msgEl = document.getElementById("chat-messages");
  if (msgEl) msgEl.innerHTML = `<div class="chat-day-divider"><span>Listening for live messages from all groups...</span></div>`;
  const composeEl = document.getElementById("chat-compose");
  if (composeEl) composeEl.style.display = "none";
}

function closeGroupChat() {
  openGlobalFeed();
}

async function openGroupChat(jid, name, participantCount) {
  state.chat.openJid = jid;
  state.chat.openName = name;
  state.chat.participantCount = participantCount;
  fetch("/api/chat/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jid }) });

  const initials = (name || "G").slice(0, 2).toUpperCase();
  const hue = [...jid].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const avatarEl = document.getElementById("chat-header-avatar");
  if (avatarEl) { avatarEl.textContent = initials; avatarEl.style.background = `hsl(${hue},55%,32%)`; }
  setText("chat-header-name", name);
  setText("chat-header-sub", `${participantCount} member${participantCount !== 1 ? "s" : ""}`);

  const emptyEl2 = document.getElementById("chat-empty");
  if (emptyEl2) emptyEl2.style.display = "none";
  const activeEl = document.getElementById("chat-active");
  if (activeEl) activeEl.style.display = "flex";
  const composeEl2 = document.getElementById("chat-compose");
  if (composeEl2) composeEl2.style.display = "flex";

  const msgEl = document.getElementById("chat-messages");
  msgEl.innerHTML = `<div class="chat-loading"><div class="chat-loading-dot"></div><div class="chat-loading-dot"></div><div class="chat-loading-dot"></div></div>`;

  try {
    const res = await fetch(`/api/chat/${encodeURIComponent(jid)}`);
    const data = await res.json();
    msgEl.innerHTML = "";
    if (!data.messages || !data.messages.length) {
      msgEl.innerHTML = `<div class="chat-day-divider"><span>No history — live messages appear below</span></div>`;
    } else {
      for (const m of data.messages) appendChatBubble(m, true);
    }
  } catch {
    msgEl.innerHTML = `<div class="chat-day-divider"><span>Could not load history</span></div>`;
  }
  scrollChatToBottom();
  document.getElementById("chat-input")?.focus();
}

function closeGroupChat() {
  state.chat.openJid = null;
  const emptyEl3 = document.getElementById("chat-empty");
  if (emptyEl3) emptyEl3.style.display = "";
  const activeEl3 = document.getElementById("chat-active");
  if (activeEl3) activeEl3.style.display = "none";
  const msgsEl = document.getElementById("chat-messages");
  if (msgsEl) msgsEl.innerHTML = "";
  fetch("/api/chat/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jid: null }) });
}

async function sendChatMessage() {
  const input = document.getElementById("chat-input");
  const text = input?.value?.trim();
  if (!text || !state.chat.openJid) return;
  const btn = document.getElementById("chat-send-btn");
  if (btn) btn.disabled = true;
  input.value = "";
  appendChatBubble({ fromMe: true, text, ts: Date.now() }, false);
  scrollChatToBottom();
  try {
    const r = await fetch(`/api/chat/${encodeURIComponent(state.chat.openJid)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
  } catch (e) {
    showToast("Send failed", e.message, "error");
  } finally {
    if (btn) btn.disabled = false;
    input?.focus();
  }
}

function appendChatBubble(msg, prepend = false) {
  const msgEl = document.getElementById("chat-messages");
  if (!msgEl) return;
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble " + (msg.fromMe ? "sent" : "received");
  const time = new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  let senderNum = !msg.fromMe && msg.sender ? msg.sender.split("@")[0].slice(-4) : "";

  if (state.chat.openJid === "GLOBAL") {
    const g = state.allGroups.find(x => x.jid === msg.jid);
    const groupName = g ? g.name : "Group";
    senderNum = `${groupName} • ${senderNum}`;
  }

  // Build media tag if this message has image/video
  let mediaHtml = "";
  if (msg.mediaType && msg.id && state.chat.openJid && state.chat.openJid !== "GLOBAL") {
    const mediaSrc = `/api/chat/${encodeURIComponent(state.chat.openJid)}/media/${encodeURIComponent(msg.id)}`;
    if (msg.mediaType === "video") {
      mediaHtml = `<div class="bubble-media"><video src="${mediaSrc}" controls playsinline preload="none" style="max-width:100%;max-height:280px;border-radius:8px;display:block;"></video></div>`;
    } else {
      mediaHtml = `<div class="bubble-media"><img src="${mediaSrc}" alt="image" loading="lazy" style="max-width:100%;max-height:280px;border-radius:8px;display:block;cursor:pointer;" onclick="window.open(this.src,'_blank')"></div>`;
    }
  }

  const textHtml = msg.text ? `<div class="bubble-text">${escapeHtml(msg.text)}</div>` : "";
  bubble.innerHTML =
    (!msg.fromMe && senderNum ? `<div class="bubble-sender">${escapeHtml(senderNum)}</div>` : "") +
    mediaHtml +
    textHtml +
    `<div class="bubble-time">${time}${msg.fromMe ? " ✓" : ""}</div>`;
  if (prepend) msgEl.prepend(bubble); else { msgEl.appendChild(bubble); scrollChatToBottom(); }
}

function scrollChatToBottom() {
  const el = document.getElementById("chat-messages");
  if (el) el.scrollTop = el.scrollHeight;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}



function showSaveMsg(msg, cls) {
  const el = document.getElementById("save-msg") || document.getElementById("groups-save-msg");
  if (!el) return;
  el.textContent = msg;
  el.className = "save-msg " + cls;
  setTimeout(() => { el.textContent = ""; el.className = "save-msg"; }, 3500);
}

/* ── Toast notifications ─────────────────────────────────────────── */
let toastContainer;
function getToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.className = "toast-container";
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

function showToast(title, body, type = "") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-title">${title}</div><div class="toast-body">${body}</div>`;
  getToastContainer().appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.4s";
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}
