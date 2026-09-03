"use strict";

/**
 * chrome.debugger / CDP helpers. Attach is per-tab and shows Chrome's infobar.
 * Never logs cookies, tokens, or screenshot bytes.
 *
 * File inputs: intercept the chooser then set files (Chromium #928255:
 * direct DOM.setFileInputFiles often returns -32000 Not allowed).
 */

const CDP_VERSION = "1.3";
/** @type {Map<number, { sessions: Set<string> }>} */
const attached = new Map();
let snapCache = emptySnap();

function emptySnap() {
  return { tabId: null, gen: 0, nodes: [], byRef: new Map(), byBackend: new Map() };
}

function dbgTarget(tabId, sessionId) {
  const t = { tabId };
  if (sessionId) t.sessionId = sessionId;
  return t;
}

function isStaleError(err) {
  const m = String((err && err.message) || err || "");
  return /-32000|Could not find node|No node with given id|not found|stale|Node is detached/i.test(m);
}

function isNotAllowed(err) {
  const m = String((err && err.message) || err || "");
  return /-32000|Not allowed|not allowed/i.test(m);
}

async function cdpSend(tabId, method, params, sessionId) {
  try {
    return await chrome.debugger.sendCommand(dbgTarget(tabId, sessionId), method, params || {});
  } catch (err) {
    if (sessionId) throw err;
    const sessions = attached.get(tabId) && attached.get(tabId).sessions;
    if (sessions && sessions.size) {
      let last = err;
      for (const sid of sessions) {
        try {
          return await chrome.debugger.sendCommand(dbgTarget(tabId, sid), method, params || {});
        } catch (e) {
          last = e;
        }
      }
      throw last;
    }
    throw err;
  }
}

async function enableDomains(tabId, sessionId) {
  const names = ["Page.enable", "DOM.enable", "Accessibility.enable", "Network.enable", "Runtime.enable", "Target.setAutoAttach"];
  for (const method of names) {
    try {
      if (method === "Target.setAutoAttach") {
        await cdpSend(
          tabId,
          method,
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          sessionId
        );
      } else {
        await cdpSend(tabId, method, {}, sessionId);
      }
    } catch {
      /* domain optional on this target */
    }
  }
}

async function cdpAttach(tabId) {
  if (tabId == null) return { ok: false, error: "no tab" };
  if (attached.has(tabId)) {
    try {
      await cdpSend(tabId, "Runtime.evaluate", { expression: "1", returnByValue: true });
      return { ok: true, already: true };
    } catch {
      attached.delete(tabId);
    }
  }
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/already attached/i.test(msg)) {
      attached.set(tabId, { sessions: new Set() });
      await enableDomains(tabId);
      return { ok: true, already: true };
    }
    return { ok: false, error: msg };
  }
  attached.set(tabId, { sessions: new Set() });
  await enableDomains(tabId);
  return { ok: true };
}

