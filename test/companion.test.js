"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createServer, listen, resetForTests } = require("../companion/server");

let server;
let base;

async function json(method, path, body) {
  const headers = {};
  const opts = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

describe("loopback companion", () => {
  before(async () => {
    server = createServer();
    const addr = await listen(server, 0, "127.0.0.1");
    assert.equal(addr.address, "127.0.0.1");
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    resetForTests();
    delete process.env.REQUEST_TTL_MS;
  });

  it("binds loopback and serves health", async () => {
    const { status, data } = await json("GET", "/health");
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.bind, "127.0.0.1");
  });

  it("schema still hard-gates Publish/Send/Pay/Delete/Share", () => {
    const { ERRORS, GATED_VERBS } = require("../shared/schema");
    assert.deepEqual(GATED_VERBS, ["publish", "post", "share", "send", "pay", "delete"]);
    assert.equal(ERRORS.file_chooser_user_pick.code, "file_chooser_user_pick");
    assert.equal(ERRORS.debugger_attach_failed.code, "debugger_attach_failed");
    assert.match(ERRORS.file_chooser_user_pick.message, /did not set a file/);
  });

  it("queues one post-request and does not publish", async () => {
    const { status, data } = await json("POST", "/v1/post-request", {
      platform: "youtube",
      caption: "Test from companion",
      title: "Companion test",
    });
    assert.equal(status, 201);
    assert.equal(data.status, "pending");
    assert.match(data.message, /Confirm/);
    const pending = await json("GET", "/v1/pending");
    assert.equal(pending.data.request.status, "pending");
    assert.equal(pending.data.request.title, "Companion test");
  });

  it("rejects a second pending request with 409", async () => {
    await json("POST", "/v1/post-request", {
      platform: "instagram",
      caption: "first",
    });
    const second = await json("POST", "/v1/post-request", {
      platform: "youtube",
      caption: "second",
      title: "nope",
    });
    assert.equal(second.status, 409);
    assert.equal(second.data.error, "already_pending");
  });

  it("denies without publishing", async () => {
    const created = await json("POST", "/v1/post-request", {
      platform: "youtube",
      title: "deny me",
    });
    const denied = await json("POST", "/v1/deny", { id: created.data.id });
    assert.equal(denied.status, 200);
    assert.equal(denied.data.request.status, "denied");
    const pending = await json("GET", "/v1/pending");
    assert.equal(pending.data.request, null);
  });

  it("confirm only marks confirmed; publish is the extension's job", async () => {
    const created = await json("POST", "/v1/post-request", {
      platform: "youtube",
      title: "confirm me",
    });
    const confirmed = await json("POST", "/v1/confirm", { id: created.data.id });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.request.status, "confirmed");
    assert.notEqual(confirmed.data.request.status, "published");
  });

  it("rejects invalid platform", async () => {
    const { status, data } = await json("POST", "/v1/post-request", {
      platform: "tiktok",
      caption: "no",
    });
    assert.equal(status, 400);
    assert.equal(data.error, "invalid_request");
  });

  it("expires a pending request without confirm", async () => {
    process.env.REQUEST_TTL_MS = "50";
    const created = await json("POST", "/v1/post-request", {
      platform: "instagram",
      caption: "expires",
    });
    await new Promise((r) => setTimeout(r, 60));
    const pending = await json("GET", "/v1/pending");
    assert.equal(pending.data.request, null);
    const st = await json("GET", `/v1/status/${created.data.id}`);
    assert.equal(st.data.request.status, "expired");
  });

  it("does not allow website CORS origins", async () => {
    const res = await fetch(`${base}/v1/pending`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("allows chrome-extension CORS origins", async () => {
    const res = await fetch(`${base}/v1/pending`, {
      headers: { Origin: "chrome-extension://abcdefghijklmnop" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnop");
  });

  it("answers OPTIONS preflight for Confirm from the extension", async () => {
    const res = await fetch(`${base}/v1/confirm`, {
      method: "OPTIONS",
      headers: {
        Origin: "chrome-extension://abcdefghijklmnop",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnop");
    assert.match(res.headers.get("access-control-allow-methods") || "", /POST/);
  });

  it("queues /v1/act without publishing and 409s a second act", async () => {
    const created = await json("POST", "/v1/act", {
      intent:
        "Open YouTube Studio and fill title Companion test and description Test from companion. Do not click Publish.",
      startUrl: "https://studio.youtube.com",
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.status, "queued");
    assert.notEqual(created.data.status, "published");
    assert.notEqual(created.data.status, "running");
    assert.equal(created.data.act.noPublish, true);
    assert.equal(created.data.act.fillTitle, "Companion test");
    const second = await json("POST", "/v1/act", { intent: "another" });
    assert.equal(second.status, 409);
    assert.equal(second.data.error, "already_pending");
    const blockedPost = await json("POST", "/v1/post-request", {
      platform: "youtube",
      title: "blocked",
    });
    assert.equal(blockedPost.status, 409);
  });

  it("gates a click via POST /v1/gate until Confirm", async () => {
    const created = await json("POST", "/v1/act", {
      intent: "Fill a form and wait",
      startUrl: "https://studio.youtube.com",
    });
    const gated = await json("POST", "/v1/gate", {
      id: created.data.id,
      kind: "publish",
      name: "Publish",
      preview: "About to click Publish. Confirm or Deny.",
    });
    assert.equal(gated.status, 200);
    assert.equal(gated.data.act.status, "waiting_confirm");
    const confirmed = await json("POST", "/v1/confirm", { id: created.data.id });
    assert.equal(confirmed.data.act.status, "acting");
    assert.equal(confirmed.data.act.allowGatedOnce, true);
    assert.notEqual(confirmed.data.act.status, "published");
  });

  it("ignores gated:false and still hard-gates Publish until Confirm", async () => {
    const created = await json("POST", "/v1/act", {
      intent: "Open YouTube Studio and click Publish",
      startUrl: "https://studio.youtube.com",
      gated: false,
    });
    assert.equal(created.status, 201);
    const gated = await json("POST", "/v1/gate", {
      id: created.data.id,
      kind: "publish",
      name: "Publish",
      preview: "About to click Publish.",
    });
    assert.equal(gated.status, 200);
    assert.equal(gated.data.act.status, "waiting_confirm");
    assert.notEqual(gated.data.act.status, "published");
  });

  it("prepare-file copies a local path into a world-readable temp file", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmp = path.join(os.tmpdir(), "loopback-post-test.txt");
    fs.writeFileSync(tmp, "x");
    const res = await json("POST", "/v1/prepare-file", { path: tmp });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.path);
    assert.notEqual(res.data.path, path.resolve(tmp));
    assert.ok(fs.existsSync(res.data.path));
    assert.equal(fs.readFileSync(res.data.path, "utf8"), "x");
    const mode = fs.statSync(res.data.path).mode & 0o777;
    assert.equal(mode, 0o644);
    fs.unlinkSync(res.data.path);
    fs.unlinkSync(tmp);
  });

  it("prepare-file fail-closes missing paths as file_unreadable", async () => {
    const res = await json("POST", "/v1/prepare-file", { path: "/tmp/loopback-post-missing-nope.txt" });
    assert.equal(res.status, 422);
    assert.equal(res.data.error, "file_unreadable");
  });

  it("POST /v1/act preserves mediaPath/title/description/visibility/noPublish on the public act", async () => {
    const created = await json("POST", "/v1/act", {
      platform: "youtube",
      intent: "Upload this video to YouTube Studio",
      mediaPath: "/absolute/path/video.mp4",
      title: "Studio upload test",
      description: "Loopback companion upload",
      visibility: "UNLISTED",
      noPublish: true,
    });
    assert.equal(created.status, 201);
    const act = created.data.act;
    assert.equal(act.mediaPath, "/absolute/path/video.mp4");
    assert.equal(act.title, "Studio upload test");
    assert.equal(act.description, "Loopback companion upload");
    assert.equal(act.visibility, "UNLISTED");
    assert.equal(act.noPublish, true);
    assert.equal(act.platform, "youtube");
    assert.equal(act.startUrl, "https://studio.youtube.com");
    assert.equal(act.planKind, "youtube_upload");
    assert.ok(act.plan);
    assert.equal(act.plan.steps[0], "open_studio");
    assert.equal(act.plan.steps[act.plan.steps.length - 1], "stop_publish");
    assert.equal(act.status, "queued");
    assert.notEqual(act.status, "running");
  });

  it("noPublish upload parks at ready_for_publish and does not publish", async () => {
    const created = await json("POST", "/v1/act", {
      platform: "youtube",
      intent: "Upload this video to YouTube Studio",
      mediaPath: "/tmp/video.mp4",
      title: "T",
      description: "D",
      visibility: "UNLISTED",
      noPublish: true,
    });
    const parked = await json("POST", "/v1/result", {
      id: created.data.id,
      status: "ready_for_publish",
      message: "YouTube upload is filled. Publish/Save was not clicked (noPublish=true).",
    });
    assert.equal(parked.status, 200);
    assert.equal(parked.data.act.status, "ready_for_publish");
    assert.notEqual(parked.data.act.status, "published");
    assert.match(parked.data.act.progress, /not clicked/);
  });

  it("allows a parallel general new-tab act while upload is waiting_user and rejects tab hijack", async () => {
    const upload = await json("POST", "/v1/act", {
      platform: "youtube",
      intent: "Upload this video to YouTube Studio",
      mediaPath: "/tmp/video.mp4",
      title: "T",
      noPublish: true,
    });
    assert.equal(upload.status, 201);
    const park = await json("POST", "/v1/progress", {
      id: upload.data.id,
      tabId: 77,
      status: "waiting_user",
      message: "Waiting on the upload tab.",
    });
    assert.equal(park.data.act.tabId, 77);
    assert.equal(park.data.act.status, "waiting_user");

    const general = await json("POST", "/v1/act", {
      intent: "Snapshot a docs tab. Do not click Publish.",
    });
    assert.equal(general.status, 201, JSON.stringify(general.data));
    assert.equal(general.data.act.newTab, true);
    assert.notEqual(general.data.act.id, upload.data.id);

    const hijack = await json("POST", "/v1/tool", {
      id: general.data.id,
      tool: "snapshot",
      tabId: 77,
    });
    assert.equal(hijack.status, 409);
    assert.equal(hijack.data.error, "CROSS_ACT_TAB");

    const own = await json("POST", "/v1/tool", {
      id: general.data.id,
      tool: "snapshot",
    });
    assert.equal(own.status, 202);
  });
});
