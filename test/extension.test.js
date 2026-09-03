"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "extension");

test("unpacked extension is valid MV3 (manifest.json, not manifest.js)", () => {
  assert.equal(fs.existsSync(path.join(root, "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(root, "manifest.js")), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.equal(manifest.background.service_worker, "background.js");
});

test("default host permissions are loopback only; <all_urls> is optional", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1:18741/*"]);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
  assert.ok((manifest.optional_host_permissions || []).includes("<all_urls>"));
  const perms = manifest.permissions || [];
  for (const blocked of ["cookies", "history", "tabs", "webRequest"]) {
    assert.equal(perms.includes(blocked), false, blocked);
  }
  assert.ok(perms.includes("sidePanel"));
  assert.ok(perms.includes("activeTab"));
  assert.ok(perms.includes("scripting"));
  assert.ok(perms.includes("debugger"));
  assert.ok((manifest.optional_permissions || []).includes("tabs"));
});

test("all unpacked files referenced by the manifest exist", () => {
  const files = [
    "background.js",
    "cdp.js",
    "sidepanel.html",
    "sidepanel.js",
    "sidepanel.css",
    "config.js",
    "content/overlay.js",
    "content/dom.js",
    "content/agent.js",
    "content/youtube.js",
    "content/instagram.js",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
  ];
  for (const rel of files) {
    assert.equal(fs.existsSync(path.join(root, rel)), true, rel);
  }
});

test("overlay script is a visible clicker (not stealth)", () => {
  const src = fs.readFileSync(path.join(root, "content/overlay.js"), "utf8");
  assert.match(src, /pointer-events:\s*none/);
  const move = src.match(/MOVE_MS\s*=\s*(\d+)/);
  assert.ok(move);
  const ms = Number(move[1]);
  assert.ok(ms >= 180 && ms <= 280, `MOVE_MS ${ms} should be 180–280`);
  assert.match(src, /easeOutCubic/);
  assert.match(src, /playClick/);
  assert.match(src, /playType/);
  assert.match(src, /ripple/);
  assert.match(src, /Loopback Agent/);
  assert.match(src, /bottom:\s*12px/);
  assert.match(src, /Confirm pending/);
  assert.match(src, /You pick/);
  assert.match(src, /file_chooser_user_pick/);
  assert.match(src, /LPC_OVERLAY_TYPE_DONE/);
  assert.match(src, /DWELL_MS/);
  assert.doesNotMatch(src, /left:\s*50%/);
});

test("side panel Confirm names the action and origin; Allow this site can revoke", () => {
  const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
  assert.match(html, /Allow this site/);
  assert.match(html, /Revoke this site/);
  assert.match(html, /id="overlay-toggle" checked/);
  assert.match(html, /Waiting does not confirm/);
  assert.match(html, /file_chooser_user_pick/);
  assert.match(js, /Confirm \$\{action/);
  assert.match(js, /LPC_REVOKE_SITE/);
  assert.match(js, /Waiting does not confirm/);
  assert.match(js, /failed to render/);
  assert.match(js, /still need Confirm/);
});

test("you-pick overlay is only for file_chooser_user_pick; youtube fill does not pre-prompt pick", () => {
  const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.match(bg, /overlayYouPick/);
  assert.match(bg, /reason: "file_chooser_user_pick"/);
  assert.match(bg, /LPC_OVERLAY_TYPE_DONE/);
  assert.match(bg, /LPC_REVOKE_SITE/);
  const yt = fs.readFileSync(path.join(root, "content/youtube.js"), "utf8");
  const ig = fs.readFileSync(path.join(root, "content/instagram.js"), "utf8");
  assert.doesNotMatch(yt, /File picker — pick this file/);
  assert.doesNotMatch(ig, /File picker — pick this file/);
  assert.match(yt, /file_chooser_user_pick/);
  assert.match(ig, /file_chooser_user_pick/);
});

test("background loads CDP helper; debugger is not a silent all_urls grant", () => {
  const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.match(bg, /importScripts\("cdp\.js"\)/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("debugger"));
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
});

test("overlay ping is required before CDP click/type; Grok badge is tab-scoped", () => {
  const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.match(bg, /LPC_OVERLAY_PING/);
  assert.match(bg, /ensureOverlayAcked/);
  assert.match(bg, /injectImmediately:\s*true/);
  assert.match(bg, /content\/overlay\.js/);
  assert.match(bg, /setBadgeText\(\{ text: "Grok"/);
  assert.match(bg, /openDedicatedActTab/);
  assert.doesNotMatch(bg, /Ready\. Use POST \/v1\/tool/);
  assert.match(bg, /ready_for_publish/);
  assert.match(bg, /HOST_NOT_ALLOWED/);
  assert.match(bg, /CROSS_ACT_TAB/);
});

test("youtube upload plan runs audience + visibility and noPublish ready_for_publish", () => {
  const yt = fs.readFileSync(path.join(root, "content/youtube.js"), "utf8");
  assert.match(yt, /audience_not_for_kids/);
  assert.match(yt, /not made for kids/);
  assert.match(yt, /ready_for_publish/);
  assert.match(yt, /UNLISTED/);
  assert.match(yt, /stop_publish/);
  assert.doesNotMatch(yt, /LPC_CLICK_GATED/);
});

test("in-page Grok chip and dwell before click", () => {
  const src = fs.readFileSync(path.join(root, "content/overlay.js"), "utf8");
  assert.match(src, /tabchip/);
  assert.match(src, />Grok</);
  assert.match(src, /Grok · /);
  const dwell = src.match(/DWELL_MS\s*=\s*(\d+)/);
  assert.ok(dwell);
  assert.ok(Number(dwell[1]) >= 600);
});

test("file inputs intercept the chooser; gated/file steps do not fall back to in-page click", () => {
  const cdp = fs.readFileSync(path.join(root, "cdp.js"), "utf8");
  assert.match(cdp, /Page\.setInterceptFileChooserDialog/);
  assert.match(cdp, /fileChooserOpened/);
  assert.match(cdp, /file_chooser_user_pick/);
  assert.match(cdp, /Input\.dispatchKeyEvent/);
  assert.match(cdp, /Target\.attachedToTarget/);
  assert.match(cdp, /Accessibility\.getFullAXTree/);
  assert.match(cdp, /928255/);
  const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.match(bg, /cdpAttachFile/);
  assert.match(bg, /file_chooser_user_pick/);
  assert.match(bg, /requireCdp/);
  assert.match(bg, /cdpSwitchTab/);
  assert.doesNotMatch(bg, /LPC_CLICK_GATED/);
  assert.doesNotMatch(bg, /cdpSetFiles/);
});
