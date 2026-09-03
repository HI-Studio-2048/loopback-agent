"use strict";

importScripts("cdp.js");

const COMPANION = "http://127.0.0.1:18741";
const POLL_MS = 280;
const AGENT_FILES = [
  "content/overlay.js",
  "content/dom.js",
  "content/agent.js",
  "content/youtube.js",
  "content/instagram.js",
];

let pollTimer = null;
let lastActId = null;
let lastStatus = null;
let busy = false;
let lastScreenshot = null;
const startedKeys = new Set();
let lastTabId = null;
let overlayEnabled = true;
let currentStep = "";

async function companion(path, options = {}) {
  const res = await fetch(`${COMPANION}${path}`, {
    ...options,
    headers: {
      "X-Loopback-Extension": "1",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

let badgeTabId = null;
let lastOverlayState = { attached: false, tabId: null, error: null };

function clearActingBadge() {
  if (badgeTabId) {
    chrome.action.setBadgeText({ text: "", tabId: badgeTabId });
  }
  chrome.action.setBadgeText({ text: "" });
  badgeTabId = null;
}

function setActingBadge(tabId) {
  if (badgeTabId && badgeTabId !== tabId) {
    chrome.action.setBadgeText({ text: "", tabId: badgeTabId });
  }
  badgeTabId = tabId || null;
  if (!tabId) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  chrome.action.setBadgeText({ text: "Grok", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#e08a1e", tabId });
}

function setBadge(text, color) {
  if (!text) {
    clearActingBadge();
    return;
  }
  if (lastTabId) {
    setActingBadge(lastTabId);
    return;
  }
  chrome.action.setBadgeText({ text: text === "Grok" || text === "…" || text === "1" ? "Grok" : text });
  if (color) chrome.action.setBadgeBackgroundColor({ color: color || "#e08a1e" });
}

function notifyViews(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

chrome.storage.local.get({ overlayEnabled: true }).then((v) => {
  overlayEnabled = v.overlayEnabled !== false;
}).catch(() => {});

async function overlayMsg(tabId, message) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

async function overlayHudMeta(tabId, extra = {}) {
  const meta = {
    verb: extra.verb || currentStep || "Acting",
    title: extra.title || "",
    host: extra.host || "",
    phase: extra.phase || (lastStatus === "pending" || lastStatus === "awaiting_gate" ? "confirm" : "acting"),
    youPick: extra.youPick === true,
  };
  try {
    const tab = tabId ? await chrome.tabs.get(tabId) : await activeTab();
    if (tab && tab.url && !meta.host) {
      meta.host = new URL(tab.url).host;
    }
    if (tab && tab.title && !meta.title) {
      meta.title = String(tab.title).slice(0, 40);
    }
  } catch {
    /* tab may be gone */
  }
  if (extra.youPick) meta.phase = "pick";
  return meta;
}

async function overlayShow(tabId, step, extra = {}) {
  lastTabId = tabId;
  currentStep = step || currentStep;
  if (tabId) setActingBadge(tabId);
  if (!overlayEnabled) {
    await overlayMsg(tabId, { type: "LPC_OVERLAY_HIDE" });
    return;
  }
  const meta = await overlayHudMeta(tabId, { ...extra, verb: extra.verb || step || currentStep });
  await overlayMsg(tabId, {
    type: "LPC_OVERLAY_SHOW",
    enabled: true,
    step: currentStep || "Acting",
    ...meta,
  });
}

async function overlayYouPick(tabId, rect) {
  await overlayShow(tabId, "You pick", { youPick: true, verb: "You pick", phase: "pick" });
  if (rect) {
    await overlayMsg(tabId, {
      type: "LPC_OVERLAY_HIGHLIGHT",
      rect,
      label: "You pick the file",
      youPick: true,
      reason: "file_chooser_user_pick",
    });
  }
}

async function overlayHide(tabId) {
  const id = tabId || lastTabId;
  if (id) await overlayMsg(id, { type: "LPC_OVERLAY_HIDE" });
  clearActingBadge();
}

async function setStep(id, step, tabId, extra = {}) {
  currentStep = step;
  notifyViews({ type: "LPC_STEP", step, message: step });
  if (tabId || lastTabId) await overlayShow(tabId || lastTabId, step, extra);
  if (id) {
    await companion("/v1/progress", {
      method: "POST",
      body: JSON.stringify({ id, message: step, step }),
    });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function grantedOrigins() {
  const all = await chrome.permissions.getAll();
  return all.origins || [];
}

async function hasOriginAccess(url) {
  if (!url) return false;
  try {
    const origin = new URL(url).origin + "/*";
    if (origin.startsWith("http://127.0.0.1")) return true;
    return chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    function done(ok, err) {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearInterval(tick);
      if (ok) resolve();
      else reject(err || new Error("tab timeout"));
    }
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") done(true);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    const tick = setInterval(async () => {
      if (Date.now() > deadline) {
        done(false, new Error("Timed out waiting for the tab."));
        return;
      }
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") done(true);
      } catch (err) {
        done(false, err);
      }
    }, 400);
  });
}

async function pingOverlay(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "LPC_OVERLAY_PING" });
    return Boolean(res && res.ok && res.overlay);
  } catch {
    return false;
  }
}

async function ensureOverlayAcked(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.url || !(await hasOriginAccess(tab.url))) {
    lastOverlayState = { attached: false, tabId, error: "HOST_NOT_ALLOWED" };
    notifyViews({ type: "LPC_OVERLAY_STATUS", ...lastOverlayState });
    return {
      ok: false,
      error: "HOST_NOT_ALLOWED",
      message: "Allow this site first — overlay not on this tab.",
    };
  }
  if (await pingOverlay(tabId)) {
    lastOverlayState = { attached: true, tabId, error: null };
    notifyViews({ type: "LPC_OVERLAY_STATUS", ...lastOverlayState });
    return { ok: true };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content/overlay.js"],
      injectImmediately: true,
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const hostFail = /Cannot access|permission|Extension manifest/i.test(msg);
    lastOverlayState = {
      attached: false,
      tabId,
      error: hostFail ? "HOST_NOT_ALLOWED" : "OVERLAY_INJECT_FAILED",
    };
    notifyViews({ type: "LPC_OVERLAY_STATUS", ...lastOverlayState });
    return {
      ok: false,
      error: lastOverlayState.error,
      message: hostFail
        ? "Allow this site first — overlay not on this tab."
        : `Overlay did not inject (${msg}). ${tab.title || ""} ${tab.url}`,
    };
  }
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (await pingOverlay(tabId)) {
      lastOverlayState = { attached: true, tabId, error: null };
      notifyViews({ type: "LPC_OVERLAY_STATUS", ...lastOverlayState });
      return { ok: true };
    }
    await sleep(40);
  }
  lastOverlayState = { attached: false, tabId, error: "OVERLAY_INJECT_FAILED" };
  notifyViews({ type: "LPC_OVERLAY_STATUS", ...lastOverlayState });
  return {
    ok: false,
    error: "OVERLAY_INJECT_FAILED",
    message: `No LPC_OVERLAY_PING ack after inject — ${tab.title || ""} ${tab.url}`,
  };
}