async function cdpAttachRetry(tabId, attempts = 2) {
  let last = { ok: false, error: "attach failed" };
  for (let i = 0; i < attempts; i += 1) {
    last = await cdpAttach(tabId);
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  return last;
}

async function cdpDetach(tabId) {
  if (tabId == null) {
    for (const id of [...attached.keys()]) {
      try {
        await chrome.debugger.detach({ tabId: id });
      } catch {
        /* ignore */
      }
      attached.delete(id);
    }
    snapCache = emptySnap();
    return;
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* ignore */
  }
  attached.delete(tabId);
  if (snapCache.tabId === tabId) snapCache = emptySnap();
}

async function cdpSwitchTab(fromTabId, toTabId) {
  if (fromTabId && fromTabId !== toTabId) await cdpDetach(fromTabId);
  return cdpAttachRetry(toTabId);
}

function compactAx(raw) {
  const nodes = (raw && raw.nodes) || [];
  const out = [];
  for (const n of nodes) {
    if (n.ignored) continue;
    const role = n.role && n.role.value;
    const name = n.name && n.name.value;
    if (!role && !name) continue;
    out.push({
      nodeId: n.nodeId,
      role: role || "",
      name: (name || "").slice(0, 120),
      backendDOMNodeId: n.backendDOMNodeId || null,
    });
    if (out.length >= 160) break;
  }
  return out;
}

function gatedName(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  if (/^new post$/i.test(n) || /^create$/i.test(n)) return false;
  return /^(publish|post|share|send|pay|delete|purchase|buy now|place order|pay now|donate)(\b|$)/i.test(n);
}

async function cdpQuads(tabId, backendDOMNodeId) {
  try {
    const res = await cdpSend(tabId, "DOM.getContentQuads", { backendNodeId: backendDOMNodeId });
    const quad = res && res.quads && res.quads[0];
    if (!quad || quad.length < 8) return null;
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;
    if (w < 1 && h < 1) return null;
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  } catch (err) {
    if (isStaleError(err)) return null;
    return null;
  }
}

async function cdpBox(tabId, backendDOMNodeId) {
  try {
    const res = await cdpSend(tabId, "DOM.getBoxModel", { backendNodeId: backendDOMNodeId });
    const content = res && res.model && res.model.content;
    if (!content || content.length < 8) return cdpQuads(tabId, backendDOMNodeId);
    const xs = [content[0], content[2], content[4], content[6]];
    const ys = [content[1], content[3], content[5], content[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;
    if (w < 1 && h < 1) return cdpQuads(tabId, backendDOMNodeId);
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  } catch (err) {
    if (isStaleError(err)) return null;
    return cdpQuads(tabId, backendDOMNodeId);
  }
}

async function nodeAlive(tabId, backendDOMNodeId) {
  if (!backendDOMNodeId) return false;
  try {
    const desc = await cdpSend(tabId, "DOM.describeNode", { backendNodeId: backendDOMNodeId });
    return Boolean(desc && desc.node);
  } catch (err) {
    return !isStaleError(err) && false;
  }
}

function rememberSnap(tabId, nodes) {
  const byRef = new Map();
  const byBackend = new Map();
  for (const n of nodes) {
    if (n.ref) byRef.set(n.ref, n);
    if (n.backendDOMNodeId) byBackend.set(n.backendDOMNodeId, n);
  }
  snapCache = { tabId, gen: snapCache.gen + 1, nodes, byRef, byBackend };
}

async function cdpFuseSnapshot(tabId) {
  const raw = await cdpSend(tabId, "Accessibility.getFullAXTree").catch(() => null);
  const ax = compactAx(raw);
  const nodes = [];
  for (const n of ax) {
    if (!n.backendDOMNodeId) continue;
    const box = await cdpBox(tabId, n.backendDOMNodeId);
    if (!box) continue;
    const ref = `n${n.backendDOMNodeId}`;
    nodes.push({
      ref,
      role: n.role,
      name: n.name,
      backendDOMNodeId: n.backendDOMNodeId,
      nodeId: n.nodeId,
      gated: gatedName(n.name),
      box,
      rect: { x: box.x, y: box.y, w: box.w, h: box.h },
      x: box.cx,
      y: box.cy,
    });
  }
  rememberSnap(tabId, nodes);
  let screenshot = null;
  try {
    screenshot = await cdpScreenshot(tabId);
  } catch {
    screenshot = null;
  }
  return {
    tabId,
    gen: snapCache.gen,
    url: null,
    title: null,
    elements: nodes.map((n) => ({
      ref: n.ref,
      role: n.role,
      name: n.name,
      backendDOMNodeId: n.backendDOMNodeId,
      gated: n.gated,
      selector: `[data-lpc-ref="${n.ref}"]`,
      box: n.box,
    })),
    ax,
    screenshot,
  };
}

function matchCached(args) {
  if (args.ref && snapCache.byRef.has(args.ref)) return snapCache.byRef.get(args.ref);
  if (args.backendDOMNodeId && snapCache.byBackend.has(args.backendDOMNodeId)) {
    return snapCache.byBackend.get(args.backendDOMNodeId);
  }
  return null;
}

function matchByRoleName(nodes, args) {
  const wantName = args.name ? String(args.name).trim().toLowerCase() : null;
  const wantRole = args.role ? String(args.role).trim().toLowerCase() : null;
  if (!wantName && !wantRole) return null;
  return (
    nodes.find((n) => {
      if (wantRole && n.role.toLowerCase() !== wantRole) return false;
      if (wantName) {
        const nm = (n.name || "").toLowerCase();
        if (nm !== wantName && !nm.includes(wantName)) return false;
      }
      return true;
    }) || null
  );
}

async function cdpFind(tabId, args) {
  let hit = matchCached(args);
  if (hit) {
    const alive = await nodeAlive(tabId, hit.backendDOMNodeId);
    if (!alive) {
      hit = null;
      await cdpFuseSnapshot(tabId);
      hit = matchCached(args) || matchByRoleName(snapCache.nodes, args);
    } else {
      const box = await cdpBox(tabId, hit.backendDOMNodeId);
      if (!box) {
        hit = null;
      } else {
        hit = { ...hit, box, rect: { x: box.x, y: box.y, w: box.w, h: box.h }, x: box.cx, y: box.cy };
      }
    }
  }
  if (!hit) {
    if (!snapCache.nodes.length || snapCache.tabId !== tabId) await cdpFuseSnapshot(tabId);
    hit = matchByRoleName(snapCache.nodes, args);
  }
  if (!hit && args.selector) {
    try {
      const doc = await cdpSend(tabId, "DOM.getDocument", { depth: 0 });
      const q = await cdpSend(tabId, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: args.selector,
      });
      if (q && q.nodeId) {
        const desc = await cdpSend(tabId, "DOM.describeNode", { nodeId: q.nodeId });
        const backend = desc && desc.node && desc.node.backendNodeId;
        if (backend) {
          const box = await cdpBox(tabId, backend);
          if (box) {
            hit = {
              backendDOMNodeId: backend,
              name: args.name || args.selector,
              role: args.role || "",
              gated: gatedName(args.name || ""),
              box,
              rect: { x: box.x, y: box.y, w: box.w, h: box.h },
              x: box.cx,
              y: box.cy,
              ref: `n${backend}`,
            };
          }
        }
      }
    } catch (err) {
      if (!isStaleError(err)) {
        /* selector miss */
      }
    }
  }
  if (!hit || !hit.backendDOMNodeId) return null;
  const alive = await nodeAlive(tabId, hit.backendDOMNodeId);
  if (!alive) return null;
  return {
    ...hit,
    gated: hit.gated || gatedName(hit.name),
  };
}

async function cdpFindRetry(tabId, args, attempts = 2) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await cdpFind(tabId, args);
    if (last) return last;
    await cdpFuseSnapshot(tabId).catch(() => {});
  }
  return last;
}

