"use strict";

if (window.__LPC_YT__) {
  /* already injected */
} else {
window.__LPC_YT__ = true;

/**
 * YouTube Studio upload composer.
 * Follows shared/youtube-plan.js step ids. Fail closed if a required control is missing.
 * Default audience: “No, it’s not made for kids”. Never clicks Publish/Save/Done here.
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

const YT_CREATE = [
  "ytcp-button#create-icon",
  "#create-icon",
  "ytcp-button#create-button",
  'button[aria-label="Create"]',
];

const YT_NOT_FOR_KIDS = [
  'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
  "#made-for-kids-group tp-yt-paper-radio-button[name='VIDEO_MADE_FOR_KIDS_NOT_MFK']",
];

const YT_MADE_FOR_KIDS = [
  'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_MFK"]',
];

function ytStep(requestId, stepId, message) {
  lpcProgress(requestId, message);
  chrome.runtime.sendMessage({ type: "LPC_PLAN_STEP", id: requestId, planStep: stepId, message }).catch(() => {});
}

function ytTextMatch(node, texts) {
  const label = `${node.innerText || ""} ${node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return texts.some((t) => label.includes(String(t).trim().toLowerCase()));
}

function ytByText(tagNames, texts) {
  const exact = lpcByExactText(tagNames, texts);
  if (exact) return exact;
  const nodes = document.querySelectorAll(tagNames.join(","));
  for (const node of nodes) {
    if (!lpcVisible(node)) continue;
    if (ytTextMatch(node, texts)) return node;
  }
  return null;
}

function ytPublishControl() {
  const done = lpcFirst(YT_DONE);
  if (done) {
    const label = `${done.innerText || ""} ${done.getAttribute("aria-label") || ""}`.toLowerCase();
    if (/publish|post|save|done/.test(label)) return done;
  }
  return ytByText(
    ["ytcp-button", "button", "yt-button-shape", "yt-formatted-string"],
    ["Publish", "Save", "Done"]
  );
}

function ytLooksLikeStudioUpload() {
  return Boolean(lpcFileInput() || lpcFirst(YT_TITLE) || lpcFirst(YT_CREATE));
}

function ytInComposer() {
  return Boolean(lpcFileInput() || lpcFirst(YT_TITLE));
}

function ytVisibilityRadio(name) {
  const attr = String(name || "UNLISTED").toUpperCase();
  return (
    lpcFirst([`tp-yt-paper-radio-button[name="${attr}"]`]) ||
    ytByText(["tp-yt-paper-radio-button", "yt-formatted-string", "div"], [name])
  );
}

async function ytClickOrFail(el, label, stepId) {
  if (!el) {
    return lpcFail("ui_missing", `YouTube step ${stepId}: “${label}” was not found. Fail closed.`);
  }
  const ok = await lpcClick(el, `Click: ${label}`);
  if (!ok) {
    return lpcFail("ui_missing", `YouTube step ${stepId}: “${label}” was present but not clickable. Fail closed.`);
  }
  return true;
}

async function ytOpenUploadIfNeeded(request) {
  if (ytInComposer()) return true;
  ytStep(request.id, "click_create", "Opening YouTube Studio Create.");
  const create =
    lpcFirst(YT_CREATE) || ytByText(["ytcp-button", "button", "yt-icon-button", "yt-formatted-string"], ["Create"]);
  if (!create) {
    return lpcFail("ui_missing", "YouTube step click_create: Create was not found. Fail closed.");
  }
  const clicked = await ytClickOrFail(create, "Create", "click_create");
  if (clicked && clicked.ok === false) return clicked;
  await lpcSleep(500);
  ytStep(request.id, "click_upload_videos", "Opening Upload videos.");
  const uploadItem = ytByText(
    ["tp-yt-paper-item", "yt-formatted-string", "a", "ytcp-text-menu-item", "tp-yt-paper-item"],
    ["Upload videos", "Upload video"]
  );
  if (!uploadItem) {
    return lpcFail("ui_missing", "YouTube step click_upload_videos: Upload videos was not found. Fail closed.");
  }
  const up = await ytClickOrFail(uploadItem, "Upload videos", "click_upload_videos");
  if (up && up.ok === false) return up;
  const file = await lpcWait(() => lpcFileInput() || lpcFirst(YT_TITLE), 20000);
  if (!file) {
    return lpcFail("ui_missing", "YouTube step click_upload_videos: upload composer did not open. Fail closed.");
  }
  return true;
}

async function ytAttachMedia(request) {
  ytStep(request.id, "attach_file", "Attaching the local video file.");
  const input = await lpcWait(() => lpcFileInput(), 12000);
  if (!input) {
    if (lpcFirst(YT_TITLE) && !request.mediaPath) return true;
    return lpcFail("ui_missing", "YouTube step attach_file: file picker was not found. Fail closed.");
  }
  if (input.files && input.files.length > 0) return true;
  if (!request.mediaPath) {
    if (request.plan && request.plan.kind === "youtube_upload") {
      return lpcFail(
        "media_required",
        "YouTube step attach_file: mediaPath is required for upload. The agent did not set a file."
      );
    }
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
    return {
      ok: false,
      error: "file_chooser_user_pick",
      status: "waiting_file_picker",
      message: attached.message || "You pick the file in the highlighted picker. The agent did not set a file.",
    };
  }
  return lpcFail(
    (attached && attached.error) || "media_not_attached",
    (attached && attached.message) || "YouTube step attach_file: the agent did not set a file."
  );
}

async function ytFillDetails(request) {
  const titleEl = await lpcWait(() => lpcFirst(YT_TITLE), request.mediaPath ? 180000 : 25000);
  if (!titleEl) {
    return lpcFail("ui_missing", "YouTube step fill_title: title field was not found. Fail closed.");
  }
  const title = request.title || request.fillTitle || request.caption || "";
  if (title) {
    ytStep(request.id, "fill_title", "Filling the title.");
    await lpcSetText(titleEl, title.slice(0, 100), "Type: title");
  }
  const descText = request.description || request.fillDescription || request.caption || "";
  const desc = lpcFirst(YT_DESCRIPTION);
  if (descText) {
    ytStep(request.id, "fill_description", "Filling the description.");
    if (!desc) {
      return lpcFail("ui_missing", "YouTube step fill_description: description field was not found. Fail closed.");
    }
    await lpcSetText(desc, descText, "Type: description");
  }
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

async function ytSelectAudience(request) {
  const madeForKids = request.audience === "made_for_kids";
  const stepId = "audience_not_for_kids";
  ytStep(
    request.id,
    stepId,
    madeForKids
      ? "Selecting audience: made for kids."
      : "Selecting audience: No, it’s not made for kids (default)."
  );
  const radio = madeForKids
    ? lpcFirst(YT_MADE_FOR_KIDS) ||
      ytByText(["tp-yt-paper-radio-button", "yt-formatted-string"], ["Yes, it's made for kids", "made for kids"])
    : lpcFirst(YT_NOT_FOR_KIDS) ||
      ytByText(
        ["tp-yt-paper-radio-button", "yt-formatted-string"],
        ["No, it's not made for kids", "not made for kids"]
      );
  const label = madeForKids ? "Yes, it's made for kids" : "No, it's not made for kids";
  return ytClickOrFail(radio, label, stepId);
}

async function ytClickNext(request, stepId, optional) {
  if (ytPublishControl() || ytVisibilityRadio(request.visibility || "Unlisted")) {
    return true;
  }
  const next = lpcFirst(YT_NEXT) || ytByText(["ytcp-button", "button"], ["Next"]);
  if (!next) {
    if (optional) return true;
    return lpcFail("ui_missing", `YouTube step ${stepId}: Next was not found. Fail closed.`);
  }
  if (next.hasAttribute("disabled") || next.getAttribute("aria-disabled") === "true") {
    if (optional) return true;
    return lpcFail("ui_missing", `YouTube step ${stepId}: Next is disabled. Fail closed.`);
  }
  ytStep(request.id, stepId, "Advancing the official YouTube wizard (Next).");
  const ok = await lpcClick(next, "Click: Next");
  if (!ok) {
    if (optional) return true;
    return lpcFail("ui_missing", `YouTube step ${stepId}: Next was not clickable. Fail closed.`);
  }
  await lpcSleep(900);
  return true;
}

async function ytSelectVisibility(request) {
  const vis = String(request.visibility || "UNLISTED").toUpperCase();
  const label = vis === "PUBLIC" ? "Public" : vis === "PRIVATE" ? "Private" : "Unlisted";
  ytStep(request.id, "visibility", `Setting visibility to ${label}.`);
  for (let i = 0; i < 4 && !ytVisibilityRadio(label); i += 1) {
    const next = lpcFirst(YT_NEXT);
    if (next && !next.hasAttribute("disabled") && !ytPublishControl()) {
      await lpcClick(next, "Click: Next");
      await lpcSleep(900);
      continue;
    }
    await lpcSleep(400);
  }
  const radio = ytVisibilityRadio(label);
  return ytClickOrFail(radio, label, "visibility");
}

async function ytStop(request) {
  ytStep(request.id, "stop_publish", "Reached the final Publish/Save/Done control. Not clicking it.");
  const gateEl = await lpcWait(() => ytPublishControl(), 8000);
  const name = gateEl
    ? (gateEl.innerText || gateEl.getAttribute("aria-label") || "Publish").trim()
    : "Publish";
  if (request.noPublish) {
    return {
      ok: true,
      status: "ready_for_publish",
      completed: false,
      message:
        "YouTube upload is filled. Visibility and audience are set. Publish/Save/Done was not clicked (noPublish=true). Confirm is not requested.",
    };
  }
  if (!gateEl) {
    return lpcFail(
      "ui_missing",
      "YouTube step stop_publish: Publish/Save/Done was not found. Fail closed."
    );
  }
  if (window.LPCOverlay) {
    await window.LPCOverlay.highlight(gateEl, `Waiting: Confirm ${name}`);
  }
  return {
    ok: true,
    status: "waiting_confirm",
    gate: {
      kind: "publish",
      name,
      selector: "#done-button",
      url: location.href,
      preview: `About to click “${name}” on YouTube Studio. Confirm to publish or save, or Deny to abort.`,
    },
  };
}

async function handleYoutube(request) {
  if (lpcLooksLoggedOut(YT_LOGIN_HINTS) && !ytLooksLikeStudioUpload()) {
    return lpcFail(
      "not_logged_in_hint",
      "YouTube looks signed out in this Chrome profile. Sign in, then queue the request again."
    );
  }
  const opened = await ytOpenUploadIfNeeded(request);
  if (opened && opened.ok === false) return opened;
  const media = await ytAttachMedia(request);
  if (media && media.ok === false) return media;
  const details = await ytFillDetails(request);
  if (details && details.ok === false) return details;
  const uploadPlan = request.plan && request.plan.kind === "youtube_upload";
  if (!uploadPlan) {
    if (request.noPublish) {
      return { ok: true, completed: true, message: "Filled YouTube fields. Did not click Publish." };
    }
    return ytStop(request);
  }
  const audience = await ytSelectAudience(request);
  if (audience && audience.ok === false) return audience;
  const n1 = await ytClickNext(request, "next_after_details", false);
  if (n1 && n1.ok === false) return n1;
  const n2 = await ytClickNext(request, "next_video_elements", true);
  if (n2 && n2.ok === false) return n2;
  const n3 = await ytClickNext(request, "next_checks", true);
  if (n3 && n3.ok === false) return n3;
  const vis = await ytSelectVisibility(request);
  if (vis && vis.ok === false) return vis;
  return ytStop(request);
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
});
}