async function ensureInjected(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "LPC_PING" });
    if (ping && ping.ok) return { ok: true };
  } catch {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: AGENT_FILES });
    const ping = await chrome.tabs.sendMessage(tabId, { type: "LPC_PING" });
    if (ping && ping.ok) return { ok: true };
    return { ok: false, error: "ui_missing", message: "Agent script did not answer." };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/Cannot access|permission|Extension manifest/i.test(msg)) {
      return {
        ok: false,
        error: "needs_permission",
        message: "Allow this site from the side panel, then retry.",
      };
    }
    return { ok: false, error: "ui_missing", message: msg };
  }
}

async function sendTab(tabId, message, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      lastErr = err;
      await sleep(400);
    }
  }
  throw lastErr || new Error("Content script did not answer.");
}

async function openDedicatedActTab(url, act) {
  const forbidden = new Set((act && act.forbiddenTabIds) || []);
  if (act && act.tabId && !forbidden.has(act.tabId)) {
    try {
      await chrome.tabs.get(act.tabId);
      await chrome.tabs.update(act.tabId, { url, active: true });
      await waitForTabComplete(act.tabId);
      await cdpSwitchTab(lastTabId, act.tabId);
      lastTabId = act.tabId;
      return act.tabId;
    } catch {
      /* tab gone */
    }
  }
  const tab = await chrome.tabs.create({ url, active: true });
  await waitForTabComplete(tab.id);
  await cdpSwitchTab(lastTabId, tab.id);
  lastTabId = tab.id;
  if (act && act.id) {
    await companion("/v1/progress", {
      method: "POST",
      body: JSON.stringify({ id: act.id, tabId: tab.id, planStep: "open_studio", step: "open_studio" }),
    });
  }
  return tab.id;
}

async function openUrlForAct(url, act) {
  const forbidden = new Set((act && act.forbiddenTabIds) || []);
  if (act && (act.newTab || act.planKind === "youtube_upload" || (act.plan && act.plan.kind === "youtube_upload"))) {
    return openDedicatedActTab(url, act);
  }
  const current = await activeTab();
  if (current && current.id && forbidden.has(current.id)) {
    return openDedicatedActTab(url, act);
  }
  if (act && act.tabId && !forbidden.has(act.tabId)) {
    return openDedicatedActTab(url, { ...act, newTab: false });
  }
  return openUrl(url);
}

async function openUrl(url) {
  const current = await activeTab();
  if (current && current.id) {
    await chrome.tabs.update(current.id, { url, active: true });
    await waitForTabComplete(current.id);
    await cdpSwitchTab(lastTabId, current.id);
    lastTabId = current.id;
    return current.id;
  }
  const tab = await chrome.tabs.create({ url, active: true });
  await waitForTabComplete(tab.id);
  await cdpSwitchTab(lastTabId, tab.id);
  lastTabId = tab.id;
  return tab.id;
}

async function captureShot(tabId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 40 });
    lastScreenshot = { tabId, dataUrl, capturedAt: Date.now() };
    return true;
  } catch {
    lastScreenshot = null;
    return false;
  }
}

async function reportProgress(id, message) {
  await companion("/v1/progress", { method: "POST", body: JSON.stringify({ id, message }) });
}

async function reportResult(id, status, error, message) {
  await overlayHide();
  await cdpDetach(lastTabId);
  await companion("/v1/result", {
    method: "POST",
    body: JSON.stringify({ id, status, error, message }),
  });
}

async function postSnapshot(id, outline, extra = {}) {
  await companion("/v1/snapshot", {
    method: "POST",
    body: JSON.stringify({ id, outline, ax: extra.ax || undefined, screenshot: extra.screenshot || undefined }),
  });
}

async function postGate(id, gate) {
  await companion("/v1/gate", { method: "POST", body: JSON.stringify({ id, ...gate }) });
}

