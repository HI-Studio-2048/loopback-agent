"use strict";

if (window.__LPC_YT__) {
  /* already injected */
} else {
window.__LPC_YT__ = true;

/**
 * YouTube Studio / youtube.com/upload composer.
 * Known selectors only. If Publish is missing, stop.
 */

const YT_LOGIN_HINTS = [
  'a[href*="ServiceLogin"]',
  'input[name="identifier"]',
  'form[action*="ServiceLogin"]',
];

const YT_TITLE = [
  "ytcp-social-suggestions-textbox#title-textarea #textbox",
  "#title-textarea #textbox",
  "#title-textarea textarea",
];

const YT_DESCRIPTION = [
  "ytcp-social-suggestions-textbox#description-textarea #textbox",
  "#description-textarea #textbox",
  "#description-textarea textarea",
];

const YT_SHOW_MORE = ["ytcp-button#toggle-button", "#toggle-button"];

const YT_TAGS = [
  "ytcp-form-input-container#tags-container #text-input",
  "#tags-container input#text-input",
  "ytcp-chip-bar #text-input",
];

const YT_NEXT = ["ytcp-button#next-button", "#next-button"];

const YT_DONE = ["ytcp-button#done-button", "#done-button"];

const YT_CREATE = ["ytcp-button#create-icon", "#create-icon"];

function ytPublishControl() {
  const done = lpcFirst(YT_DONE);
  if (!done) return null;
  const label = `${done.innerText || ""} ${done.getAttribute("aria-label") || ""}`.toLowerCase();
  if (label.includes("publish") || label.includes("post")) return done;
  return null;
}

function ytLooksLikeStudioUpload() {
  return Boolean(lpcFileInput() || lpcFirst(YT_TITLE) || lpcFirst(YT_CREATE));
}

async function ytOpenUploadIfNeeded(requestId) {
  if (lpcFileInput() || lpcFirst(YT_TITLE)) return true;
  const create = lpcFirst(YT_CREATE);
  if (create) {
    lpcProgress(requestId, "Opening YouTube Studio Create.");
    await lpcClick(create, "Click: Create");
    await lpcSleep(400);
    const uploadItem = lpcByExactText(
      ["tp-yt-paper-item", "yt-formatted-string", "a", "ytcp-text-menu-item"],
      ["Upload videos", "Upload video"]
    );
    if (uploadItem) {
      await lpcClick(uploadItem, "Click: Upload videos");
    } else {
      return false;
    }
  }
  const file = await lpcWait(() => lpcFileInput() || lpcFirst(YT_TITLE), 15000);
  return Boolean(file);
}

async function ytAttachMedia(request) {
  const input = await lpcWait(() => lpcFileInput(), 8000);
  if (!input) {
    if (lpcFirst(YT_TITLE)) return true;
    return lpcFail("ui_missing", "YouTube file picker was not found. Fail closed.");
  }
  if (input.files && input.files.length > 0) return true;
  if (!request.mediaPath) {
    if (lpcFirst(YT_TITLE)) return true;
    if (request.noPublish) {
      lpcProgress(request.id, "No video file; filling text only. Publish will not be clicked.");
      return true;
    }
    return lpcFail(
      "media_required",
      "YouTube needs a video file. Queue attachFile with a local path. You pick only if that returns file_chooser_user_pick."
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

async function ytFillDetails(request) {
  const titleEl = await lpcWait(() => lpcFirst(YT_TITLE), request.mediaPath ? 120000 : 25000);
  if (!titleEl) {
    return lpcFail("ui_missing", "YouTube title field was not found. Fail closed.");
  }
  const title = request.title || request.caption || "";
  if (title) await lpcSetText(titleEl, title.slice(0, 100), "Type: title");
  const desc = lpcFirst(YT_DESCRIPTION);
  if (desc && request.caption) await lpcSetText(desc, request.caption, "Type: description");
  if (request.tags && request.tags.length) {
    const more = lpcFirst(YT_SHOW_MORE);
    if (more) {
      const moreLabel = `${more.innerText || ""} ${more.getAttribute("aria-label") || ""}`.toLowerCase();
      if (moreLabel.includes("more") || moreLabel.includes("show")) await lpcClick(more, "Click: Show more");
      await lpcSleep(300);
    }
    const tags = lpcFirst(YT_TAGS);
    if (tags) await lpcSetText(tags, request.tags.join(", "), "Type: tags");
  }
  return true;
}

async function ytAdvanceToPublish(requestId) {
  for (let i = 0; i < 5; i += 1) {
    const publish = ytPublishControl();
    if (publish) {
      const name = (publish.innerText || publish.getAttribute("aria-label") || "Publish").trim();
      lpcProgress(requestId, "Found Publish. Waiting for Confirm — not clicking yet.");
      if (window.LPCOverlay) {
        await window.LPCOverlay.highlight(publish, "Waiting: Confirm Publish");
      }
      return {
        ok: true,
        gate: {
          kind: "publish",
          name,
          selector: "#done-button",
          url: location.href,
          preview: `About to click “${name}” on YouTube Studio. Confirm to publish, or Deny to abort.`,
        },
      };
    }
    const next = lpcFirst(YT_NEXT);
    if (next && !next.hasAttribute("disabled")) {
      lpcProgress(requestId, "Found YouTube Next. Advancing the official wizard once.");
      await lpcClick(next, "Click: Next");
      await lpcSleep(800);
      continue;
    }
    await lpcSleep(500);
  }
  if (lpcFirst(YT_DONE)) {
    return lpcFail(
      "ui_missing",
      "The done control is not labeled Publish/Post. Visibility may not be Public. Fail closed."
    );
  }
  return lpcFail("ui_missing", "YouTube Publish control was not found. Fail closed.");
}

async function handleYoutube(request) {
  if (lpcLooksLoggedOut(YT_LOGIN_HINTS) && !ytLooksLikeStudioUpload()) {
    return lpcFail(
      "not_logged_in_hint",
      "YouTube looks signed out in this Chrome profile. Sign in, then queue the request again."
    );
  }
  if (!(await ytOpenUploadIfNeeded(request.id))) {
    return lpcFail(
      "ui_missing",
      "Could not open the official YouTube upload composer. Fail closed."
    );
  }
  const media = await ytAttachMedia(request);
  if (media && media.ok === false) return media;
  const details = await ytFillDetails(request);
  if (details && details.ok === false) return details;
  if (request.noPublish) {
    return { ok: true, completed: true, message: "Filled YouTube fields. Did not click Publish." };
  }
  return ytAdvanceToPublish(request.id);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;
  if (message.type === "LPC_FILL" && message.request && message.request.platform === "youtube") {
    handleYoutube(message.request)
      .then(sendResponse)
      .catch((err) => {
        sendResponse(lpcFail("ui_missing", err && err.message ? err.message : "YouTube composer failed."));
      });
    return true;
  }
  if (message.type === "LPC_CLICK_GATED" && message.platform === "youtube") {
    (async () => {
      const publish = ytPublishControl();
      if (!publish) {
        sendResponse(lpcFail("ui_missing", "YouTube Publish control was not found. Fail closed."));
        return;
      }
      const ok = await lpcClick(publish, "Click: Publish");
      sendResponse(
        ok ? lpcOk() : lpcFail("ui_missing", "Publish was present but not clickable. Fail closed.")
      );
    })();
    return true;
  }
});
}
