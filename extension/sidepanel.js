"use strict";

const $ = (id) => document.getElementById(id);

const overlayStatus = $("overlay-status");
const companionStatus = $("companion-status");
const empty = $("empty");
const preview = $("preview");
const statusLine = $("status-line");
const gateBox = $("gate-box");
const progressEl = $("progress");
const errorEl = $("error");
const confirmBtn = $("confirm");
const denyBtn = $("deny");
const stepLine = $("step-line");
const overlayToggle = $("overlay-toggle");
const permList = $("perm-list");
const originList = $("origin-list");
const tabAccess = $("tab-access");
const revokeBtn = $("revoke-site");
const panelFail = $("panel-fail");

if (!companionStatus || !empty || !preview || !confirmBtn || !denyBtn || !permList || !overlayToggle) {
  document.body.innerHTML =
    "<p style='padding:1rem;font:14px/1.4 sans-serif'>Side panel failed to render. Gated actions will not run. Reload the Loopback Agent side panel.</p>";
  throw new Error("Loopback Agent side panel failed to render.");
}

let current = null;
let busy = false;
let lastPerms = { origins: [], tabOrigin: null, tabGranted: false };

async function fetchJson(path, options) {
  const res = await fetch(`${COMPANION_ORIGIN}${path}`, {
    ...options,
    headers: {
      ...(options && options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function setCompanion(state, text) {
  companionStatus.dataset.state = state;
  companionStatus.textContent = text;
}

function originOf(act) {
  const raw = (act && act.gate && act.gate.url) || (act && act.startUrl) || "";
  try {
    return new URL(raw).origin;
  } catch {
    return raw || "";
  }
}

function hostOf(act) {
  const raw = originOf(act);
  try {
    return raw ? new URL(raw).host : "";
  } catch {
    return raw;
  }
}

function actionName(act) {
  if (act && (act.status === "waiting_confirm" || act.status === "awaiting_gate") && act.gate && act.gate.name) {
    return String(act.gate.name);
  }
  if (act && act.status === "pending") return "start";
  return "";
}

const RUNTIME_CODES = [
  "OVERLAY_INJECT_FAILED",
  "HOST_NOT_ALLOWED",
  "EXTENSION_DISCONNECTED",
  "WRONG_PROFILE",
  "CROSS_ACT_TAB",
];

function statusLabel(status, act, overlay) {
  if (
    overlay &&
    overlay.attached === false &&
    ["queued", "planning", "acting", "running", "confirmed"].includes(status)
  ) {
    return "Overlay missing — not acting. Not running.";
  }
  switch (status) {
    case "queued":
      return "Queued. The extension will start. This is not running yet.";
    case "pending":
      return "Waiting for Confirm-to-start. Nothing gated has run.";
    case "planning":
      return "Planning steps. Gated controls still wait.";
    case "confirmed":
    case "acting":
    case "running":
      return "Acting in this Chrome profile. Gated controls still wait.";
    case "waiting_confirm":
    case "awaiting_gate":
      return "Gated step. Confirm/Deny required — waiting is not a yes.";
    case "waiting_user":
      return "Waiting for a /v1/tool call. Not running.";
    case "waiting_file_picker":
      return "You pick the file in the highlighted picker. The agent did not set a file.";
    case "ready_for_publish":
      return "Ready for Publish/Save. That control was not clicked (noPublish).";
    case "completed":
      return "Finished without a gated click.";
    case "published":
      return "Gated control ran after you Confirmed.";
    case "denied":
      return "Denied. Gated actions did not run. Overlay cleared.";
    case "expired":
      return "Expired without Confirm. Gated actions did not run.";
    case "failed":
      return "Stopped. Fail closed — no extra clicks.";
    default:
      return status || "";
  }
}

function needsDecision(act) {
  return act && (act.status === "pending" || act.status === "waiting_confirm" || act.status === "awaiting_gate");
}

let overlayAttached = { attached: null, error: null };

function setOverlayBanner(state) {
  if (!overlayStatus) return;
  overlayAttached = state || overlayAttached;
  if (overlayAttached.attached === true) {
    overlayStatus.dataset.state = "attached";
    overlayStatus.textContent = `Overlay: attached on tab ${overlayAttached.tabId || "this tab"} (LPC_OVERLAY_PING ack).`;
  } else if (overlayAttached.attached === false) {
    overlayStatus.dataset.state = "missing";
    const code = overlayAttached.error ? ` ${overlayAttached.error}.` : "";
    overlayStatus.textContent = `Overlay: missing — not attached.${code} Allow this site, then retry.`;
  } else {
    overlayStatus.dataset.state = "checking";
    overlayStatus.textContent = "Overlay: waiting for LPC_OVERLAY_PING on the acted-on tab.";
  }
}

function render(act) {
  current = act;
  if (!act) {
    preview.hidden = true;
    empty.hidden = false;
    confirmBtn.disabled = true;
    denyBtn.disabled = true;
    confirmBtn.textContent = "Confirm";
    return;
  }
  empty.hidden = true;
  preview.hidden = false;
  statusLine.dataset.kind = act.status || "queued";
  statusLine.textContent = statusLabel(act.status, act, overlayAttached);
  const step = act.step || act.progress;
  if (
    step &&
    ["planning", "acting", "running", "confirmed", "waiting_confirm", "awaiting_gate", "waiting_user", "waiting_file_picker", "ready_for_publish"].includes(
      act.status
    )
  ) {
    stepLine.hidden = false;
    stepLine.textContent = step;
  } else {
    stepLine.hidden = true;
  }

  const gate = act.gate;
  const origin = originOf(act) || "this origin";
  const host = hostOf(act) || origin;
  const action = actionName(act);
  if ((act.status === "waiting_confirm" || act.status === "awaiting_gate") && gate) {
    gateBox.hidden = false;
    $("gate-action").textContent = `Confirm “${gate.name || action || "gated action"}” on ${origin}.`;
    $("gate-preview").textContent =
      gate.preview || `This clicks “${gate.name}” once. Deny aborts. Allowed hosts still require this Confirm.`;
  } else {
    gateBox.hidden = true;
  }

  $("field-intent").textContent = act.intent || "—";
  $("field-url").textContent = act.startUrl || "—";
  $("url-row").hidden = !act.startUrl;
  $("field-platform").textContent = act.platform || "—";
  $("platform-row").hidden = !act.platform;
  $("field-title").textContent = act.title || act.fillTitle || "—";
  $("title-row").hidden = !(act.title || act.fillTitle);
  $("field-caption").textContent = act.caption || act.fillDescription || "—";
  $("caption-row").hidden = !(act.caption || act.fillDescription);
  if (act.mediaPath) {
    $("media-row").hidden = false;
    $("field-media").textContent = act.mediaPath;
  } else {
    $("media-row").hidden = true;
  }
  if (act.snapshot && act.snapshot.url) {
    $("snap-row").hidden = false;
    $("field-snap").textContent = `${act.snapshot.title || act.snapshot.url} · ${act.snapshot.elementCount || 0} controls`;
  } else {
    $("snap-row").hidden = true;
  }

  if (act.progress) {
    progressEl.hidden = false;
    progressEl.textContent = act.progress;
  } else {
    progressEl.hidden = true;
  }
  if (act.error && (act.error.message || act.error.code)) {
    errorEl.hidden = false;
    const code = act.error.code && RUNTIME_CODES.includes(act.error.code) ? `${act.error.code}: ` : "";
    errorEl.textContent = `${code}${act.error.message || act.error.code}`;
  } else {
    errorEl.hidden = true;
  }

  const canDecide = needsDecision(act) && !busy;
  confirmBtn.disabled = !canDecide;
  denyBtn.disabled = !(
    act &&
    ["pending", "waiting_confirm", "awaiting_gate", "confirmed", "queued", "planning", "acting", "running", "waiting_user", "waiting_file_picker", "ready_for_publish"].includes(
      act.status
    ) &&
    !busy
  );
  if (act.status === "waiting_confirm" || act.status === "awaiting_gate") {
    confirmBtn.textContent = `Confirm ${action || "action"} on ${host}`;
    $("confirm-hint").textContent =
      `Confirm clicks “${action || "this gated control"}” on ${origin} once. Deny aborts and clears the overlay. Waiting does not confirm.`;
  } else if (act.status === "pending") {
    confirmBtn.textContent = `Confirm start on ${host || "this profile"}`;
    $("confirm-hint").textContent =
      `This Confirm starts the act on ${origin || "the focused tab"}. Publish/Send/Pay/Delete/Share will still stop later. Deny aborts. Waiting does not confirm.`;
  } else {
    confirmBtn.textContent = "Confirm";
    $("confirm-hint").textContent =
      "Deny aborts the act and clears the overlay. Gated clicks never run without Confirm — including on allowed sites.";
  }
}

function renderPerms(state) {
  lastPerms = state || lastPerms;
  const origins = lastPerms.origins || [];
  const extra = origins.filter((o) => !String(o).includes("127.0.0.1:18741"));
  originList.innerHTML = "";
  if (!extra.length) {
    permList.textContent =
      "Default: companion on 127.0.0.1 only. Grant a site here before the agent can snapshot or click it.";
  } else {
    permList.textContent = "Granted origins. Gated actions still require Confirm.";
    for (const o of extra) {
      const li = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = o;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost compact";
      btn.textContent = "Revoke";
      btn.addEventListener("click", () => revokeOrigin(o));
      li.appendChild(code);
      li.appendChild(btn);
      originList.appendChild(li);
    }
  }
  if (lastPerms.tabOrigin) {
    if (lastPerms.tabGranted) {
      tabAccess.textContent = `${lastPerms.tabOrigin} is allowed. Publish/Send/Pay/Delete/Share still need Confirm.`;
    } else {
      tabAccess.textContent = `${lastPerms.tabOrigin} is not granted. Allow this site — the agent will not use this host silently.`;
    }
  } else {
    tabAccess.textContent = "Focus an http(s) tab, then Allow this site. Unknown hosts are never granted silently.";
  }
  const tabIsCompanion = Boolean(lastPerms.tabOrigin && lastPerms.tabOrigin.includes("127.0.0.1"));
  revokeBtn.disabled = !lastPerms.tabOrigin || !lastPerms.tabGranted || tabIsCompanion;
}

async function refreshPerms() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "LPC_PERMISSIONS" });
    renderPerms(res || { origins: [] });
  } catch {
    permList.textContent = "Could not read granted origins. Fail closed — no silent grant.";
  }
}

async function refresh() {
  try {
    const health = await fetchJson("/health");
    if (!health.ok) throw new Error("down");
    setCompanion("up", "Companion is up on 127.0.0.1:18741");
    let act = null;
    const pending = await fetchJson("/v1/pending");
    if (pending.data && pending.data.act) act = pending.data.act;
    else if (health.data && health.data.active) {
      const st = await fetchJson(`/v1/status/${encodeURIComponent(health.data.active)}`);
      act = (st.data && st.data.act) || (st.data && st.data.request);
    } else if (current && current.id) {
      const st = await fetchJson(`/v1/status/${encodeURIComponent(current.id)}`);
      act = (st.data && st.data.act) || (st.data && st.data.request);
    }
    render(act || null);
  } catch {
    setCompanion(
      "down",
      "Companion is not reachable at 127.0.0.1:18741. Start it with npm run companion."
    );
    if (!current) render(null);
  }
}

async function decide(type) {
  if (!current || busy) return;
  if (type === "LPC_CONFIRM" && !needsDecision(current)) return;
  busy = true;
  confirmBtn.disabled = true;
  denyBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type, id: current.id });
    if (res && res.data && (res.data.act || res.data.request)) {
      render(res.data.act || res.data.request);
    } else if (res && res.data && res.data.message) {
      errorEl.hidden = false;
      errorEl.textContent = res.data.message;
    }
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err && err.message ? err.message : "Could not reach the extension worker. Fail closed.";
  } finally {
    busy = false;
    refresh();
  }
}