async function snapshotTab(tabId, id) {
  const inj = await ensureInjected(tabId);
  if (!inj.ok) return inj;
  lastTabId = tabId;
  await overlayShow(tabId, currentStep || "Snapshot");
  const res = await sendTab(tabId, { type: "LPC_SNAPSHOT" });
  let ax = [];
  let shot = null;
  const dbg = await cdpAttachRetry(tabId, 2);
  if (dbg.ok) {
    try {
      const fused = await cdpFuseSnapshot(tabId);
      ax = (fused && fused.ax) || [];
      shot = (fused && fused.screenshot) || null;
      if (res && fused && fused.elements) res.elements = fused.elements;
    } catch {
      ax = [];
    }
  }
  if (shot) lastScreenshot = { tabId, dataUrl: shot, capturedAt: Date.now() };
  else await captureShot(tabId);
  if (res && res.outline && id) {
    await postSnapshot(id, res.outline, { ax, screenshot: shot || (lastScreenshot && lastScreenshot.dataUrl) });
  }
  return res;
}

async function runFill(act) {
  const youtubeUpload =
    (act.plan && act.plan.kind === "youtube_upload") ||
    (act.platform === "youtube" && (act.mediaPath || /upload/i.test(String(act.intent || ""))));
  if (
    !act.platform &&
    act.startUrl &&
    /youtube\.com|studio\.youtube\.com/i.test(act.startUrl)
  ) {
    act = { ...act, platform: "youtube" };
  }
  if (!act.platform && act.startUrl && /instagram\.com/i.test(act.startUrl)) {
    act = { ...act, platform: "instagram" };
  }

  await companion("/v1/progress", {
    method: "POST",
    body: JSON.stringify({
      id: act.id,
      status: "planning",
      step: "planning",
      message: youtubeUpload
        ? "Planning YouTube upload (Studio tab, attach, details, audience, visibility)."
        : "Planning the act.",
    }),
  });

  const url = act.startUrl || (youtubeUpload ? "https://studio.youtube.com" : null);
  if (url && !(await hasOriginAccess(url))) {
    await reportResult(
      act.id,
      "failed",
      "HOST_NOT_ALLOWED",
      `Allow this site first — overlay not on this tab. (${new URL(url).origin})`
    );
    return;
  }

  await companion("/v1/progress", {
    method: "POST",
    body: JSON.stringify({ id: act.id, status: "acting", step: "open_studio", planStep: "open_studio" }),
  });

  const forbidden = new Set((act.forbiddenTabIds || []).map(Number));
  let tabId;
  if (url) {
    tabId = await openUrlForAct(url, act);
  } else {
    const current = await activeTab();
    if (act.newTab || (current && forbidden.has(current.id))) {
      const tab = await chrome.tabs.create({ active: true });
      tabId = tab.id;
      lastTabId = tabId;
      await companion("/v1/progress", {
        method: "POST",
        body: JSON.stringify({ id: act.id, tabId, status: "acting", step: "new_tab" }),
      });
    } else {
      tabId = current && current.id;
    }
  }
  if (!tabId) {
    await reportResult(act.id, "failed", "ui_missing", "No tab to operate on.");
    return;
  }
  lastTabId = tabId;
  await companion("/v1/progress", {
    method: "POST",
    body: JSON.stringify({ id: act.id, tabId, step: "wait_load", planStep: "wait_load", status: "acting" }),
  });
  await setStep(act.id, youtubeUpload ? "YouTube: wait_load" : "Navigate", tabId);
  await waitForTabComplete(tabId).catch(() => {});
  await cdpWaitLoad(tabId, 15000).catch(() => {});

  const overlay = await ensureOverlayAcked(tabId);
  if (!overlay.ok) {
    await reportResult(act.id, "failed", overlay.error, overlay.message);
    return;
  }
  await companion("/v1/progress", {
    method: "POST",
    body: JSON.stringify({ id: act.id, planStep: "overlay_ping", step: "overlay_ping", status: "acting" }),
  });

  const inj = await ensureInjected(tabId);
  if (!inj.ok) {
    await reportResult(act.id, "failed", inj.error, inj.message);
    return;
  }
  await overlayShow(tabId, youtubeUpload ? "YouTube upload" : "Acting");
  await cdpAttachRetry(tabId, 2);

  if (act.platform === "youtube" || act.platform === "instagram") {
    await setStep(act.id, youtubeUpload ? "YouTube: fill composer" : "Fill composer", tabId);
    const result = await sendTab(tabId, {
      type: "LPC_FILL",
      request: {
        ...act,
        title: act.title || act.fillTitle,
        description: act.description || act.fillDescription || act.caption,
        caption: act.description || act.caption,
        noPublish: act.noPublish,
      },
    });
    if (result && result.gate) {
      await postGate(act.id, result.gate);
      setActingBadge(tabId);
      notifyViews({
        type: "LPC_GATE",
        act: { ...act, status: "waiting_confirm", gate: result.gate, tabId },
      });
      return;
    }
    if (result && (result.status === "ready_for_publish" || (result.ok && youtubeUpload && act.noPublish && !result.gate))) {
      await companion("/v1/result", {
        method: "POST",
        body: JSON.stringify({
          id: act.id,
          status: "ready_for_publish",
          message:
            result.message ||
            "YouTube upload is filled. Publish/Save was not clicked (noPublish=true).",
        }),
      });
      await overlayShow(tabId, "Ready — not published", { phase: "acting", verb: "Ready" });
      notifyViews({ type: "LPC_ACT", act: { ...act, status: "ready_for_publish", tabId } });
      return;
    }
    if (result && result.status === "waiting_file_picker") {
      await companion("/v1/progress", {
        method: "POST",
        body: JSON.stringify({
          id: act.id,
          status: "waiting_file_picker",
          step: result.message,
          message: result.message,
        }),
      });
      return;
    }
    if (result && result.completed && !youtubeUpload) {
      await reportResult(act.id, "completed", null, result.message || "Finished without a gated click.");
      return;
    }
    if (!result || result.ok === false) {
      const err = (result && result.error) || "ui_missing";
      if (err === "file_chooser_user_pick") {
        await companion("/v1/progress", {
          method: "POST",
          body: JSON.stringify({
            id: act.id,
            status: "waiting_file_picker",
            message: (result && result.message) || "You pick the file in the highlighted picker.",
          }),
        });
        return;
      }
      await reportResult(
        act.id,
        "failed",
        err,
        (result && result.message) || "Composer step failed. Fail closed."
      );
      return;
    }
  }

  const snap = await snapshotTab(tabId, act.id);
  if (snap && snap.ok === false) {
    await reportResult(act.id, "failed", snap.error, snap.message);
    return;
  }

  if (youtubeUpload) {
    await reportResult(
      act.id,
      "failed",
      "ui_missing",
      "YouTube upload plan did not reach ready_for_publish or Confirm. Fail closed."
    );
    return;
  }

  if (act.noPublish && (act.platform === "instagram" || act.fillTitle || act.fillDescription)) {
    await reportResult(act.id, "completed", null, "Finished without clicking Publish/Send/Pay/Delete/Share.");
    return;
  }

  await companion("/v1/progress", {
    method: "POST",
    body: JSON.stringify({
      id: act.id,
      status: "waiting_user",
      step: "waiting_user",
      message:
        "Waiting for a /v1/tool call (include this act id and tabId). Not running. Next: snapshot, click, type, navigate, or attachFile. Publish/Send/Pay/Delete/Share still require Confirm.",
    }),
  });
  await overlayShow(tabId, "Waiting for tool", { phase: "acting", verb: "Waiting" });
}

