"use strict";

/**
 * Generic page agent: snapshot, click, type, scroll. Fail closed.
 * Never reads cookies or localStorage for export.
 */

if (!window.__LPC_AGENT__) {
  window.__LPC_AGENT__ = true;

  const GATED_RE =
    /^(publish|post|share|send|pay|delete|purchase|buy now|place order|pay now|donate)(\b|$)/i;

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }

  function accName(el) {
    const bits = [
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("name"),
      el.getAttribute("title"),
      el.innerText,
      el.value,
    ];
    return bits
      .map((b) => (b ? String(b).trim() : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 80);
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (el.getAttribute("role")) return el.getAttribute("role");
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (t === "submit" || t === "button") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (el.isContentEditable) return "textbox";
    return tag;
  }

  function cssPath(el) {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
      return `#${CSS.escape(el.id)}`;
    }
    const parts = [];
    let node = el;
    for (let i = 0; i < 5 && node && node.nodeType === 1 && node !== document.body; i += 1) {
      const tag = node.tagName.toLowerCase();
      let part = tag;
      if (node.className && typeof node.className === "string") {
        const cls = node.className
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .map((c) => `.${CSS.escape(c)}`)
          .join("");
        part += cls;
      }
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function isGatedName(name) {
    const n = String(name || "").trim();
    if (!n) return false;
    if (/^new post$/i.test(n) || /^create$/i.test(n)) return false;
    return GATED_RE.test(n);
  }

  const SELECT =
    'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="menuitem"], [contenteditable="true"]';

  function snapshot() {
    document.querySelectorAll("[data-lpc-ref]").forEach((el) => el.removeAttribute("data-lpc-ref"));
    const nodes = [...document.querySelectorAll(SELECT)].filter(visible).slice(0, 80);
    const elements = nodes.map((el, i) => {
      const ref = `e${i + 1}`;
      el.setAttribute("data-lpc-ref", ref);
      const name = accName(el);
      return {
        ref,
        tag: el.tagName.toLowerCase(),
        role: implicitRole(el),
        name,
        type: el.type || null,
        selector: cssPath(el),
        gated: isGatedName(name),
        value: typeof el.value === "string" ? el.value.slice(0, 80) : "",
      };
    });
    return {
      url: location.href,
      title: document.title,
      elements,
    };
  }

  function byRef(ref) {
    if (!ref) return null;
    return document.querySelector(`[data-lpc-ref="${CSS.escape(ref)}"]`);
  }

  function resolveTarget(args) {
    if (args.ref) {
      const el = byRef(args.ref);
      if (el) return el;
    }
    if (args.selector) {
      try {
        const el = document.querySelector(args.selector);
        if (el && visible(el)) return el;
      } catch {
        /* invalid selector */
      }
    }
    if (args.role || args.name) {
      const wantRole = args.role ? String(args.role).toLowerCase() : null;
      const wantName = args.name ? String(args.name).trim().toLowerCase() : null;
      const nodes = [...document.querySelectorAll(SELECT)].filter(visible);
      for (const el of nodes) {
        const role = implicitRole(el).toLowerCase();
        const name = accName(el).toLowerCase();
        if (wantRole && role !== wantRole) continue;
        if (wantName && name !== wantName && !name.includes(wantName)) continue;
        return el;
      }
    }
    return null;
  }

  function setText(el, value) {
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
      return true;
    }
    return false;
  }

  function clickEl(el) {
    if (!visible(el)) return false;
    if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;
    el.click();
    return true;
  }

  function matchFill(elements, field) {
    const key = field === "title" ? /title|headline/i : /description|caption|comment|body/i;
    const boxes = elements.filter((e) => e.role === "textbox" || e.tag === "textarea" || e.tag === "input");
    return boxes.find((e) => key.test(e.name)) || null;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "LPC_PING") {
      sendResponse({ ok: true, agent: true });
      return;
    }
    if (message.type === "LPC_SNAPSHOT") {
      sendResponse({ ok: true, outline: snapshot() });
      return;
    }
    if (message.type === "LPC_CLICK") {
      (async () => {
        const outline = snapshot();
        const el = resolveTarget(message);
        if (!el) {
          sendResponse({ ok: false, error: "ui_missing", message: "Click target not found. Fail closed." });
          return;
        }
        const name = accName(el);
        const gated = isGatedName(name);
        if (gated && !message.allowGated) {
          if (window.LPCOverlay) {
            await window.LPCOverlay.highlight(el, `Waiting: Confirm ${name}`);
          }
          sendResponse({
            ok: false,
            error: "gated",
            gate: {
              kind: "gated",
              name,
              selector: cssPath(el),
              url: location.href,
              preview: `About to click “${name}” on ${location.hostname}. This looks like Publish/Post/Send/Pay/Delete/Share.`,
            },
          });
          return;
        }
        if (window.LPCOverlay) await window.LPCOverlay.playClick(el, `Click: ${name || "control"}`);
        const clicked = clickEl(el);
        sendResponse({
          ok: clicked,
          error: clicked ? null : "ui_missing",
          message: clicked ? `Clicked ${name}` : "Target was not clickable. Fail closed.",
          outline,
        });
      })();
      return true;
    }
    if (message.type === "LPC_TYPE") {
      (async () => {
        snapshot();
        const el = resolveTarget(message) || document.activeElement;
        if (!el || el === document.body) {
          sendResponse({ ok: false, error: "ui_missing", message: "No field to type into. Fail closed." });
          return;
        }
        if (isGatedName(accName(el)) && !message.allowGated) {
          sendResponse({ ok: false, error: "gated", message: "Refusing to type into a gated control." });
          return;
        }
        const text = message.text == null ? "" : String(message.text);
        const field = accName(el) || "field";
        if (window.LPCOverlay) await window.LPCOverlay.playType(el, text, `Type: ${field}`);
        const ok = setText(el, text);
        sendResponse({
          ok,
          error: ok ? null : "ui_missing",
          message: ok ? "Typed into the field." : "Could not set the field. Fail closed.",
        });
      })();
      return true;
    }
    if (message.type === "LPC_SCROLL") {
      const dir = message.direction === "up" ? -1 : 1;
      const amount = Number(message.amount) || 600;
      window.scrollBy({ top: dir * amount, behavior: "smooth" });
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "LPC_MATCH_FILL") {
      const outline = snapshot();
      const title = matchFill(outline.elements, "title");
      const description = matchFill(outline.elements, "description");
      sendResponse({ ok: true, outline, title, description });
      return;
    }
  });
}
