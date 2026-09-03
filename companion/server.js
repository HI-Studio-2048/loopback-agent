#!/usr/bin/env node
"use strict";

/**
 * Loopback-only companion. Binds 127.0.0.1 — never 0.0.0.0.
 * Does not log captions, snapshots, cookies, or tokens.
 */

const http = require("node:http");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  BLOCKING_STATUSES,
  ERRORS,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_TTL_MS,
  validatePostRequest,
  validateAct,
  validateTool,
  publicRequest,
  publicAct,
  postRequestToAct,
} = require("../shared/schema");

const HOST = DEFAULT_HOST;
const PORT = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
const MAX_BODY = 3 * 1024 * 1024;

function ttlMs() {
  return Number.parseInt(process.env.REQUEST_TTL_MS || String(DEFAULT_TTL_MS), 10);
}

/** @type {Map<string, object>} */
const requests = new Map();
/** @type {string | null} */
let activeId = null;

function now() {
  return Date.now();
}

function newId(prefix = "req") {
  return `${prefix}_${now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function expireIfNeeded(req) {
  if (!req) return req;
  if ((req.status === "pending" || req.status === "awaiting_gate") && req.expiresAt <= now()) {
    req.status = "expired";
    req.error = { code: "expired", message: ERRORS.expired.message };
    req.updatedAt = now();
    if (activeId === req.id) activeId = null;
    logLine("expire", req.id, req.kind, "expired");
  }
  return req;
}

function getActive() {
  if (!activeId) return null;
  const req = expireIfNeeded(requests.get(activeId));
  if (!req || !BLOCKING_STATUSES.includes(req.status)) {
    if (req && activeId === req.id && !BLOCKING_STATUSES.includes(req.status)) {
      activeId = null;
    }
    if (!req) activeId = null;
    return null;
  }
  return req;
}

function logLine(event, id, kind, status) {
  // Never log intent text, snapshots, cookies, tokens, or full file paths.
  const parts = [new Date().toISOString(), event];
  if (id) parts.push(id);
  if (kind) parts.push(kind);
  if (status) parts.push(status);
  console.log(parts.join(" "));
}

function copyForChromeRead(absPath) {
  const real = fs.realpathSync(absPath);
  if (!fs.statSync(real).isFile()) {
    throw new Error("not a file");
  }
  const tmpDir = path.join(os.tmpdir(), "loopback-post");
  fs.mkdirSync(tmpDir, { recursive: true });
  const ext = path.extname(real).slice(0, 16);
  const dest = path.join(tmpDir, `prep-${randomBytes(8).toString("hex")}${ext}`);
  fs.copyFileSync(real, dest);
  fs.chmodSync(dest, 0o644);
  return dest;
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

function send(req, res, status, body) {
  setCors(req, res);
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
  });
  res.end(json);
}

function sendError(req, res, err, extra = {}) {
  send(req, res, err.http, {
    error: err.code,
    message: err.message,
    ...extra,
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { code: "too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function parseJson(req, res, { optional = false } = {}) {
  const type = String(req.headers["content-type"] || "");
  if (!type.toLowerCase().includes("application/json")) {
    if (optional && !type) return {};
    sendError(req, res, ERRORS.invalid_request);
    return null;
  }
  try {
    const raw = await readBody(req);
    if (!raw.length) return {};
    const parsed = JSON.parse(raw.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    sendError(req, res, ERRORS.invalid_request);
    return null;
  } catch (err) {
    if (err && err.code === "too_large") {
      send(req, res, 413, { error: "too_large", message: "Request body exceeds 3MiB." });
      return null;
    }
    sendError(req, res, ERRORS.invalid_request);
    return null;
  }
}

function resolveById(id) {
  if (!id) return null;
  return expireIfNeeded(requests.get(id) || null);
}

function payload(rec) {
  return { request: publicRequest(rec), act: publicAct(rec) };
}

function queueAct(fields, created = now()) {
  const rec = {
    id: newId("act"),
    kind: fields.kind || "act",
    platform: fields.platform || null,
    caption: fields.caption || "",
    title: fields.title || null,
    tags: fields.tags || [],
    mediaPath: fields.mediaPath || null,
    intent: fields.intent,
    startUrl: fields.startUrl || null,
    confirmToStart: Boolean(fields.confirmToStart),
    noPublish: Boolean(fields.noPublish),
    fillTitle: fields.fillTitle || null,
    fillDescription: fields.fillDescription || null,
    status: fields.confirmToStart ? "pending" : "running",
    gate: null,
    allowGatedOnce: false,
    command: null,
    snapshotMeta: null,
    snapshotOutline: null,
    ax: null,
    axCount: 0,
    screenshot: null,
    step: null,
    error: null,
    progress: fields.confirmToStart
      ? "Waiting for Confirm-to-start in the Chrome side panel."
      : "Queued. The extension will run the intent. Publish/Send/Pay/Delete/Share still require Confirm.",
    createdAt: created,
    updatedAt: created,
    expiresAt: created + ttlMs(),
  };
  requests.set(rec.id, rec);
  activeId = rec.id;
  logLine(rec.kind, rec.id, rec.kind, rec.status);
  return rec;
}

function statusPage() {
  const active = getActive();
  const shown = publicAct(active);
  const json = JSON.stringify(shown, null, 2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Loopback Agent companion</title>
  <style>
    :root { color-scheme: dark; }
    body { font: 15px/1.45 ui-sans-serif, system-ui, sans-serif; margin: 0; background: #12110f; color: #ece7dc; }
    main { max-width: 42rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.35rem; font-weight: 620; letter-spacing: -0.02em; margin: 0 0 0.4rem; }
    p { color: #c4bba8; }
    .ok { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; background: #243226; color: #b7e0b8; font-size: 0.8rem; }
    pre { background: #1c1a17; border: 1px solid #2e2a24; border-radius: 10px; padding: 1rem; overflow: auto; color: #f3efe4; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.86em; }
    .warn { border-left: 3px solid #d4a017; padding-left: 0.75rem; }
  </style>
</head>
<body>
  <main>
    <p class="ok">listening on 127.0.0.1 only</p>
    <h1>Loopback Agent companion</h1>
    <p>This process never publishes. It queues one act. Publish/Send/Pay/Delete/Share wait for Confirm in the Chrome side panel.</p>
    <p class="warn">Do not expose this port. Do not deploy this server to Railway, a VPS, or any tunnel.</p>
    <h2>Active act</h2>
    <pre>${escapeHtml(json)}</pre>
  </main>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function finish(rec, status, error, message) {
  rec.status = status;
  rec.updatedAt = now();
  rec.allowGatedOnce = false;
  if (error) {
    const known = ERRORS[error];
    rec.error = {
      code: error,
      message: message || (known && known.message) || "Act failed.",
    };
    rec.progress = rec.error.message;
  } else {
    rec.error = null;
    rec.progress = message || rec.progress;
  }
  if (activeId === rec.id) activeId = null;
  logLine("result", rec.id, rec.kind, rec.status);
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    setCors(req, res);
    if (res.getHeader("Access-Control-Allow-Origin")) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(403);
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/") {
    const html = statusPage();
    setCors(req, res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    send(req, res, 200, {
      ok: true,
      bind: HOST,
      port: currentPort,
      active: activeId,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/post-request") {
    const body = await parseJson(req, res);
    if (!body) return;
    const parsed = validatePostRequest(body);
    if (parsed.error) {
      sendError(req, res, parsed.error);
      return;
    }
    const existing = getActive();
    if (existing) {
      sendError(req, res, ERRORS.already_pending, { pendingId: existing.id, status: existing.status });
      return;
    }
    const rec = queueAct(postRequestToAct(parsed.value));
    send(req, res, 201, {
      id: rec.id,
      status: rec.status,
      expiresAt: rec.expiresAt,
      message:
        "Queued. Open the Chrome side panel and Confirm to start. Publish/Share still waits for a second Confirm at the gated control.",
      ...payload(rec),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/act") {
    const body = await parseJson(req, res);
    if (!body) return;
    const parsed = validateAct(body);
    if (parsed.error) {
      sendError(req, res, parsed.error);
      return;
    }
    const existing = getActive();
    if (existing) {
      sendError(req, res, ERRORS.already_pending, { pendingId: existing.id, status: existing.status });
      return;
    }
    const rec = queueAct({ kind: "act", ...parsed.value });
    send(req, res, 201, {
      id: rec.id,
      status: rec.status,
      expiresAt: rec.expiresAt,
      message: rec.confirmToStart
        ? "Queued. Confirm-to-start in the side panel. Publish/Send/Pay/Delete/Share still require a later Confirm."
        : "Queued. The extension will start. It will not click Publish/Send/Pay/Delete/Share unless you Confirm that gated step.",
      ...payload(rec),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/pending") {
    const active = getActive();
    send(req, res, 200, payload(active));
    return;
  }

  if (req.method === "POST" && pathname === "/v1/confirm") {
    const body = await parseJson(req, res, { optional: true });
    if (body === null) return;
    const rec = body.id ? resolveById(body.id) : getActive();
    if (!rec) {
      sendError(req, res, ERRORS.no_pending);
      return;
    }
    if (rec.status === "expired") {
      sendError(req, res, ERRORS.expired);
      return;
    }
    if (rec.status === "pending") {
      rec.status = "confirmed";
      rec.progress = "Start confirmed. The extension will operate in this Chrome profile.";
      rec.updatedAt = now();
      rec.expiresAt = now() + ttlMs();
      logLine("confirm-start", rec.id, rec.kind, rec.status);
      send(req, res, 200, payload(rec));
      return;
    }
    if (rec.status === "awaiting_gate") {
      rec.status = "running";
      rec.allowGatedOnce = true;
      rec.progress = "Gated step confirmed. The extension will click that control once.";
      rec.updatedAt = now();
      rec.expiresAt = now() + ttlMs();
      logLine("confirm-gate", rec.id, rec.kind, rec.status);
      send(req, res, 200, payload(rec));
      return;
    }
    sendError(req, res, ERRORS.no_pending);
    return;
  }

  if (req.method === "POST" && pathname === "/v1/deny") {
    const body = await parseJson(req, res, { optional: true });
    if (body === null) return;
    const rec = body.id ? resolveById(body.id) : getActive();
    if (!rec || !BLOCKING_STATUSES.includes(rec.status)) {
      sendError(req, res, rec && rec.status === "expired" ? ERRORS.expired : ERRORS.no_pending);
      return;
    }
    finish(rec, "denied", "denied", ERRORS.denied.message);
    send(req, res, 200, payload(rec));
    return;
  }

  if (req.method === "POST" && pathname === "/v1/progress") {
    const body = await parseJson(req, res);
    if (!body) return;
    const rec = resolveById(body.id);
    if (!rec) {
      sendError(req, res, ERRORS.not_found);
      return;
    }
    if (typeof body.message === "string") {
      rec.progress = body.message.slice(0, 500);
      rec.updatedAt = now();
    }
    if (typeof body.step === "string") {
      rec.step = body.step.slice(0, 200);
      rec.progress = rec.step;
      rec.updatedAt = now();
    }
    if (rec.status === "confirmed") rec.status = "running";
    send(req, res, 200, payload(rec));
    return;
  }

  if (req.method === "POST" && pathname === "/v1/gate") {
    const body = await parseJson(req, res);
    if (!body) return;
    const rec = resolveById(body.id) || getActive();
    if (!rec) {
      sendError(req, res, ERRORS.not_found);
      return;
    }
    rec.status = "awaiting_gate";
    rec.allowGatedOnce = false;
    rec.gate = {
      kind: typeof body.kind === "string" ? body.kind : "publish",
      name: typeof body.name === "string" ? body.name.slice(0, 120) : "Publish",
      selector: typeof body.selector === "string" ? body.selector.slice(0, 300) : null,
      url: typeof body.url === "string" ? body.url.slice(0, 500) : null,
      preview: typeof body.preview === "string" ? body.preview.slice(0, 800) : "A gated control was found. Confirm to click it once, or Deny to abort.",
    };
    rec.progress = rec.gate.preview;
    rec.step = `Waiting: Confirm ${rec.gate.name}`;
    rec.updatedAt = now();
    rec.expiresAt = now() + ttlMs();
    logLine("gate", rec.id, rec.kind, rec.status);
    send(req, res, 200, payload(rec));
    return;
  }

  if (req.method === "POST" && pathname === "/v1/snapshot") {
    const body = await parseJson(req, res);
    if (!body) return;
    const rec = resolveById(body.id) || getActive();
    if (!rec) {
      sendError(req, res, ERRORS.not_found);
      return;
    }
    const outline = body.outline && typeof body.outline === "object" ? body.outline : null;
    if (outline) {
      rec.snapshotOutline = {
        url: typeof outline.url === "string" ? outline.url.slice(0, 500) : "",
        title: typeof outline.title === "string" ? outline.title.slice(0, 200) : "",
        capturedAt: now(),
        elements: Array.isArray(outline.elements) ? outline.elements.slice(0, 80) : [],
      };
      rec.snapshotMeta = {
        url: rec.snapshotOutline.url,
        title: rec.snapshotOutline.title,
        capturedAt: rec.snapshotOutline.capturedAt,
        elementCount: rec.snapshotOutline.elements.length,
      };
    }
    if (Array.isArray(body.ax)) {
      rec.ax = body.ax.slice(0, 120);
      rec.axCount = rec.ax.length;
      rec.snapshotMeta = rec.snapshotMeta || {};
      rec.snapshotMeta.axCount = rec.axCount;
    }
    if (typeof body.screenshot === "string" && body.screenshot.startsWith("data:image/")) {
      rec.screenshot = body.screenshot.length < 2.8 * 1024 * 1024 ? body.screenshot : null;
      rec.snapshotMeta = rec.snapshotMeta || {};
      rec.snapshotMeta.hasScreenshot = Boolean(rec.screenshot);
    }
    rec.updatedAt = now();
    send(req, res, 200, payload(rec));
    return;
  }

  if (req.method === "GET" && pathname === "/v1/snapshot") {
    const rec = url.searchParams.get("id") ? resolveById(url.searchParams.get("id")) : getActive();
    if (!rec) {
      sendError(req, res, ERRORS.not_found);
      return;
    }
    send(req, res, 200, {
      id: rec.id,
      snapshot: rec.snapshotOutline,
      ax: rec.ax || [],
      meta: rec.snapshotMeta,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/screenshot") {
    const rec = url.searchParams.get("id") ? resolveById(url.searchParams.get("id")) : getActive();
    if (!rec) {
      sendError(req, res, ERRORS.not_found);
      return;
    }
    send(req, res, 200, {
      id: rec.id,
      screenshot: rec.screenshot || null,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/prepare-file") {
    const body = await parseJson(req, res);
    if (!body) return;
    try {
      if (typeof body.path === "string" && body.path.trim()) {
        const abs = path.resolve(body.path.trim());
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          sendError(req, res, ERRORS.file_unreadable);
          return;
        }
        const dest = copyForChromeRead(abs);
        logLine("prepare-file", "", "copy", "ok");
        send(req, res, 200, { ok: true, path: dest });
        return;
      }
      if (typeof body.url === "string" && /^https?:\/\//i.test(body.url)) {
        const tmpDir = path.join(os.tmpdir(), "loopback-post");
        fs.mkdirSync(tmpDir, { recursive: true });
        const resHttp = await fetch(body.url);
        if (!resHttp.ok) {
          sendError(req, res, ERRORS.file_unreadable);
          return;
        }
        const buf = Buffer.from(await resHttp.arrayBuffer());
        if (buf.length > 80 * 1024 * 1024) {
          send(req, res, 413, { error: "too_large", message: "Download exceeds 80MiB." });
          return;
        }
        const dest = path.join(tmpDir, `prep-${randomBytes(8).toString("hex")}`);
        fs.writeFileSync(dest, buf);
        fs.chmodSync(dest, 0o644);
        logLine("prepare-file", "", "download", "ok");
        send(req, res, 200, { ok: true, path: dest });
        return;
      }
      sendError(req, res, ERRORS.invalid_request);
    } catch {
      sendError(req, res, ERRORS.file_unreadable);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/v1/tool") {
    const body = await parseJson(req, res);
    if (!body) return;
    const rec = body.id ? resolveById(body.id) : getActive();
    if (!rec || !BLOCKING_STATUSES.includes(rec.status)) {
      sendError(req, res, ERRORS.not_found);
      return;
    }
    if (rec.status === "pending") {
      sendError(req, res, ERRORS.no_pending, { message: "Confirm-to-start first." });
      return;
    }
    if (rec.status === "awaiting_gate") {
      sendError(req, res, ERRORS.gated);
      return;
    }
    const parsed = validateTool(body);
    if (parsed.error) {
      sendError(req, res, parsed.error);
      return;
    }
    rec.command = {
      id: newId("tool"),
      tool: parsed.value.tool,
      args: parsed.value.args,
      status: "queued",
    };
    rec.status = "running";
    rec.updatedAt = now();
    rec.progress = `Tool queued: ${parsed.value.tool}`;
    logLine("tool", rec.id, parsed.value.tool, "queued");
    send(req, res, 202, payload(rec));
    return;
  }

  if (req.method === "POST" && pathname === "/v1/tool-result") {
    const body = await parseJson(req, res);
    if (!body) return;
    const rec = resolveById(body.id) || getActive();
    if (!rec) {
      sendError(req, res, ERRORS.not_found);
      return;
    }
    if (rec.command) {
      rec.command.status = body.ok === false ? "error" : "done";
      rec.command.resultCode = typeof body.error === "string" ? body.error : null;
    }
    rec.updatedAt = now();
    send(req, res, 200, payload(rec));
    return;
  }

  if (req.method === "POST" && pathname === "/v1/result") {
    const body = await parseJson(req, res);
    if (!body) return;
    const rec = resolveById(body.id);
    if (!rec) {
      sendError(req, res, ERRORS.not_found);
      return;
    }
    const allowed = ["published", "failed", "completed"];
    const next = allowed.includes(body.status) ? body.status : "failed";
    finish(
      rec,
      next,
      next === "failed" ? (typeof body.error === "string" ? body.error : "failed") : null,
      typeof body.message === "string" ? body.message : next === "published" ? "Gated action ran after Confirm." : next === "completed" ? "Act finished without a gated click." : null
    );
    send(req, res, 200, payload(rec));
    return;
  }

  const statusMatch = pathname.match(/^\/v1\/status\/([^/]+)$/);
  if (req.method === "GET" && statusMatch) {
    const rec = resolveById(decodeURIComponent(statusMatch[1]));
    if (!rec) {
      sendError(req, res, ERRORS.not_found);
      return;
    }
    send(req, res, 200, payload(rec));
    return;
  }

  send(req, res, 404, { error: "not_found", message: "No such route." });
}

let currentPort = PORT;

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logLine("error", "", "", err && err.name);
      if (!res.headersSent) {
        send(req, res, 500, { error: "internal", message: "Companion failed to handle the request." });
      }
    });
  });
}

function listen(server, port = PORT, host = HOST) {
  if (host !== "127.0.0.1") {
    throw new Error("Companion must bind 127.0.0.1 only.");
  }
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string" || addr.address !== "127.0.0.1") {
        server.close();
        reject(new Error("Refusing to stay up on a non-loopback address."));
        return;
      }
      currentPort = addr.port;
      logLine("listen", "", `127.0.0.1:${addr.port}`, "up");
      resolve(addr);
    });
  });
}

function resetForTests() {
  requests.clear();
  activeId = null;
}

if (require.main === module) {
  const server = createServer();
  listen(server).catch((err) => {
    console.error("companion failed to bind 127.0.0.1:", err.message);
    process.exit(1);
  });
}

module.exports = { createServer, listen, resetForTests, HOST };