async function clickViaCdpOrDom(tabId, args, act) {
  const requireCdp = Boolean(args.requireCdp);
  const overlay = await ensureOverlayAcked(tabId);
  if (!overlay.ok) return overlay;
  await ensureInjected(tabId);
  let dbg = await cdpAttachRetry(tabId, 2);
  if (requireCdp && !dbg.ok) {
    return {
      ok: false,
      error: "debugger_attach_failed",
      message: "Could not attach the debugger. Gated click will not fall back to in-page click().",
    };
  }
  if (dbg.ok) {
    let lastErr = null;
    let lastFound = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const found = await cdpFindRetry(tabId, args, 2);
        if (!found) break;
        lastFound = found;
        if (found.gated && !args.allowGated && !(act && act.allowGatedOnce)) {
          await overlayMsg(tabId, {
            type: "LPC_OVERLAY_HIGHLIGHT",
            rect: found.rect,
            label: `Waiting: Confirm ${found.name}`,
          });
          return {
            ok: false,
            error: "gated",
            gate: {
              kind: "gated",
              name: found.name,
              selector: args.selector || null,
              url: null,
              preview: `About to click “${found.name}”. This looks like Publish/Post/Send/Pay/Delete/Share.`,
            },
          };
        }
        await overlayMsg(tabId, {
          type: "LPC_OVERLAY_CLICK",
          rect: found.rect,
          label: `Click: ${found.name || "control"}`,
        });
        await cdpMouseClick(tabId, found.x, found.y);
        await cdpAfterInput(tabId);
        return { ok: true, via: "cdp", name: found.name };
      } catch (err) {
        lastErr = err;
        if (isStaleError(err)) {
          await cdpFuseSnapshot(tabId).catch(() => {});
          continue;
        }
        break;
      }
    }
    if (requireCdp || (lastFound && lastFound.gated)) {
      dbg = await cdpAttachRetry(tabId, 2);
      if (!dbg.ok) {
        return {
          ok: false,
          error: "debugger_attach_failed",
          message: "Debugger detached. Gated click will not fall back to in-page click().",
        };
      }
      return {
        ok: false,
        error: "ui_missing",
        message: (lastErr && lastErr.message) || "CDP click failed. Will not fall back to in-page click().",
      };
    }
  }
  if (requireCdp) {
    return {
      ok: false,
      error: "debugger_attach_failed",
      message: "Could not attach the debugger. Gated click will not fall back to in-page click().",
    };
  }
  return sendTab(tabId, {
    type: "LPC_CLICK",
    ...args,
    allowGated: false,
  });
}

async function typeViaCdpOrDom(tabId, args) {
  const overlay = await ensureOverlayAcked(tabId);
  if (!overlay.ok) return overlay;
  await ensureInjected(tabId);
  const dbg = await cdpAttachRetry(tabId, 2);
  const press = args.key || args.press || (args.submit ? "Enter" : null);
  const keys = Array.isArray(args.keys) ? args.keys : press ? [press] : [];
  if (dbg.ok) {
    try {
      const found =
        args.selector || args.name || args.role || args.ref || args.backendDOMNodeId
          ? await cdpFindRetry(tabId, args, 2)
          : null;
      if (found) {
        await overlayMsg(tabId, {
          type: "LPC_OVERLAY_TYPE",
          rect: found.rect,
          text: args.text,
          label: `Type: ${found.name || "field"}`,
        });
        await cdpFocus(tabId, found.backendDOMNodeId);
      }
      if (args.text) await cdpInsertText(tabId, args.text);
      for (const k of keys) await cdpKey(tabId, k);
      await overlayMsg(tabId, { type: "LPC_OVERLAY_TYPE_DONE" });
      await cdpAfterInput(tabId);
      if (found || args.text || keys.length) return { ok: true, via: "cdp" };
    } catch {
      /* non-gated type may fall back to the content script */
    }
  }
  return sendTab(tabId, { type: "LPC_TYPE", ...args });
}