async function cdpMouseClick(tabId, x, y) {
  const base = { x, y, button: "left", pointerType: "mouse" };
  await cdpSend(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved" });
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    ...base,
    type: "mousePressed",
    clickCount: 1,
  });
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    ...base,
    type: "mouseReleased",
    clickCount: 1,
  });
}

async function cdpFocus(tabId, backendDOMNodeId) {
  await cdpSend(tabId, "DOM.focus", { backendNodeId: backendDOMNodeId });
}

async function cdpInsertText(tabId, text) {
  await cdpSend(tabId, "Input.insertText", { text: String(text) });
}

const KEY_MAP = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
};

async function cdpKey(tabId, keyName, modifiers = 0) {
  const spec = KEY_MAP[keyName] || {
    key: keyName,
    code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName,
    text: keyName.length === 1 ? keyName : undefined,
    windowsVirtualKeyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0,
  };
  const base = { modifiers, ...spec };
  await cdpSend(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  if (base.text) {
    await cdpSend(tabId, "Input.dispatchKeyEvent", { type: "char", ...base });
  }
  await cdpSend(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function cdpType(tabId, text, press) {
  if (text) await cdpInsertText(tabId, text);
  if (press) await cdpKey(tabId, press);
}

async function cdpScreenshot(tabId) {
  const res = await cdpSend(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 40,
  });
  if (!res || !res.data) return null;
  return `data:image/jpeg;base64,${res.data}`;
}

const inflight = new Map();

function trackNetwork(tabId, method, params) {
  if (!params) return;
  let set = inflight.get(tabId);
  if (!set) {
    set = new Set();
    inflight.set(tabId, set);
  }
  if (method === "Network.requestWillBeSent" && params.requestId) set.add(params.requestId);
  if (
    (method === "Network.loadingFinished" || method === "Network.loadingFailed") &&
    params.requestId
  ) {
    set.delete(params.requestId);
  }
}

async function cdpWaitLoad(tabId, timeoutMs = 20000) {
  await cdpSend(tabId, "Page.enable").catch(() => {});
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(onEvent);
      resolve("timeout");
    }, timeoutMs);
    function onEvent(source, method) {
      if (!source || source.tabId !== tabId) return;
      if (method === "Page.loadEventFired" || method === "Page.frameStoppedLoading") {
        clearTimeout(t);
        chrome.debugger.onEvent.removeListener(onEvent);
        resolve("loaded");
      }
    }
    chrome.debugger.onEvent.addListener(onEvent);
  });
}

