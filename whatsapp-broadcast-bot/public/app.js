/* ── State ───────────────────────────────────────────────────────── */
const state = {
  approvals: {},   // id → { id, mediaType, caption, createdAt, hasPreview }
  stats: { sentToday: 0, pending: 0, failed: 0, targetGroupCount: 0 },
  groups: { mainGroup: "", targetGroups: [] },
  timers: {},      // id → setInterval handle for countdown
};

/* ── Socket.IO ───────────────────────────────────────────────────── */
const socket = io();

socket.on("init", ({ status, pending, logs, stats }) => {
  setStatus(status);
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

socket.on("bot:connected",    () => { setStatus("connected"); addActivity("bot:connected", {}); });
socket.on("bot:disconnected", () => { setStatus("disconnected"); addActivity("bot:disconnected", {}); });
socket.on("status:update", ({ status }) => setStatus(status));

socket.on("approval:new", (data) => {
  state.approvals[data.id] = data;
  renderApprovals();
  renderMiniApprovals();
  updatePendingCount();
  addActivity("approval:new", data);
  showToast("🔔 New Approval Request", `${data.mediaType} — ID ${data.id}`, "warn");
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

socket.on("broadcast:start",    (d) => addActivity("broadcast:start", d));
socket.on("broadcast:sent",     (d) => { state.stats.sentToday++; updateStatsUI(); addActivity("broadcast:sent", d); });
socket.on("broadcast:failed",   (d) => { state.stats.failed++; updateStatsUI(); addActivity("broadcast:failed", d); });
socket.on("broadcast:complete", (d) => { addActivity("broadcast:complete", d); showToast("✅ Broadcast Complete", `Sent: ${d.sent} | Failed: ${d.failed}`, d.failed > 0 ? "warn" : "success"); });
socket.on("stats:update",       (s) => updateStats(s));
socket.on("groups:updated",     (g) => { state.groups = g; renderGroups(); });

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
    renderGroups();
  } catch (e) {
    console.warn("Initial data load failed:", e);
  }
}
loadInitialData();

/* ── Sections ────────────────────────────────────────────────────── */
function showSection(name, el) {
  document.querySelectorAll(".content-section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById("section-" + name).classList.add("active");
  if (el) el.classList.add("active");
  const titles = { overview: "Overview", approvals: "Pending Approvals", activity: "Activity Feed", groups: "Group Manager" };
  document.getElementById("page-title").textContent = titles[name] || name;
}

/* ── Status ──────────────────────────────────────────────────────── */
function setStatus(status) {
  const dot  = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  const pill = document.getElementById("status-pill");
  dot.className = "status-dot " + status;
  text.textContent = status === "connected" ? "Connected" : "Disconnected";
  pill.style.borderColor = status === "connected" ? "rgba(0,212,170,0.3)" : "rgba(255,71,87,0.3)";
}

/* ── Stats ───────────────────────────────────────────────────────── */
function updateStats(s) {
  if (s.sentToday !== undefined) state.stats.sentToday = s.sentToday;
  if (s.pending    !== undefined) state.stats.pending   = s.pending;
  if (s.failed     !== undefined) state.stats.failed    = s.failed;
  if (s.targetGroupCount !== undefined) state.stats.targetGroupCount = s.targetGroupCount;
  updateStatsUI();
}

function updateStatsUI() {
  setText("stat-sent",    state.stats.sentToday);
  setText("stat-pending", state.stats.pending);
  setText("stat-failed",  state.stats.failed);
  setText("stat-groups",  state.stats.targetGroupCount);
  setText("ov-sent",      state.stats.sentToday);
  setText("ov-pending",   state.stats.pending);
  setText("ov-failed",    state.stats.failed);
  setText("ov-groups",    state.stats.targetGroupCount);
}

function updatePendingCount() {
  const count = Object.keys(state.approvals).length;
  state.stats.pending = count;
  updateStatsUI();
  const badge = document.getElementById("badge-pending");
  badge.textContent = count;
  badge.className = "badge" + (count > 0 ? " visible" : "");
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ── Approvals ───────────────────────────────────────────────────── */
function renderApprovals() {
  const grid = document.getElementById("approval-grid");
  const approvals = Object.values(state.approvals);

  if (approvals.length === 0) {
    grid.innerHTML = `<div class="empty-state full">
      <div class="empty-icon">🎉</div>
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

  const previewHTML = item.hasPreview
    ? `<div class="approval-preview"><img src="/api/media/${item.id}" alt="preview" /><div class="preview-overlay">${item.mediaType}</div></div>`
    : `<div class="approval-preview" style="display:flex;align-items:center;justify-content:center;height:200px;background:#000;">
         <div style="width:48px;height:48px;fill:rgba(255,255,255,0.2)">${svgIcon}</div>
       </div>`;

  div.innerHTML = `
    ${previewHTML}
    <div class="approval-body">
      <div class="approval-header">
        <span class="approval-id">${item.id}</span>
      </div>
      <div class="approval-caption">${item.caption || "<em>No description provided</em>"}</div>
      <div class="approval-timer" id="timer-${item.id}">
        <svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
        <span>Calculating...</span>
      </div>
      <div class="approval-actions">
        <button class="btn-approve" onclick="doApprove('${item.id}')">Approve</button>
        <button class="btn-reject"  onclick="doReject('${item.id}')">Reject</button>
      </div>
    </div>`;
  return div;
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

async function doApprove(id) {
  const card = document.getElementById(`card-${id}`);
  if (card) { card.style.opacity = "0.5"; card.style.pointerEvents = "none"; }
  try {
    const r = await fetch(`/api/approve/${id}`, { method: "POST" });
    if (!r.ok) throw new Error((await r.json()).error);
    delete state.approvals[id];
    renderApprovals();
    renderMiniApprovals();
    showToast("Approved", `Broadcasting #${id}`, "success");
  } catch (e) {
    if (card) { card.style.opacity = "1"; card.style.pointerEvents = ""; }
    showToast("Error", e.message, "error");
  }
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
  "bot:connected":    "success",
  "bot:disconnected": "error",
  "approval:new":     "info",
  "approval:resolved":"success",
  "approval:expired": "warn",
  "broadcast:start":  "info",
  "broadcast:sent":   "success",
  "broadcast:failed": "error",
  "broadcast:complete":"success",
};

const ACTIVITY_LABELS = {
  "bot:connected":    () => "<strong>Bot connected</strong>",
  "bot:disconnected": () => "<strong>Bot disconnected</strong>",
  "approval:new":     (d) => `<strong>New request</strong> &mdash; ${d.id} (${d.mediaType})`,
  "approval:resolved":(d) => `<strong>Request ${d.id}</strong> ${d.decision === "yes" ? "approved" : "rejected"}`,
  "approval:expired": (d) => `<strong>Request ${d.id}</strong> expired`,
  "broadcast:start":  (d) => `<strong>Broadcast started</strong> &mdash; ${d.count} targets`,
  "broadcast:sent":   (d) => `<strong>Sent</strong> to <code>${getGroupName(d.jid)}</code>`,
  "broadcast:failed": (d) => `<strong>Failed</strong> to <code>${getGroupName(d.jid)}</code>`,
  "broadcast:complete":(d)=> `<strong>Complete</strong> &mdash; ${d.sent} sent, ${d.failed} failed`,
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
  const iconClass  = ACTIVITY_ICONS[type]  || "info";
  const label = (ACTIVITY_LABELS[type] || (() => type))(data);
  const time  = new Date(ts).toLocaleTimeString();

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

/* ── Groups ──────────────────────────────────────────────────────── */
function renderGroups() {
  const mainEl = document.getElementById("main-group-display");
  if (mainEl) {
    const mg = state.groups.mainGroup;
    mainEl.textContent = mg ? (mg.name || mg.jid) : "Not configured";
  }

  const list = document.getElementById("groups-list");
  if (!list) return;
  list.innerHTML = "";

  for (const group of (state.groups.targetGroups || [])) {
    list.appendChild(buildGroupRow(group.jid, group.name));
  }
  const count = (state.groups.targetGroups || []).length;
  setText("stat-groups", count);
  setText("ov-groups", count);
}

function buildGroupRow(jid, name) {
  const div = document.createElement("div");
  div.className = "group-row";
  div.dataset.jid = jid;
  const displayName = (name && name !== jid) ? `<strong>${name}</strong> <span style="opacity:0.5;font-size:11px;">(${jid})</span>` : jid;
  div.innerHTML = `
    <span class="group-row-jid">${displayName}</span>
    <button class="group-row-del" onclick="removeGroupRow(this)" title="Remove">
      <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </button>`;
  return div;
}

function removeGroupRow(btn) {
  btn.closest(".group-row").remove();
}

function addGroupRow() {
  const jidInput   = document.getElementById("new-group-jid");
  const jid = jidInput.value.trim();
  if (!jid || !jid.includes("@g.us")) {
    showSaveMsg("Invalid format. Use 123@g.us", "err");
    return;
  }
  document.getElementById("groups-list").appendChild(buildGroupRow(jid));
  jidInput.value = "";
  document.getElementById("new-group-label").value = "";
}

async function saveGroups() {
  const rows = document.querySelectorAll("#groups-list .group-row");
  const targetGroups = [...rows].map(r => r.dataset.jid).filter(Boolean);
  // When saving, the backend only expects the array of JIDs.
  const payload = { targetGroups };
  try {
    const r = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    // The server will emit 'groups:updated' with the resolved names which updates state automatically
    showSaveMsg("Saved", "ok");
  } catch (e) {
    showSaveMsg("Error: " + e.message, "err");
  }
}

function showSaveMsg(msg, cls) {
  const el = document.getElementById("groups-save-msg");
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