async function clickGated(act) {
  const tabId = act.tabId || (await activeTab())?.id;
  if (!tabId) {
    await reportResult(act.id, "failed", "ui_missing", "No active tab for the gated click.");
    return;
  }
  const overlay = await ensureOverlayAcked(tabId);
  if (!overlay.ok) {
    await reportResult(act.id, "failed", overlay.error, overlay.message);
    return;
  }
  const inj = await ensureInjected(tabId);
  if (!inj.ok) {
    await reportResult(act.id, "failed", inj.error, inj.message);
    return;
  }
  lastTabId = tabId;
  const gate = act.gate || {};
  const result = await clickViaCdpOrDom(
    tabId,
    {
      selector: gate.selector,
      name: gate.name || (act.platform === "instagram" ? "Share" : "Publish"),
      allowGated: true,
      requireCdp: true,
    },
    { ...act, allowGatedOnce: true }
  );
  if (result && result.ok) {
    await reportResult(act.id, "published", null, "Gated control clicked after Confirm.");
    setBadge("");
    return;
  }
  await reportResult(
    act.id,
    "failed",
    (result && result.error) || "ui_missing",
    (result && result.message) || "Gated click failed. Fail closed; no in-page click() fallback."
  );
}

async function runTool(act) {
  const cmd = act.command;
  if (!cmd || cmd.status !== "queued") return;
  let tab = await activeTab();
  if (act.tabId) {
    try {
      tab = await chrome.tabs.get(act.tabId);
    } catch {
      /* owned tab may be gone */
    }
  }
  const forbidden = new Set((act.forbiddenTabIds || []).map(Number));
  const requested = cmd.args && cmd.args.tabId != null ? Number(cmd.args.tabId) : null;
  if (requested != null && (forbidden.has(requested) || (act.tabId && requested !== Number(act.tabId)))) {
    await companion("/v1/tool-result", {
      method: "POST",
      body: JSON.stringify({ id: act.id, ok: false, error: "CROSS_ACT_TAB" }),
    });
    await reportProgress(act.id, "That tab belongs to another act. Cross-act hijack rejected.");
    return;
  }
  if (tab && forbidden.has(tab.id)) {
    tab = null;
  }
  try {
    if (cmd.tool === "navigate" || cmd.tool === "tabs.create" || cmd.tool === "tabs.update") {
      const url = cmd.args && cmd.args.url;
      if (!url) throw new Error("url required");
      if (!(await hasOriginAccess(url))) {
        await companion("/v1/tool-result", {
          method: "POST",
          body: JSON.stringify({
            id: act.id,
            ok: false,
            error: "needs_permission",
          }),
        });
        await reportProgress(act.id, `Allow ${new URL(url).origin} in the side panel.`);
        return;
      }
      if (cmd.tool === "tabs.create") {
        await setStep(act.id, "Navigate", tab && tab.id);
        const created = await chrome.tabs.create({ url, active: true });
        await waitForTabComplete(created.id);
        await cdpSwitchTab(lastTabId, created.id);
        lastTabId = created.id;
        await ensureInjected(created.id);
        await overlayShow(created.id, `Navigate: ${url}`);
        await cdpWaitLoad(created.id, 15000).catch(() => {});
        await cdpFuseSnapshot(created.id).catch(() => {});
        tab = created;
      } else {
        const id = (cmd.args && cmd.args.tabId) || (tab && tab.id);
        if (!id) throw new Error("No tab");
        await setStep(act.id, "Navigate", id);
        await chrome.tabs.update(id, { url, active: true });
        await waitForTabComplete(id);
        await cdpSwitchTab(lastTabId, id);
        lastTabId = id;
        await ensureInjected(id);
        await overlayShow(id, `Navigate: ${url}`);
        await cdpWaitLoad(id, 15000).catch(() => {});
        await cdpFuseSnapshot(id).catch(() => {});
        tab = await chrome.tabs.get(id);
      }
    } else if (cmd.tool === "tabs.list") {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      await companion("/v1/tool-result", {
        method: "POST",
        body: JSON.stringify({ id: act.id, ok: true }),
      });
      await reportProgress(act.id, `Tabs: ${tabs.length} in this window.`);
      notifyViews({
        type: "LPC_TABS",
        tabs: tabs.map((t) => ({ id: t.id, title: t.title || "", url: t.url || "" })),
      });
      return;
    } else if (cmd.tool === "tabs.activate") {
      const id = cmd.args.tabId;
      await chrome.tabs.update(id, { active: true });
      await waitForTabComplete(id);
      await cdpSwitchTab(lastTabId, id);
      lastTabId = id;
      await overlayShow(id, "Switch tab");
      await cdpFuseSnapshot(id).catch(() => {});
    } else if (cmd.tool === "tabs.close") {
      const id = (cmd.args && cmd.args.tabId) || (tab && tab.id);
      if (!id) throw new Error("No tab");
      await cdpDetach(id);
      await chrome.tabs.remove(id);
      if (lastTabId === id) lastTabId = null;
      await companion("/v1/tool-result", { method: "POST", body: JSON.stringify({ id: act.id, ok: true }) });
      await setStep(act.id, "Close tab");
      return;
    } else if (cmd.tool === "windows.list") {
      const wins = await chrome.windows.getAll({ populate: true });
      await companion("/v1/tool-result", { method: "POST", body: JSON.stringify({ id: act.id, ok: true }) });
      await setStep(act.id, `Windows: ${wins.length}`);
      return;
    } else if (cmd.tool === "windows.create") {
      const url = cmd.args && cmd.args.url;
      const win = await chrome.windows.create(url ? { url, focused: true } : { focused: true });
      const tid = win.tabs && win.tabs[0] && win.tabs[0].id;
      if (tid) {
        await waitForTabComplete(tid);
        await cdpSwitchTab(lastTabId, tid);
        lastTabId = tid;
        await ensureInjected(tid);
        await overlayShow(tid, "New window");
        await cdpWaitLoad(tid, 15000).catch(() => {});
        await cdpFuseSnapshot(tid).catch(() => {});
      }
      await companion("/v1/tool-result", { method: "POST", body: JSON.stringify({ id: act.id, ok: true }) });
      return;
    } else if (cmd.tool === "wait.load") {
      const id = (tab && tab.id) || lastTabId;
      if (!id) throw new Error("No tab");
      await waitForTabComplete(id);
      const dbg = await cdpAttachRetry(id, 2);
      if (dbg.ok) {
        await cdpWaitLoad(id, 15000).catch(() => {});
        await cdpWaitQuiet(id, 6000, 250).catch(() => {});
        await cdpFuseSnapshot(id).catch(() => {});
      }
      await companion("/v1/tool-result", { method: "POST", body: JSON.stringify({ id: act.id, ok: true }) });
      return;
    }

    tab = tab || (await activeTab());
    if (cmd.tool === "snapshot" || cmd.tool === "screenshot") {
      if (!tab) throw new Error("No tab");
      await snapshotTab(tab.id, act.id);
      await companion("/v1/tool-result", { method: "POST", body: JSON.stringify({ id: act.id, ok: true }) });
      return;
    }
    if (cmd.tool === "scroll") {
      if (!tab) throw new Error("No tab");
      await ensureInjected(tab.id);
      await sendTab(tab.id, { type: "LPC_SCROLL", direction: cmd.args.direction, amount: cmd.args.amount });
      await companion("/v1/tool-result", { method: "POST", body: JSON.stringify({ id: act.id, ok: true }) });
      return;
    }
    if (cmd.tool === "type") {
      if (!tab) throw new Error("No tab");
      await overlayShow(tab.id, "Type");
      const typed = await typeViaCdpOrDom(tab.id, cmd.args);
      if (typed && typed.error === "gated") {
        await postGate(act.id, typed.gate || { preview: typed.message, name: "gated" });
        return;
      }
      await companion("/v1/tool-result", {
        method: "POST",
        body: JSON.stringify({ id: act.id, ok: Boolean(typed && typed.ok), error: typed && typed.error }),
      });
      return;
    }
    if (cmd.tool === "click") {
      if (!tab) throw new Error("No tab");
      await overlayShow(tab.id, "Click");
      const clicked = await clickViaCdpOrDom(tab.id, cmd.args, act);
      if (clicked && clicked.error === "gated") {
        await postGate(act.id, clicked.gate);
        return;
      }
      await companion("/v1/tool-result", {
        method: "POST",
        body: JSON.stringify({ id: act.id, ok: Boolean(clicked && clicked.ok), error: clicked && clicked.error }),
      });
      return;
    }
    if (cmd.tool === "attachFile") {
      if (!tab) throw new Error("No tab");
      const filePath = cmd.args && (cmd.args.path || cmd.args.mediaPath);
      await overlayShow(tab.id, "Attach file");
      await ensureInjected(tab.id);
      const dbg = await cdpAttachRetry(tab.id, 2);
      async function failFile(error, message, rect) {
        if (error === "file_chooser_user_pick") {
          await overlayYouPick(tab.id, rect);
        }
        await companion("/v1/tool-result", {
          method: "POST",
          body: JSON.stringify({ id: act.id, ok: false, error }),
        });
        await setStep(
          act.id,
          message,
          tab.id,
          error === "file_chooser_user_pick" ? { youPick: true, verb: "You pick", phase: "pick" } : {}
        );
      }
      if (!dbg.ok) {
        await failFile(
          "debugger_attach_failed",
          "Could not attach the debugger. File input will not fall back to in-page click(). The agent did not set a file."
        );
        return;
      }
      if (!filePath && !(cmd.args && cmd.args.url)) {
        await failFile("file_chooser_user_pick", "No local path. You pick the file in the highlighted picker.");
        return;
      }
      const prep = await companion("/v1/prepare-file", {
        method: "POST",
        body: JSON.stringify({ path: filePath, url: cmd.args && cmd.args.url }),
      });
      const localPath = prep.data && prep.data.path;
      if (!prep.ok || !localPath) {
        await failFile("file_unreadable", "That path is unreadable. The agent did not set a file.");
        return;
      }
      let clickTarget = null;
      let fileRect = null;
      try {
        const found = await cdpFindRetry(
          tab.id,
          {
            selector: (cmd.args && cmd.args.selector) || 'input[type="file"]',
            name: cmd.args && cmd.args.name,
          },
          2
        );
        if (found && typeof found.x === "number") clickTarget = { x: found.x, y: found.y };
        if (found && found.rect) fileRect = found.rect;
      } catch {
        /* trigger via evaluate if the input has no box */
      }
      const result = await cdpAttachFile(tab.id, [localPath], clickTarget);
      if (!result.ok) {
        await failFile(
          result.error || "file_chooser_user_pick",
          result.error === "file_chooser_user_pick"
            ? result.message || "You pick the file in the highlighted picker. The agent did not set a file."
            : result.message || "The agent did not set a file.",
          fileRect
        );
        return;
      }
      await companion("/v1/tool-result", { method: "POST", body: JSON.stringify({ id: act.id, ok: true }) });
      return;
    }
    await companion("/v1/tool-result", { method: "POST", body: JSON.stringify({ id: act.id, ok: true }) });
  } catch (err) {
    await companion("/v1/tool-result", {
      method: "POST",
      body: JSON.stringify({
        id: act.id,
        ok: false,
        error: "ui_missing",
        message: err && err.message ? err.message : "Tool failed.",
      }),
    });
    await reportProgress(act.id, err && err.message ? err.message : "Tool failed. Fail closed.");
  }
}

