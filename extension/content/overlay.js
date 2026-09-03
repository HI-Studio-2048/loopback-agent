"use strict";

/**
 * Visible agent overlay. pointer-events: none so real/CDP clicks hit the page.
 * Default ON. Not stealth. Side panel is a separate document (it can receive clicks).
 */

if (!window.__LPC_OVERLAY__) {
  window.__LPC_OVERLAY__ = true;

  /** Glide duration. Keep inside 180–280ms; never teleport. */
  const MOVE_MS = 240;
  const HOST_ID = "loopback-agent-overlay-host";

  let enabled = true;
  let host = null;
  let shadow = null;
  let els = {};
  let cursorPos = { x: 48, y: 80 };
  let moveToken = 0;
  let typing = false;
  let hudState = { verb: "Idle", title: "", host: "", phase: "idle" };

  const CSS = `
    :host, * { box-sizing: border-box; pointer-events: none !important; }
    .layer { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
    .hud {
      position: fixed; left: 12px; bottom: 12px; top: auto; right: auto;
      transform: none;
      max-width: min(340px, calc(100vw - 24px));
      padding: 6px 10px; border-radius: 8px;
      background: rgba(18, 17, 15, 0.92); color: #f3efe4;
      font: 650 12px/1.25 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: -0.01em;
      box-shadow: 0 8px 28px rgba(0,0,0,0.35), 0 0 0 1px rgba(224,180,75,0.35);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .hud b { color: #e0b44b; font-weight: 750; }
    .hud .phase-confirm { color: #e0b44b; }
    .hud .phase-acting { color: #8fca98; }
    .hud .phase-pick { color: #e0b44b; }
    .ring {
      position: fixed; left: 0; top: 0; width: 0; height: 0;
      border: 2px solid #e0b44b; border-radius: 10px;
      box-shadow: 0 0 0 4px rgba(224,180,75,0.22);
      opacity: 0;
    }
    .ring.on { opacity: 1; }
    .cursor {
      position: fixed; left: 0; top: 0; width: 28px; height: 28px;
      transform: translate(48px, 80px);
      filter: drop-shadow(0 2px 6px rgba(0,0,0,0.45));
      z-index: 2;
    }
    .ripple {
      position: fixed; width: 18px; height: 18px; margin: -9px 0 0 -9px;
      border-radius: 999px; border: 2px solid #e0b44b; opacity: 0;
      pointer-events: none;
    }
    .ripple.go {
      animation: lpc-ripple 420ms ease-out forwards;
    }
    @keyframes lpc-ripple {
      0% { transform: scale(0.4); opacity: 0.9; }
      100% { transform: scale(3.2); opacity: 0; }
    }
    .chip {
      position: fixed; max-width: 280px;
      padding: 6px 10px; border-radius: 8px;
      background: #1c1a17; color: #f3efe4;
      font: 600 12px/1.35 ui-sans-serif, system-ui, sans-serif;
      box-shadow: 0 6px 20px rgba(0,0,0,0.3), 0 0 0 1px #322d26;
      opacity: 0; transition: opacity 120ms ease;
    }
    .chip.on { opacity: 1; }
    .chip span { color: #e0b44b; }
  `;

  function cursorSvg() {
    return `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M4 3l10 24 3.2-8.4L26 16z" fill="#12110f" stroke="#e0b44b" stroke-width="2" stroke-linejoin="round"/>
      <path d="M6.2 5.4l8.1 19.2 2.5-6.6 6.8-2.6z" fill="#e0b44b"/>
    </svg>`;
  }

  function ensureDom() {
    if (host && document.contains(host)) return;
    host = document.getElementById(HOST_ID);
    if (host) host.remove();
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-loopback-agent", "overlay");
    host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none !important;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="layer">
        <div class="hud" id="hud" title="Loopback Agent"></div>
        <div class="ring" id="ring"></div>
        <div class="ripple" id="ripple"></div>
        <div class="chip" id="chip"></div>
        <div class="cursor" id="cursor">${cursorSvg()}</div>
      </div>`;
    els = {
      hud: shadow.getElementById("hud"),
      ring: shadow.getElementById("ring"),
      ripple: shadow.getElementById("ripple"),
      chip: shadow.getElementById("chip"),
      cursor: shadow.getElementById("cursor"),
    };
    document.documentElement.appendChild(host);
    setCursor(cursorPos.x, cursorPos.y);
    paintHud();
  }

  function destroy() {
    moveToken += 1;
    typing = false;
    if (host) host.remove();
    host = null;
    shadow = null;
    els = {};
  }

  function setCursor(x, y) {
    cursorPos = { x, y };
    if (!els.cursor) return;
    els.cursor.style.transition = "none";
    els.cursor.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function moveCursor(x, y, ms) {
    const from = { ...cursorPos };
    const duration = Math.max(180, Math.min(280, ms || MOVE_MS));
    const token = ++moveToken;
    return new Promise((resolve) => {
      if (!enabled) {
        setCursor(x, y);
        resolve();
        return;
      }
      ensureDom();
      const start = performance.now();
      function frame(now) {
        if (token !== moveToken) {
          resolve();
          return;
        }
        const t = Math.min(1, (now - start) / duration);
        const e = easeOutCubic(t);
        setCursor(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  function rectOf(elOrRect) {
    if (!elOrRect) return null;
    if (elOrRect.nodeType === 1) {
      const b = elOrRect.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    }
    const r = elOrRect;
    if (typeof r.x === "number") {
      return { x: r.x, y: r.y, w: r.w || r.width || 0, h: r.h || r.height || 0 };
    }
    return null;
  }

  function center(rect) {
    return { x: rect.x + rect.w / 2, y: rect.y + Math.min(rect.h, 28) / 2 };
  }

  function setRing(rect, on) {
    if (!els.ring) return;
    if (!rect || !on) {
      els.ring.classList.remove("on");
      return;
    }
    const pad = 6;
    els.ring.style.left = `${rect.x - pad}px`;
    els.ring.style.top = `${rect.y - pad}px`;
    els.ring.style.width = `${Math.max(8, rect.w + pad * 2)}px`;
    els.ring.style.height = `${Math.max(8, rect.h + pad * 2)}px`;
    els.ring.classList.add("on");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function phaseLabel(phase) {
    if (phase === "confirm") return "Confirm pending";
    if (phase === "pick") return "You pick";
    if (phase === "idle") return "idle";
    return "acting";
  }

  function paintHud() {
    if (!els.hud) return;
    const verb = hudState.verb || "Acting";
    const place = hudState.host || hudState.title || "";
    const phase = phaseLabel(hudState.phase);
    const phaseClass =
      hudState.phase === "confirm" || hudState.phase === "pick"
        ? "phase-confirm"
        : hudState.phase === "acting"
          ? "phase-acting"
          : "";
    els.hud.innerHTML = `<b>${escapeHtml(verb)}</b>${place ? ` · ${escapeHtml(place)}` : ""} · <span class="${phaseClass}">${escapeHtml(phase)}</span>`;
    els.hud.title = [verb, hudState.title, hudState.host, phase].filter(Boolean).join(" · ");
  }

  function applyHud(partial) {
    hudState = { ...hudState, ...partial };
    paintHud();
  }

  function showChip(rect, html) {
    if (!els.chip) return;
    typing = true;
    els.chip.innerHTML = html;
    const top = rect ? Math.max(8, rect.y - 36) : 64;
    const left = rect ? rect.x + 12 : 24;
    els.chip.style.left = `${Math.min(left, window.innerWidth - 200)}px`;
    els.chip.style.top = `${Math.min(top, window.innerHeight - 48)}px`;
    els.chip.classList.add("on");
  }

  function hideChip() {
    typing = false;
    if (els.chip) els.chip.classList.remove("on");
  }

  function rippleAt(x, y) {
    if (!els.ripple) return;
    const node = els.ripple;
    node.classList.remove("go");
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    void node.offsetWidth;
    node.classList.add("go");
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function playClick(target, label) {
    if (!enabled) return;
    ensureDom();
    hideChip();
    const rect = rectOf(target);
    applyHud({ verb: label || "Click", phase: hudState.phase === "confirm" ? "confirm" : "acting" });
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: "LPC_STEP", step: label || "Click" }).catch(() => {});
    }
    if (rect) {
      setRing(rect, true);
      const c = center(rect);
      await moveCursor(c.x, c.y, MOVE_MS);
      rippleAt(c.x, c.y);
      await sleep(90);
    }
  }

  async function playType(target, text, label) {
    if (!enabled) return;
    ensureDom();
    const rect = rectOf(target);
    const shown = text && String(text).trim() ? String(text).slice(0, 80) : "";
    applyHud({ verb: label || "Type", phase: "acting" });
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: "LPC_STEP", step: label || "Type" }).catch(() => {});
    }
    if (rect) {
      setRing(rect, true);
      const caret = { x: rect.x + Math.min(18, rect.w / 4), y: rect.y + Math.min(rect.h / 2, 14) };
      await moveCursor(caret.x, caret.y, MOVE_MS);
      showChip(rect, shown ? `Typing <span>${escapeHtml(shown)}</span>` : "Typing…");
    } else {
      showChip(null, shown ? `Typing <span>${escapeHtml(shown)}</span>` : "Typing…");
    }
  }

  async function highlight(target, label, kind) {
    if (!enabled) return;
    ensureDom();
    const rect = rectOf(target);
    const youPick = kind === "youPick";
    applyHud({
      verb: youPick ? "You pick" : label || "Highlight",
      phase: youPick ? "pick" : /confirm/i.test(String(label || "")) ? "confirm" : "acting",
    });
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: "LPC_STEP", step: label || (youPick ? "You pick the file" : "Highlight") }).catch(() => {});
    }
    if (rect) {
      setRing(rect, true);
      await moveCursor(center(rect).x, center(rect).y, MOVE_MS);
    }
  }

  function show(step, meta) {
    if (!enabled) {
      destroy();
      return;
    }
    ensureDom();
    if (!typing) hideChip();
    applyHud({
      verb: (meta && meta.verb) || step || hudState.verb || "Acting",
      title: meta && meta.title != null ? meta.title : hudState.title,
      host: meta && meta.host != null ? meta.host : hudState.host,
      phase: (meta && meta.phase) || hudState.phase || "acting",
    });
  }

  function hide() {
    hideChip();
    setRing(null, false);
    destroy();
  }

  window.LPCOverlay = {
    get enabled() {
      return enabled;
    },
    setEnabled(v) {
      enabled = v !== false;
      if (!enabled) hide();
    },
    show,
    hide,
    hideChip,
    playClick,
    playType,
    highlight,
    youPick(target, label) {
      return highlight(target, label || "You pick the file", "youPick");
    },
    moveCursor,
  };

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "LPC_OVERLAY_PING") {
      sendResponse({ ok: true, overlay: true, enabled });
      return;
    }
    if (message.type === "LPC_OVERLAY_ENABLED") {
      window.LPCOverlay.setEnabled(message.enabled !== false);
      sendResponse({ ok: true, enabled });
      return;
    }
    if (message.type === "LPC_OVERLAY_SHOW") {
      if (typeof message.enabled === "boolean") window.LPCOverlay.setEnabled(message.enabled);
      show(message.step || "Acting", {
        verb: message.verb,
        title: message.title,
        host: message.host,
        phase: message.youPick ? "pick" : message.phase,
      });
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "LPC_OVERLAY_HIDE") {
      hide();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "LPC_OVERLAY_STEP") {
      show(message.step, {
        verb: message.verb,
        title: message.title,
        host: message.host,
        phase: message.phase,
      });
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "LPC_OVERLAY_CLICK") {
      playClick(message.rect || message, message.label).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === "LPC_OVERLAY_TYPE") {
      playType(message.rect || message, message.text, message.label).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === "LPC_OVERLAY_TYPE_DONE") {
      hideChip();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "LPC_OVERLAY_HIGHLIGHT") {
      const kind = message.youPick || message.reason === "file_chooser_user_pick" ? "youPick" : null;
      highlight(message.rect || message, message.label, kind).then(() => sendResponse({ ok: true }));
      return true;
    }
  });
  }
}
