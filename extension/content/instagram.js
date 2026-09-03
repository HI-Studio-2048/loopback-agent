"use strict";

if (window.__LPC_IG__) {
  /* already injected */
} else {
window.__LPC_IG__ = true;

/**
 * Instagram feed create-post flow on instagram.com.
 * Stories/Reels: fail closed if Share/Post is not found.
 */

const IG_LOGIN_HINTS = [
  'input[name="username"]',
  'input[name="password"]',
  'a[href*="/accounts/login"]',
];

const IG_CAPTION = [
  'div[aria-label="Write a caption…"]',
  'div[aria-label="Write a caption..."]',
  'textarea[aria-label="Write a caption…"]',
  'textarea[aria-label="Write a caption..."]',
  'div[role="textbox"][contenteditable="true"]',
];

function igCreateControl() {
  return (
    lpcFirst([
      'svg[aria-label="New post"]',
      'svg[aria-label="Create"]',
      'a[href="/create/select/"]',
    ]) || lpcByExactText(["span", "a", "div"], ["Create", "New post"])
  );
}

function igDialog() {
  return document.querySelector('div[role="dialog"]');
}

function igShareControl() {
  const root = igDialog() || document;
  return lpcByExactText(["div", "button", "span"], ["Share", "Post"], root);
}

function igNextControl() {
  const root = igDialog() || document;
  return lpcByExactText(["div", "button", "span"], ["Next"], root);
}

function igLooksLoggedIn() {
  return Boolean(igCreateControl() || document.querySelector('svg[aria-label="Home"]'));
}

async function igOpenCreate(requestId) {
  if (lpcFileInput() || lpcFirst(IG_CAPTION)) return true;
  const create = igCreateControl();
  if (!create) return false;
  lpcProgress(requestId, "Opening Instagram Create.");
  const clickable = create.closest("a, button, div[role='button']") || create;
  await lpcClick(clickable, "Click: Create");
  const file = await lpcWait(() => lpcFileInput(), 12000);
  return Boolean(file);
}

async function igAttachMedia(request) {
  const input = await lpcWait(() => lpcFileInput(igDialog() || document), 8000);
  if (!input) {
    return lpcFail("ui_missing", "Instagram file picker was not found. Fail closed.");
  }
  if (input.files && input.files.length > 0) return true;
  if (!request.mediaPath) {
    return lpcFail(
      "media_required",
      "Instagram feed posts need a photo or video. Queue attachFile with a local path. You pick only if that returns file_chooser_user_pick."
    );
  }
  const attached = await chrome.runtime.sendMessage({
    type: "LPC_REQUEST_ATTACH_FILE",
    path: request.mediaPath,
  });
  if (attached && attached.ok) return true;
  if (attached && attached.error === "file_chooser_user_pick") {
    if (window.LPCOverlay) await window.LPCOverlay.youPick(input, "You pick the file");
    return lpcFail(
      "file_chooser_user_pick",
      attached.message || "You pick the file in the highlighted picker. The agent did not set a file."
    );
  }
  return lpcFail(
    (attached && attached.error) || "media_not_attached",
    (attached && attached.message) || "The agent did not set a file."
  );
}

async function igAdvanceToCaption(requestId) {
  for (let i = 0; i < 4; i += 1) {
    if (lpcFirst(IG_CAPTION) || igShareControl()) return true;
    const next = igNextControl();
    if (!next) break;
    lpcProgress(requestId, "Found Instagram Next. Advancing the official create flow once.");
    const clickable = next.closest("div[role='button'], button") || next;
    await lpcClick(clickable, "Click: Next");
    await lpcSleep(700);
  }
  const caption = await lpcWait(() => lpcFirst(IG_CAPTION) || igShareControl(), 10000);
  return Boolean(caption);
}

async function handleInstagram(request) {
  if (lpcLooksLoggedOut(IG_LOGIN_HINTS) && !igLooksLoggedIn()) {
    return lpcFail(
      "not_logged_in_hint",
      "Instagram looks signed out in this Chrome profile. Sign in, then queue the request again."
    );
  }
  if (!(await igOpenCreate(request.id))) {
    return lpcFail(
      "ui_missing",
      "Could not open the official Instagram create flow. Stories/Reels may not be supported. Fail closed."
    );
  }
  const media = await igAttachMedia(request);
  if (media && media.ok === false) return media;
  if (!(await igAdvanceToCaption(request.id))) {
    return lpcFail(
      "ui_missing",
      "Instagram caption or Share control was not found (Stories/Reels fail closed)."
    );
  }
  const caption = lpcFirst(IG_CAPTION);
  if (caption && request.caption) await lpcSetText(caption, request.caption, "Type: caption");
  if (request.noPublish) {
    return { ok: true, completed: true, message: "Filled Instagram caption. Did not click Share." };
  }
  const share = await lpcWait(() => igShareControl(), 8000);
  if (!share) {
    return lpcFail(
      "ui_missing",
      "Instagram Share/Post control was not found. Fail closed."
    );
  }
  const name = (share.innerText || "Share").trim();
  lpcProgress(request.id, "Found Share/Post. Waiting for Confirm — not clicking yet.");
  if (window.LPCOverlay) await window.LPCOverlay.highlight(share, "Waiting: Confirm Share");
  return {
    ok: true,
    gate: {
      kind: "share",
      name,
      selector: null,
      url: location.href,
      preview: `About to click “${name}” on Instagram. Confirm to post, or Deny to abort.`,
    },
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;
  if (message.type === "LPC_FILL" && message.request && message.request.platform === "instagram") {
    handleInstagram(message.request)
      .then(sendResponse)
      .catch((err) => {
        sendResponse(
          lpcFail("ui_missing", err && err.message ? err.message : "Instagram composer failed.")
        );
      });
    return true;
  }
  if (message.type === "LPC_CLICK_GATED" && message.platform === "instagram") {
    (async () => {
      const share = igShareControl();
      if (!share) {
        sendResponse(lpcFail("ui_missing", "Instagram Share/Post was not found. Fail closed."));
        return;
      }
      const clickable = share.closest("div[role='button'], button") || share;
      const ok = await lpcClick(clickable, "Click: Share");
      sendResponse(
        ok ? lpcOk() : lpcFail("ui_missing", "Share/Post was present but not clickable. Fail closed.")
      );
    })();
    return true;
  }
});
}