async function tick() {
  if (busy) return;
  try {
    const { ok, data } = await companion("/v1/pending");
    if (!ok) return;
    const act = data.act || data.request;
    if (!act) {
      if (lastActId) {
        setBadge("");
        overlayHide();
        cdpDetach(lastTabId);
      }
      lastActId = null;
      lastStatus = null;
      currentStep = "";
      startedKeys.clear();
      return;
    }
    if (act.id !== lastActId) startedKeys.clear();
    if (act.id !== lastActId || act.status !== lastStatus) {
      lastActId = act.id;
      lastStatus = act.status;
      notifyViews({ type: "LPC_ACT", act });
      if (act.tabId) lastTabId = act.tabId;
      if (
        act.status === "pending" ||
        act.status === "waiting_confirm" ||
        act.status === "awaiting_gate"
      ) {
        if (act.tabId) setActingBadge(act.tabId);
      } else if (
        act.status === "queued" ||
        act.status === "planning" ||
        act.status === "acting" ||
        act.status === "running" ||
        act.status === "confirmed"
      ) {
        if (act.tabId) setActingBadge(act.tabId);
      }
    }

    const parked = [
      "waiting_confirm",
      "awaiting_gate",
      "waiting_user",
      "waiting_file_picker",
      "ready_for_publish",
    ];
    if (act.status === "pending") return;

    if (parked.includes(act.status)) {
      if (act.tabId || lastTabId) {
        const tid = act.tabId || lastTabId;
        if (act.status === "waiting_confirm" || act.status === "awaiting_gate") {
          overlayShow(tid, act.step || `Confirm ${act.gate && act.gate.name}`, {
            phase: "confirm",
            verb: "Confirm",
          });
        } else if (act.status === "ready_for_publish") {
          overlayShow(tid, "Ready — not published", { phase: "acting", verb: "Ready" });
        } else if (act.status === "waiting_file_picker") {
          overlayShow(tid, "You pick", { youPick: true, verb: "You pick", phase: "pick" });
        }
      }
      if (!(act.command && act.command.status === "queued")) return;
    }

    if (act.command && act.command.status === "queued") {
      const key = `tool:${act.command.id}`;
      if (startedKeys.has(key)) return;
      startedKeys.add(key);
      busy = true;
      await runTool(act);
      busy = false;
      return;
    }

    if ((act.status === "acting" || act.status === "running") && act.allowGatedOnce && act.gate) {
      const key = `gate:${act.id}`;
      if (startedKeys.has(key)) return;
      startedKeys.add(key);
      busy = true;
      await clickGated(act);
      busy = false;
      return;
    }

    if (["queued", "confirmed", "planning", "acting", "running"].includes(act.status) && !act.command) {
      const key = `fill:${act.id}`;
      if (startedKeys.has(key)) return;
      startedKeys.add(key);
      busy = true;
      await runFill(act);
      busy = false;
    }
  } catch {
    busy = false;
  }
}