async function cdpWaitQuiet(tabId, timeoutMs = 8000, quietMs = 280) {
  const start = Date.now();
  let quietSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    const set = inflight.get(tabId);
    const busy = set && set.size > 0;
    if (!busy) {
      if (Date.now() - quietSince >= quietMs) return "quiet";
    } else {
      quietSince = Date.now();
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return "timeout";
}

async function cdpAfterInput(tabId) {
  await cdpWaitQuiet(tabId, 6000, 250);
  try {
    await cdpFuseSnapshot(tabId);
  } catch {
    /* snapshot best-effort */
  }
}

function waitFileChooser(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(onEvent);
      const err = new Error("File chooser did not open. User must pick the file.");
      err.code = "file_chooser_user_pick";
      reject(err);
    }, timeoutMs);
    function onEvent(source, method, params) {
      if (!source || source.tabId !== tabId) return;
      if (method !== "Page.fileChooserOpened") return;
      clearTimeout(t);
      chrome.debugger.onEvent.removeListener(onEvent);
      resolve(params || {});
    }
    chrome.debugger.onEvent.addListener(onEvent);
  });
}

/**
 * Intercept the native file chooser, trigger it, set files on the opened node.
 * Do not call DOM.setFileInputFiles on a guessed node — Chromium #928255.
 */
async function cdpAttachFile(tabId, files, clickTarget) {
  try {
    await cdpSend(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
  } catch (err) {
    return {
      ok: false,
      error: "file_chooser_user_pick",
      message:
        "Could not intercept the file chooser. Pick the file in the highlighted picker. Direct setFileInputFiles is not allowed (Chromium #928255).",
    };
  }
  const waiter = waitFileChooser(tabId, 8000);
  try {
    if (clickTarget && typeof clickTarget.x === "number") {
      await cdpMouseClick(tabId, clickTarget.x, clickTarget.y);
    } else {
      await cdpSend(tabId, "Runtime.evaluate", {
        expression:
          "document.querySelector('input[type=file]:not([disabled])')?.click() ?? false",
        userGesture: true,
      });
    }
    const opened = await waiter;
    const backendNodeId = opened.backendNodeId;
    if (!backendNodeId) {
      await cdpSend(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      return {
        ok: false,
        error: "file_chooser_user_pick",
        message: "File chooser opened without a node id. Pick the file yourself.",
      };
    }
    try {
      await cdpSend(tabId, "DOM.setFileInputFiles", { backendNodeId, files });
    } catch (err) {
      await cdpSend(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      return {
        ok: false,
        error: "file_chooser_user_pick",
        message: isNotAllowed(err)
          ? "CDP refused to set the file (Chromium #928255). Pick the file in the highlighted picker."
          : "Could not set the chosen file. Pick it in the highlighted picker.",
      };
    }
    await cdpSend(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    await cdpAfterInput(tabId);
    return { ok: true, backendNodeId };
  } catch (err) {
    await cdpSend(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    return {
      ok: false,
      error: (err && err.code) || "file_chooser_user_pick",
      message:
        (err && err.message) ||
        "File chooser did not open. Pick the file in the highlighted picker.",
    };
  }
}

if (chrome.debugger && chrome.debugger.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!source || source.tabId == null) return;
    const tabId = source.tabId;
    if (method === "Target.attachedToTarget" && params && params.sessionId) {
      let rec = attached.get(tabId);
      if (!rec) {
        rec = { sessions: new Set() };
        attached.set(tabId, rec);
      }
      rec.sessions.add(params.sessionId);
      enableDomains(tabId, params.sessionId).catch(() => {});
      if (params.waitingForDebugger) {
        cdpSend(tabId, "Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {});
      }
    }
    if (method === "Target.detachedFromTarget" && params && params.sessionId) {
      const rec = attached.get(tabId);
      if (rec) rec.sessions.delete(params.sessionId);
    }
    trackNetwork(tabId, method, params);
  });
}

if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId) {
      attached.delete(source.tabId);
      inflight.delete(source.tabId);
      if (snapCache.tabId === source.tabId) snapCache = emptySnap();
    }
  });
}
