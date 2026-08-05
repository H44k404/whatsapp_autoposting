/* ════════════════════════════════════════════════════════════════════════
   BROADCAST AI — Dashboard logic
   Real-time state driven by Socket.IO. All motion below reacts to genuine
   data changes — nothing here is decorative-only or fake.
   ════════════════════════════════════════════════════════════════════════ */

/* ── State ───────────────────────────────────────────────────────── */
const state = {
  approvals: {},   // id → { id, mediaType, caption, createdAt, hasPreview }
  stats: { sentToday: 0, pending: 0, failed: 0, targetGroupCount: 0 },
  groups: { mainGroup: "", targetGroups: [] },
  timers: {},      // id → setInterval handle for countdown
  sentHistory: [],   // rolling buffer of sent counts for the sparkline
  notifications: [], // recent notification-worthy events
  unreadNotifs: 0,
};

const TIMEOUT_MS = 30 * 60000; // matches server default (APPROVAL_TIMEOUT_MINUTES)

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
  for (const entry of [...logs].reverse()) addActivityItem(entry.type, entry.data, entry.ts, false);
  // Update stats from server
  if (stats) updateStats({ ...stats, pending: pending.length }, false);
  positionNavPill();
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
  pushNotification("🔔 New Approval Request", `${data.mediaType} — ID ${data.id}`, "warn");
  showToast("New Approval Request", `${data.mediaType} — ID ${data.id}`, "warn");
});

socket.on("approval:resolved", ({ id, decision }) => {
  removeApprovalCard(id);
  addActivity("approval:resolved", { id, decision });
});

socket.on("approval:expired", ({ id }) => {
  removeApprovalCard(id);
  addActivity("approval:expired", { id });
  pushNotification("⏱ Request Expired", `Approval ${id} timed out`, "warn");
});

socket.on("broadcast:start",    (d) => addActivity("broadcast:start", d));
socket.on("broadcast:sent",     (d) => { state.stats.sentToday++; recordSentTick(); updateStatsUI(); addActivity("broadcast:sent", d); });
socket.on("broadcast:failed",   (d) => { state.stats.failed++; updateStatsUI(); addActivity("broadcast:failed", d); });
socket.on("broadcast:complete", (d) => {
  addActivity("broadcast:complete", d);
  const kind = d.failed > 0 ? "warn" : "success";
  showToast("Broadcast Complete", `Sent: ${d.sent} · Failed: ${d.failed}`, kind);
  pushNotification("✅ Broadcast Complete", `Sent: ${d.sent} · Failed: ${d.failed}`, kind);
});
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
    }, false);
    state.groups = groupsRes;
    renderGroups();
  } catch (e) {
    console.warn("Initial data load failed:", e);
  }
  drawSparkline();
}
loadInitialData();

/* ── Sidebar nav (sliding pill indicator) ───────────────────────────── */
function positionNavPill() {
  const pill = document.getElementById("nav-pill");
  const active = document.querySelector(".nav-item.active");
  if (!pill || !active) return;
  const nav = document.getElementById("sidebar-nav");
  const navRect = nav.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  pill.style.transform = `translateY(${rect.top - navRect.top}px)`;
  pill.style.height = rect.height + "px";
  requestAnimationFrame(() => pill.classList.add("ready"));
}
window.addEventListener("resize", positionNavPill);
window.addEventListener("load", positionNavPill);
setTimeout(positionNavPill, 60);