async function revokeOrigin(origin) {
  const res = await chrome.runtime.sendMessage({ type: "LPC_REVOKE_SITE", origin });
  if (res && res.error) {
    errorEl.hidden = false;
    errorEl.textContent = res.error;
  }
  refreshPerms();
}

if (panelFail) panelFail.hidden = true;

if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
  setCompanion("down", "Open this panel from the Loopback Agent extension. Gated actions will not run here.");
  render(null);
} else {
  confirmBtn.addEventListener("click", () => decide("LPC_CONFIRM"));
  denyBtn.addEventListener("click", () => decide("LPC_DENY"));

  $("allow-site").addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ type: "LPC_ALLOW_SITE", kind: "this" });
    if (res && res.error) {
      errorEl.hidden = false;
      errorEl.textContent = res.error;
    }
    refreshPerms();
  });

  revokeBtn.addEventListener("click", () => revokeOrigin(null));

  $("allow-all").addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ type: "LPC_ALLOW_SITE", kind: "all" });
    if (res && res.granted === false) {
      errorEl.hidden = false;
      errorEl.textContent = "All-sites access was not granted.";
    }
    refreshPerms();
  });

  overlayToggle.addEventListener("change", async () => {
    await chrome.runtime.sendMessage({ type: "LPC_OVERLAY_TOGGLE", enabled: overlayToggle.checked });
  });

  chrome.runtime.sendMessage({ type: "LPC_OVERLAY_GET" }).then((res) => {
    if (res && typeof res.enabled === "boolean") overlayToggle.checked = res.enabled;
    if (res) setOverlayBanner(res);
  }).catch(() => {});

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    if (message.type === "LPC_OVERLAY_STATUS") {
      setOverlayBanner(message);
    }
    if (message.type === "LPC_ACT" || message.type === "LPC_GATE" || message.type === "LPC_PENDING") {
      render(message.act || message.request || null);
    }
    if (message.type === "LPC_PROGRESS" && message.message) {
      progressEl.hidden = false;
      progressEl.textContent = message.message;
      stepLine.hidden = false;
      stepLine.textContent = message.step || message.message;
    }
    if (message.type === "LPC_STEP" && message.step) {
      stepLine.hidden = false;
      stepLine.textContent = message.step;
    }
  });

  refreshPerms();
  refresh();
  setInterval(refresh, POLL_MS);
  setInterval(refreshPerms, 4000);
}
