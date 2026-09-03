"use strict";

/**
 * Fail-closed DOM helpers. Only click nodes we resolved from known selectors.
 * Never scan for "any button" or walk random clickable ancestors.
 */

function lpcVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

function lpcFirst(selectors, root = document) {
  for (const sel of selectors) {
    const nodes = root.querySelectorAll(sel);
    for (const node of nodes) {
      if (lpcVisible(node)) return node;
    }
  }
  return null;
}

/** File inputs are often visually hidden; click() still opens the OS picker. */
function lpcFileInput(root = document) {
  const nodes = root.querySelectorAll('input[type="file"]');
  for (const node of nodes) {
    if (node.disabled) continue;
    return node;
  }
  return null;
}

function lpcByExactText(tagNames, texts, root = document) {
  const want = texts.map((t) => t.trim().toLowerCase());
  const tags = tagNames.join(",");
  const nodes = root.querySelectorAll(tags);
  for (const node of nodes) {
    if (!lpcVisible(node)) continue;
    const label = (node.innerText || node.textContent || "").trim().toLowerCase();
    const aria = (node.getAttribute("aria-label") || "").trim().toLowerCase();
    if (want.includes(label) || want.includes(aria)) return node;
  }
  return null;
}

function lpcSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lpcWait(check, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = check();
    if (last) return last;
    await lpcSleep(intervalMs);
  }
  return last || null;
}

function lpcSetText(el, value, label) {
  const apply = () => {
    if (!el) return false;
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      el.textContent = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  };
  if (window.LPCOverlay && window.LPCOverlay.enabled) {
    return window.LPCOverlay.playType(el, value, label || "Type").then(apply).then((ok) => {
      if (window.LPCOverlay) window.LPCOverlay.hideChip();
      return ok;
    });
  }
  return Promise.resolve(apply());
}

function lpcClick(el, label) {
  const apply = () => {
    if (!el || !lpcVisible(el)) return false;
    if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") {
      return false;
    }
    el.click();
    return true;
  };
  if (window.LPCOverlay && window.LPCOverlay.enabled) {
    return window.LPCOverlay.playClick(el, label || "Click").then(apply);
  }
  return Promise.resolve(apply());
}

function lpcLooksLoggedOut(hints) {
  return Boolean(lpcFirst(hints));
}

function lpcProgress(id, message) {
  chrome.runtime.sendMessage({ type: "LPC_CONTENT_PROGRESS", id, message }).catch(() => {});
}

function lpcFail(error, message) {
  return { ok: false, error, message };
}

function lpcOk() {
  return { ok: true };
}