/* ── Sections ────────────────────────────────────────────────────── */
function showSection(name, el) {
  document.querySelectorAll(".content-section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById("section-" + name).classList.add("active");
  if (el) el.classList.add("active");
  const titles = { overview: "Overview", approvals: "Pending Approvals", activity: "Activity Feed", groups: "Group Manager" };
  document.getElementById("page-title").textContent = titles[name] || name;
  positionNavPill();
}

/* ── Status ──────────────────────────────────────────────────────── */
function setStatus(status) {
  const dot  = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  const pill = document.getElementById("status-pill");
  dot.className = "status-dot " + status;
  text.textContent = status === "connected" ? "Connected" : "Disconnected";
  pill.style.borderColor = status === "connected" ? "rgba(34,211,168,0.3)" : "rgba(245,69,92,0.3)";
}

/* ── Stats (with count-up animation) ────────────────────────────────── */
function updateStats(s, animate = true) {
  if (s.sentToday !== undefined) state.stats.sentToday = s.sentToday;
  if (s.pending    !== undefined) state.stats.pending   = s.pending;
  if (s.failed     !== undefined) state.stats.failed    = s.failed;
  if (s.targetGroupCount !== undefined) state.stats.targetGroupCount = s.targetGroupCount;
  updateStatsUI(animate);
}

const _lastDisplayed = {};

function updateStatsUI(animate = true) {
  animatedSetText("stat-sent",    state.stats.sentToday, animate);
  animatedSetText("stat-pending", state.stats.pending, animate);
  animatedSetText("stat-failed",  state.stats.failed, animate);
  setText("stat-groups",  state.stats.targetGroupCount);
  animatedSetText("ov-sent",      state.stats.sentToday, animate);
  animatedSetText("ov-pending",   state.stats.pending, animate);
  animatedSetText("ov-failed",    state.stats.failed, animate);
  setText("ov-groups",    state.stats.targetGroupCount);
}

function updatePendingCount() {
  const count = Object.keys(state.approvals).length;
  state.stats.pending = count;
  updateStatsUI();
  const badge = document.getElementById("badge-pending");
  badge.textContent = count;
  const wasVisible = badge.classList.contains("visible");
  badge.className = "badge" + (count > 0 ? " visible" : "");
  if (count > 0 && wasVisible) {
    badge.classList.remove("bump");
    requestAnimationFrame(() => badge.classList.add("bump"));
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// Animates a number counting up/down from its previous displayed value,
// and gives it a satisfying "bump" pulse when it changes.
function animatedSetText(id, target, animate = true) {
  const el = document.getElementById(id);
  if (!el) return;
  const from = _lastDisplayed[id] !== undefined ? _lastDisplayed[id] : target;
  _lastDisplayed[id] = target;

  if (!animate || from === target) {
    el.textContent = target;
    return;
  }

  const duration = 500;
  const start = performance.now();
  const diff = target - from;

  function tick(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out-cubic
    const val = Math.round(from + diff * eased);
    el.textContent = val;
    if (p < 1) {
      requestAnimationFrame(tick);
    } else {
      el.textContent = target;
      el.classList.remove("bump");
      requestAnimationFrame(() => el.classList.add("bump"));
    }
  }
  requestAnimationFrame(tick);
}

/* ── Sparkline (Sent Today mini-chart in topbar) ────────────────────── */
function recordSentTick() {
  state.sentHistory.push(state.stats.sentToday);
  if (state.sentHistory.length > 20) state.sentHistory.shift();
  drawSparkline();
}

function drawSparkline() {
  const canvas = document.getElementById("spark-sent");
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  let data = state.sentHistory.length >= 2 ? state.sentHistory : [0, state.stats.sentToday || 0];
  const max = Math.max(1, ...data);
  const min = Math.min(...data);
  const range = Math.max(1, max - min);
  const stepX = w / (data.length - 1 || 1);
  const pad = 4;

  ctx.beginPath();
  data.forEach((v, i) => {
    const x = i * stepX;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "rgba(34, 211, 168, 0.9)";
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  // Filled gradient area under the line
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(34, 211, 168, 0.28)");
  grad.addColorStop(1, "rgba(34, 211, 168, 0)");
  ctx.fillStyle = grad;
  ctx.fill();
}

/* ── Approvals ───────────────────────────────────────────────────── */
function renderApprovals() {
  const grid = document.getElementById("approval-grid");
  const approvals = Object.values(state.approvals);

  if (approvals.length === 0) {
    grid.innerHTML = `<div class="empty-state full">
      <div class="empty-icon"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg></div>
      <div class="empty-title">All Caught Up</div>
      <div class="empty-sub">No pending approvals right now. Post an image or video in the main group to get started.</div>
    </div>`;
    updatePendingCount();
    return;
  }

  const existingIds = new Set([...grid.querySelectorAll(".approval-card")].map(c => c.id));
  grid.innerHTML = "";
  for (const item of approvals) {
    const card = buildApprovalCard(item);
    const cardId = `card-${item.id}`;
    if (!existingIds.has(cardId)) card.classList.add("entering");
    grid.appendChild(card);
    startCountdown(item.id, item.createdAt);
  }
  updatePendingCount();
}

function buildApprovalCard(item) {
  const div = document.createElement("div");
  div.className = "approval-card";
  div.id = `card-${item.id}`;

  const svgIconVideo = `<svg viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`;
  const svgIconImage = `<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;
  const svgIcon = item.mediaType === "video" ? svgIconVideo : svgIconImage;

  const previewHTML = item.hasPreview
    ? `<div class="approval-preview"><img src="/api/media/${item.id}" alt="preview" loading="lazy" /><div class="preview-overlay">${svgIcon}${item.mediaType}</div></div>`
    : `<div class="approval-preview no-preview-icon">${svgIcon}</div>`;

  div.innerHTML = `
    ${previewHTML}
    <div class="approval-body">
      <div class="approval-header">
        <span class="approval-id">#${item.id}</span>
      </div>
      <div class="approval-caption">${item.caption ? escapeHtml(item.caption) : "<em>No description provided</em>"}</div>
      <div class="approval-timer" id="timer-${item.id}">
        <svg class="timer-ring" viewBox="0 0 20 20">
          <circle class="ring-bg" cx="10" cy="10" r="8"></circle>
          <circle class="ring-fg" cx="10" cy="10" r="8" stroke-dasharray="50.27" stroke-dashoffset="0"></circle>
        </svg>
        <span>Calculating…</span>
      </div>
      <div class="approval-actions">
        <button class="btn-approve" onclick="doApprove('${item.id}', event)">
          <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          Approve
        </button>
        <button class="btn-reject" onclick="doReject('${item.id}', event)">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          Reject
        </button>
      </div>
    </div>`;
  return div;
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 8; // r=8

function startCountdown(id, createdAt) {
  if (state.timers[id]) clearInterval(state.timers[id]);
  const tick = () => {
    const el = document.getElementById(`timer-${id}`);
    if (!el) { clearInterval(state.timers[id]); return; }
    const elapsed = Date.now() - createdAt;
    const remaining = Math.max(0, TIMEOUT_MS - elapsed);
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const span = el.querySelector("span");
    if (span) span.textContent = `Expires in ${mins}m ${secs.toString().padStart(2, "0")}s`;

    const ring = el.querySelector(".ring-fg");
    if (ring) {
      const frac = Math.max(0, remaining / TIMEOUT_MS);
      ring.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - frac);
    }
    el.classList.toggle("urgent", remaining < 300000);
  };
  tick();
  state.timers[id] = setInterval(tick, 1000);
}

function removeApprovalCard(id) {
  const card = document.getElementById(`card-${id}`);
  if (card) {
    card.classList.add("resolving");
    setTimeout(() => {
      delete state.approvals[id];
      clearInterval(state.timers[id]);
      delete state.timers[id];
      renderApprovals();
      renderMiniApprovals();
    }, 260);
  } else {
    delete state.approvals[id];
    clearInterval(state.timers[id]);
    delete state.timers[id];
    renderApprovals();
    renderMiniApprovals();
  }
  updatePendingCount();
}

function renderMiniApprovals() {
  const list = document.getElementById("ov-approval-list");
  const approvals = Object.values(state.approvals);
  if (approvals.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding:28px 12px;">
      <div class="empty-icon" style="width:48px;height:48px;">
        <svg viewBox="0 0 24 24" style="width:22px;height:22px;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
      </div>
      <div class="empty-sub">No pending approvals</div>
    </div>`;
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
        <div class="mini-id">#${item.id}</div>
        <div class="mini-caption">${item.caption ? escapeHtml(item.caption) : "No description"}</div>
      </div>
      <svg class="mini-chevron" viewBox="0 0 24 24"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>`;
    list.appendChild(div);
  }
}

async function doApprove(id, evt) {
  spawnRipple(evt);
  const card = document.getElementById(`card-${id}`);
  setCardBusy(card, true);
  try {
    const r = await fetch(`/api/approve/${id}`, { method: "POST" });
    if (!r.ok) throw new Error((await r.json()).error);
    removeApprovalCard(id);
    showToast("Approved", `Broadcasting #${id} to all target groups`, "success");
  } catch (e) {
    setCardBusy(card, false);
    showToast("Error", e.message, "error");
  }
}

async function doReject(id, evt) {
  spawnRipple(evt);
  const card = document.getElementById(`card-${id}`);
  setCardBusy(card, true);
  try {
    const r = await fetch(`/api/reject/${id}`, { method: "POST" });
    if (!r.ok) throw new Error((await r.json()).error);
    removeApprovalCard(id);
    showToast("Rejected", `Request #${id} discarded`, "warn");
  } catch (e) {
    setCardBusy(card, false);
    showToast("Error", e.message, "error");
  }
}

function setCardBusy(card, busy) {
  if (!card) return;
  card.style.opacity = busy ? "0.55" : "1";
  card.style.pointerEvents = busy ? "none" : "";
  card.querySelectorAll("button").forEach(b => b.disabled = busy);
}

function spawnRipple(evt) {
  if (!evt || !evt.currentTarget) return;
  const btn = evt.currentTarget;
  const rect = btn.getBoundingClientRect();
  const ripple = document.createElement("span");
  const size = Math.max(rect.width, rect.height);
  ripple.className = "btn-ripple";
  ripple.style.width = ripple.style.height = size + "px";
  ripple.style.left = (evt.clientX - rect.left - size / 2) + "px";
  ripple.style.top = (evt.clientY - rect.top - size / 2) + "px";
  btn.style.position = "relative";
  btn.style.overflow = "hidden";
  btn.appendChild(ripple);
  setTimeout(() => ripple.remove(), 650);
}

/* ── Activity ────────────────────────────────────────────────────── */
function addActivity(type, data, ts) {
  addActivityItem(type, data, ts || Date.now(), true);
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

const ACTIVITY_SVGS = {
  connected:    `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
  disconnected: `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`,
  new:          `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`,
  resolved:     `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
  expired:      `<svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
  broadcast:    `<svg viewBox="0 0 24 24"><path d="M12 3v2.05c3.39.49 6 3.39 6 6.92s-2.61 6.43-6 6.92V21c4.49-.51 8-4.4 8-9.05S16.49 3.49 12 3zm-2 9l-3-3v2H5v2h2v2l3-3z"/></svg>`,
  sent:         `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`,
  failed:       `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`,
  complete:     `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
};

const ACTIVITY_ICON_KEYS = {
  "bot:connected": "connected", "bot:disconnected": "disconnected",
  "approval:new": "new", "approval:resolved": "resolved", "approval:expired": "expired",
  "broadcast:start": "broadcast", "broadcast:sent": "sent", "broadcast:failed": "failed", "broadcast:complete": "complete",
};

const ACTIVITY_LABELS = {
  "bot:connected":    () => "<strong>Bot connected</strong>",
  "bot:disconnected": () => "<strong>Bot disconnected</strong>",
  "approval:new":     (d) => `<strong>New request</strong> &mdash; #${d.id} (${d.mediaType})`,
  "approval:resolved":(d) => `<strong>Request #${d.id}</strong> ${d.decision === "yes" ? "approved" : "rejected"}`,
  "approval:expired": (d) => `<strong>Request #${d.id}</strong> expired`,
  "broadcast:start":  (d) => `<strong>Broadcast started</strong> &mdash; ${d.count} targets`,
  "broadcast:sent":   (d) => `<strong>Sent</strong> to <code>${escapeHtml(getGroupName(d.jid))}</code>`,
  "broadcast:failed": (d) => `<strong>Failed</strong> to <code>${escapeHtml(getGroupName(d.jid))}</code>`,
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

function addActivityItem(type, data, ts, animateIn) {
  const iconClass  = ACTIVITY_ICONS[type]  || "info";
  const iconKey = ACTIVITY_ICON_KEYS[type] || "new";
  const label = (ACTIVITY_LABELS[type] || (() => type))(data);
  const time  = new Date(ts).toLocaleTimeString();

  const item = document.createElement("div");
  item.className = "activity-item" + (animateIn ? " entering" : "");
  item.innerHTML = `
    <span class="activity-icon-wrap ${iconClass}">${ACTIVITY_SVGS[iconKey] || ""}</span>
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

/* ── Groups ──────────────────────────────────────────────────────── */
function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]).join("").toUpperCase();
}

function renderGroups() {
  const mainEl = document.getElementById("main-group-display");
  if (mainEl) {
    const mg = state.groups.mainGroup;
    const label = mg ? (mg.name || mg.jid) : "Not configured";
    mainEl.innerHTML = mg
      ? `<span class="group-avatar-badge">${initials(mg.name || "?")}</span><span>${escapeHtml(label)}</span>`
      : `<span>${label}</span>`;
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
  const displayName = (name && name !== jid)
    ? `<strong>${escapeHtml(name)}</strong><span style="opacity:0.55;font-size:11px;">${escapeHtml(jid)}</span>`
    : escapeHtml(jid);
  div.innerHTML = `
    <div class="group-row-avatar">${initials(name || "#")}</div>
    <span class="group-row-jid">${displayName}</span>
    <button class="group-row-del" onclick="removeGroupRow(this)" title="Remove">
      <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </button>`;
  return div;
}

function removeGroupRow(btn) {
  const row = btn.closest(".group-row");
  row.classList.add("removing");
  setTimeout(() => row.remove(), 220);
}

function addGroupRow() {
  const jidInput = document.getElementById("new-group-jid");
  const jid = jidInput.value.trim();
  if (!jid || !jid.includes("@g.us")) {
    jidInput.classList.remove("invalid");
    requestAnimationFrame(() => jidInput.classList.add("invalid"));
    showSaveMsg("Invalid format. Use 123456789@g.us", "err");
    setTimeout(() => jidInput.classList.remove("invalid"), 450);
    return;
  }
  const row = buildGroupRow(jid);
  row.classList.add("entering");
  document.getElementById("groups-list").appendChild(row);
  jidInput.value = "";
  jidInput.focus();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.activeElement && document.activeElement.id === "new-group-jid") {
    addGroupRow();
  }
});

async function saveGroups() {
  const btn = document.getElementById("save-groups-btn");
  const rows = document.querySelectorAll("#groups-list .group-row:not(.removing)");
  const targetGroups = [...rows].map(r => r.dataset.jid).filter(Boolean);
  const payload = { targetGroups };
  if (btn) btn.classList.add("loading");
  try {
    const r = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    // The server will emit 'groups:updated' with the resolved names which updates state automatically
    showSaveMsg("✓ Changes saved successfully", "ok");
    showToast("Groups Updated", `${targetGroups.length} target group(s) saved`, "success");
  } catch (e) {
    showSaveMsg("Error: " + e.message, "err");
    showToast("Save Failed", e.message, "error");
  } finally {
    if (btn) btn.classList.remove("loading");
  }
}

function showSaveMsg(msg, cls) {
  const el = document.getElementById("groups-save-msg");
  if (!el) return;
  el.textContent = msg;
  el.className = "save-msg " + cls;
  el.style.opacity = "1";
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => { el.textContent = ""; el.className = "save-msg"; el.style.opacity = "1"; }, 300);
  }, 3200);
}

/* ── Notifications dropdown ──────────────────────────────────────── */
function pushNotification(title, body, type) {
  state.notifications.unshift({ title, body, type, ts: Date.now() });
  if (state.notifications.length > 20) state.notifications.pop();
  state.unreadNotifs++;
  renderNotifDropdown();
  const dot = document.getElementById("notif-dot");
  if (dot) dot.classList.add("visible");
}

function renderNotifDropdown() {
  const list = document.getElementById("notif-list");
  const label = document.getElementById("notif-count-label");
  if (label) label.textContent = `${state.unreadNotifs} new`;
  if (!list) return;
  if (state.notifications.length === 0) {
    list.innerHTML = `<div class="notif-empty">You're all caught up</div>`;
    return;
  }
  list.innerHTML = state.notifications.slice(0, 12).map(n => `
    <div class="activity-item" style="border-radius:0; padding:14px 18px;">
      <span class="activity-icon-wrap ${n.type === 'error' ? 'error' : n.type === 'warn' ? 'warn' : 'success'}">
        ${ACTIVITY_SVGS[n.type === 'error' ? 'failed' : 'sent']}
      </span>
      <span class="activity-text"><strong>${escapeHtml(n.title)}</strong><br><span style="font-size:12px;">${escapeHtml(n.body)}</span></span>
      <span class="activity-time">${new Date(n.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>`).join("");
}

function toggleNotifDropdown() {
  const dd = document.getElementById("notif-dropdown");
  const dot = document.getElementById("notif-dot");
  dd.classList.toggle("open");
  if (dd.classList.contains("open")) {
    state.unreadNotifs = 0;
    if (dot) dot.classList.remove("visible");
    renderNotifDropdown();
  }
}

document.addEventListener("click", (e) => {
  const wrap = document.querySelector(".notif-wrap");
  const dd = document.getElementById("notif-dropdown");
  if (wrap && dd && dd.classList.contains("open") && !wrap.contains(e.target)) {
    dd.classList.remove("open");
  }
});

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

const TOAST_ICONS = {
  success: `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
  warn:    `<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
  error:   `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`,
  info:    `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`,
};

function showToast(title, body, type = "info") {
  const duration = 4200;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</div>
    <div class="toast-body-wrap">
      <div class="toast-title">${escapeHtml(title)}</div>
      <div class="toast-body">${escapeHtml(body)}</div>
    </div>
    <button class="toast-close" aria-label="Dismiss">
      <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </button>
    <div class="toast-progress" style="animation-duration:${duration}ms;"></div>`;

  const dismiss = () => {
    if (toast.dataset.leaving) return;
    toast.dataset.leaving = "1";
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 350);
  };
  toast.querySelector(".toast-close").addEventListener("click", dismiss);

  getToastContainer().appendChild(toast);
  const timer = setTimeout(dismiss, duration);
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
}

/* ── Utils ───────────────────────────────────────────────────────── */
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