function startPoll() {
  if (pollTimer) return;
  tick();
  pollTimer = setInterval(tick, POLL_MS);
}

async function confirmAct(id) {
  const { ok, data } = await companion("/v1/confirm", {
    method: "POST",
    body: JSON.stringify(id ? { id } : {}),
  });
  return { ok, data };
}

async function denyAct(id) {
  const { ok, data } = await companion("/v1/deny", {
    method: "POST",
    body: JSON.stringify(id ? { id } : {}),
  });
  if (ok) {
    setBadge("");
    lastActId = null;
    overlayHide();
    cdpDetach(lastTabId);
  }
  return { ok, data };
}

async function permissionState() {
  const origins = await grantedOrigins();
  const tab = await activeTab();
  let tabOrigin = null;
  let tabGranted = false;
  let tabTitle = "";
  if (tab && tab.url) {
    try {
      tabOrigin = new URL(tab.url).origin;
      tabGranted = await hasOriginAccess(tab.url);
      tabTitle = tab.title || "";
    } catch {
      tabOrigin = null;
    }
  }
  return { origins, tabOrigin, tabGranted, tabTitle };
}

async function revokeSite(originPattern) {
  let pattern = originPattern;
  if (!pattern) {
    const tab = await activeTab();
    if (!tab || !tab.url) return { revoked: false, error: "No active http(s) tab to revoke." };
    try {
      pattern = new URL(tab.url).origin + "/*";
    } catch {
      return { revoked: false, error: "This tab has no origin to revoke." };
    }
  }
  if (!pattern.endsWith("/*") && pattern.startsWith("http")) {
    try {
      pattern = new URL(pattern).origin + "/*";
    } catch {
      /* keep */
    }
  }
  if (String(pattern).includes("127.0.0.1:18741")) {
    return { revoked: false, error: "The companion origin stays granted.", ...(await permissionState()) };
  }
  const removed = await chrome.permissions.remove({ origins: [pattern] });
  return { revoked: removed, origin: pattern, ...(await permissionState()) };
}

async function attachFileOnTab(tabId, filePath, fileUrl) {
  const dbg = await cdpAttachRetry(tabId, 2);
  if (!dbg.ok) {
    return { ok: false, error: "debugger_attach_failed", message: "Could not attach the debugger. The agent did not set a file." };
  }
  if (!filePath && !fileUrl) {
    return { ok: false, error: "file_chooser_user_pick", message: "No local path. You pick the file in the highlighted picker." };
  }
  const prep = await companion("/v1/prepare-file", {
    method: "POST",
    body: JSON.stringify({ path: filePath, url: fileUrl }),
  });
  const localPath = prep.data && prep.data.path;
  if (!prep.ok || !localPath) {
    return { ok: false, error: "file_unreadable", message: "That path is unreadable. The agent did not set a file." };
  }
  let clickTarget = null;
  let fileRect = null;
  try {
    const found = await cdpFindRetry(tabId, { selector: 'input[type="file"]' }, 2);
    if (found && typeof found.x === "number") clickTarget = { x: found.x, y: found.y };
    if (found && found.rect) fileRect = found.rect;
  } catch {
    /* evaluate click inside cdpAttachFile */
  }
  const result = await cdpAttachFile(tabId, [localPath], clickTarget);
  if (!result.ok) {
    if ((result.error || "file_chooser_user_pick") === "file_chooser_user_pick") {
      await overlayYouPick(tabId, fileRect);
    }
    return {
      ok: false,
      error: result.error || "file_chooser_user_pick",
      message: result.message || "The agent did not set a file.",
      rect: fileRect,
    };
  }
  return { ok: true };
}

async function allowSite(kind) {
  if (kind === "all") {
    const granted = await chrome.permissions.request({
      origins: ["<all_urls>"],
      permissions: ["tabs"],
    });
    return { granted, ...(await permissionState()) };
  }
  const tab = await activeTab();
  if (!tab || !tab.url) return { granted: false, error: "No active http(s) tab." };
  let origin;
  try {
    origin = new URL(tab.url).origin + "/*";
  } catch {
    return { granted: false, error: "This tab has no origin to grant." };
  }
  const granted = await chrome.permissions.request({ origins: [origin] });
  return { granted, origin, ...(await permissionState()) };
}

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(startPoll);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "LPC_CONFIRM") {
    confirmAct(message.id).then(sendResponse);
    return true;
  }
  if (message.type === "LPC_DENY") {
    denyAct(message.id).then(sendResponse);
    return true;
  }
  if (message.type === "LPC_ALLOW_SITE") {
    allowSite(message.kind).then(sendResponse);
    return true;
  }
  if (message.type === "LPC_REVOKE_SITE") {
    revokeSite(message.origin).then(sendResponse);
    return true;
  }
  if (message.type === "LPC_PERMISSIONS") {
    permissionState().then(sendResponse).catch(() => sendResponse({ origins: [] }));
    return true;
  }
  if (message.type === "LPC_REQUEST_ATTACH_FILE") {
    const tabId = (_sender && _sender.tab && _sender.tab.id) || lastTabId;
    if (!tabId) {
      sendResponse({ ok: false, error: "ui_missing", message: "No tab for attachFile." });
      return true;
    }
    attachFileOnTab(tabId, message.path || message.mediaPath, message.url).then(sendResponse);
    return true;
  }
  if (message.type === "LPC_SCREENSHOT") {
    sendResponse({ screenshot: lastScreenshot });
    return;
  }
  if (message.type === "LPC_CONTENT_PROGRESS") {
    if (message.id && message.message) reportProgress(message.id, message.message);
    notifyViews({ type: "LPC_PROGRESS", message: message.message, step: message.message });
    currentStep = message.message || currentStep;
    if (lastTabId) overlayShow(lastTabId, message.message);
  }
  if (message.type === "LPC_STEP") {
    currentStep = message.step || currentStep;
    notifyViews({ type: "LPC_STEP", step: currentStep, message: currentStep });
    if (lastActId) {
      companion("/v1/progress", {
        method: "POST",
        body: JSON.stringify({ id: lastActId, step: currentStep, message: currentStep }),
      });
    }
  }
  if (message.type === "LPC_OVERLAY_TOGGLE") {
    overlayEnabled = message.enabled !== false;
    chrome.storage.local.set({ overlayEnabled }).catch(() => {});
    if (!overlayEnabled) overlayHide();
    else if (lastTabId) overlayShow(lastTabId, currentStep || "Running");
    sendResponse({ ok: true, enabled: overlayEnabled });
    return true;
  }
  if (message.type === "LPC_OVERLAY_GET") {
    sendResponse({
      enabled: overlayEnabled,
      step: currentStep,
      attached: lastOverlayState.attached,
      tabId: lastOverlayState.tabId,
      error: lastOverlayState.error,
    });
    return;
  }
  if (message.type === "LPC_PLAN_STEP") {
    currentStep = message.message || message.planStep || currentStep;
    notifyViews({ type: "LPC_STEP", step: currentStep, message: currentStep, planStep: message.planStep });
    if (lastActId) {
      companion("/v1/progress", {
        method: "POST",
        body: JSON.stringify({
          id: message.id || lastActId,
          step: currentStep,
          message: currentStep,
          planStep: message.planStep,
          status: "acting",
        }),
      });
    }
  }
});

chrome.tabs.onActivated.addListener((info) => {
  if (!lastTabId) return;
  if (info.tabId === lastTabId && lastActId) setActingBadge(lastTabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cdpDetach(tabId);
  if (lastTabId === tabId) lastTabId = null;
});

startPoll();
