/**
 * Shared schema for the loopback companion and MV3 agent.
 * Keep this file free of secrets, cookies, and tokens.
 */

const PLATFORMS = ["youtube", "instagram"];

const STATUSES = [
  "queued",
  "pending",
  "confirmed",
  "planning",
  "acting",
  "running",
  "waiting_confirm",
  "awaiting_gate",
  "waiting_user",
  "waiting_file_picker",
  "ready_for_publish",
  "completed",
  "published",
  "denied",
  "aborted",
  "expired",
  "failed",
];

const BUSY_STATUSES = ["queued", "pending", "confirmed", "planning", "acting", "running"];
const PARKED_STATUSES = [
  "waiting_confirm",
  "awaiting_gate",
  "waiting_user",
  "waiting_file_picker",
  "ready_for_publish",
];
const LIVE_STATUSES = [...BUSY_STATUSES, ...PARKED_STATUSES];

/** Live acts that still occupy Confirm/Deny. Busy acts 409 a second executor. */
const BLOCKING_STATUSES = LIVE_STATUSES;

function isBusyStatus(status) {
  return BUSY_STATUSES.includes(status);
}

function isParkedStatus(status) {
  return PARKED_STATUSES.includes(status);
}

function isLiveStatus(status) {
  return LIVE_STATUSES.includes(status);
}

function isConfirmStatus(status) {
  return status === "waiting_confirm" || status === "awaiting_gate" || status === "pending";
}

const TOOLS = [
  "snapshot",
  "screenshot",
  "navigate",
  "click",
  "type",
  "scroll",
  "tabs.list",
  "tabs.create",
  "tabs.update",
  "tabs.activate",
  "tabs.close",
  "windows.create",
  "windows.list",
  "attachFile",
  "wait.load",
];

const GATED_VERBS = ["publish", "post", "share", "send", "pay", "delete"];

const ERRORS = {
  already_pending: {
    code: "already_pending",
    http: 409,
    message:
      "An act is already pending, running, or waiting for Confirm. Deny it or wait for it to finish.",
  },
  invalid_request: {
    code: "invalid_request",
    http: 400,
    message: "Invalid JSON body.",
  },
  not_found: {
    code: "not_found",
    http: 404,
    message: "No act with that id.",
  },
  no_pending: {
    code: "no_pending",
    http: 404,
    message: "There is no Confirm/Deny waiting.",
  },
  denied: {
    code: "denied",
    http: 409,
    message: "The user denied this act. Gated actions did not run.",
  },
  aborted: {
    code: "aborted",
    http: 409,
    message: "The act was aborted before Confirm.",
  },
  expired: {
    code: "expired",
    http: 410,
    message: "The act expired without Confirm. Gated actions did not run.",
  },
  ui_missing: {
    code: "ui_missing",
    http: 422,
    message: "The target control was not found. Fail closed: no further clicks.",
  },
  not_logged_in_hint: {
    code: "not_logged_in_hint",
    http: 422,
    message: "The site looks signed out in this Chrome profile.",
  },
  media_required: {
    code: "media_required",
    http: 422,
    message: "The composer needs a file. Chrome cannot set file inputs from a disk path.",
  },
  media_not_attached: {
    code: "media_not_attached",
    http: 422,
    message: "No file was attached. Chrome cannot silently set a file input from mediaPath.",
  },
  needs_permission: {
    code: "needs_permission",
    http: 403,
    message: "Grant this site (or all sites) from the Loopback Agent side panel, then retry.",
  },
  file_unreadable: {
    code: "file_unreadable",
    http: 422,
    message: "That path is missing or unreadable on this machine. The agent did not set a file.",
  },
  file_chooser_user_pick: {
    code: "file_chooser_user_pick",
    http: 422,
    message:
      "The file chooser could not be intercepted or never opened. Pick the file in the highlighted picker. The agent did not set a file (Chromium #928255).",
  },
  debugger_attach_failed: {
    code: "debugger_attach_failed",
    http: 422,
    message:
      "Could not attach the debugger to this tab. Gated and file steps will not fall back to in-page click(). Retry attach or abort.",
  },
  gated: {
    code: "gated",
    http: 409,
    message: "That control is gated (Publish/Post/Send/Pay/Delete/Share). Confirm in the side panel.",
  },
  CROSS_ACT_TAB: {
    code: "CROSS_ACT_TAB",
    http: 409,
    message: "That tab belongs to another act. Tool calls must use this act's tabId.",
  },
  OVERLAY_INJECT_FAILED: {
    code: "OVERLAY_INJECT_FAILED",
    http: 422,
    message:
      "Overlay did not ack on this tab (LPC_OVERLAY_PING). No click or type ran. Reload the unpacked extension, Allow this site, and retry.",
    retryable: true,
  },
  HOST_NOT_ALLOWED: {
    code: "HOST_NOT_ALLOWED",
    http: 403,
    message: "Allow this site first — overlay not on this tab.",
    retryable: true,
  },
  EXTENSION_DISCONNECTED: {
    code: "EXTENSION_DISCONNECTED",
    http: 422,
    message:
      "Extension stopped talking to the companion. Reload Loopback and keep the side panel open. The act did not continue.",
    retryable: true,
  },
  WRONG_PROFILE: {
    code: "WRONG_PROFILE",
    http: 422,
    message:
      "Companion is up but this Chrome never polls. Load Loopback in this profile and keep the side panel open.",
    retryable: true,
  },
  CROSS_ACT_TAB: {
    code: "CROSS_ACT_TAB",
    http: 409,
    message: "That tab belongs to another act. Tool calls must use this act's tabId.",
  },
};

const DEFAULT_PORT = 18741;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function normalizeTags(tags) {
  if (tags == null || tags === "") return [];
  if (Array.isArray(tags)) {
    return tags.map((t) => String(t).trim()).filter(Boolean);
  }
  if (typeof tags === "string") {
    return tags
      .split(/[,#]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return null;
}

function isHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function parseIntent(intent) {
  const text = String(intent || "");
  const noPublish = /do not (click )?(publish|share|post|send)|don't (click )?(publish|share|post|send)|without publishing/i.test(
    text
  );
  let title = null;
  let description = null;
  const titleAndDesc = text.match(/title\s+(.+?)\s+and\s+description\s+(.+?)(?:\.|$)/i);
  if (titleAndDesc) {
    title = titleAndDesc[1].trim();
    description = titleAndDesc[2].trim();
  } else {
    const t = text.match(/\btitle\s+(.+?)(?:\s+and\s+|\.|$)/i);
    const d = text.match(/\bdescription\s+(.+?)(?:\.|$)/i);
    const c = text.match(/\bcaption\s+(.+?)(?:\.|$)/i);
    if (t) title = t[1].trim();
    if (d) description = d[1].trim();
    else if (c) description = c[1].trim();
  }
  if (title) title = title.replace(/^fill\s+/i, "").trim();
  return { noPublish, title, description };
}

function validatePostRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: { ...ERRORS.invalid_request, message: "Body must be JSON with platform youtube|instagram and a caption or title." } };
  }
  const platform = typeof body.platform === "string" ? body.platform.trim().toLowerCase() : "";
  if (!PLATFORMS.includes(platform)) {
    return { error: { ...ERRORS.invalid_request, message: "Body must be JSON with platform youtube|instagram and a caption or title." } };
  }
  const caption = body.caption == null ? "" : String(body.caption);
  const title = body.title == null ? "" : String(body.title);
  if (!caption.trim() && !title.trim()) {
    return { error: { ...ERRORS.invalid_request, message: "Body must be JSON with platform youtube|instagram and a caption or title." } };
  }
  const tags = normalizeTags(body.tags);
  if (tags == null) {
    return { error: ERRORS.invalid_request };
  }
  const mediaPath =
    body.mediaPath == null || body.mediaPath === "" ? null : String(body.mediaPath);

  return {
    value: {
      platform,
      caption,
      title: title || null,
      tags,
      mediaPath,
    },
  };
}

function normalizeVisibility(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim().toUpperCase();
  if (s === "PUBLIC" || s === "PRIVATE" || s === "UNLISTED") return s;
  return undefined;
}

function normalizeAudience(value) {
  if (value == null || value === "") return null;
  const s = String(value)
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\s+/g, "_");
  if (s === "made_for_kids" || s === "for_kids" || s === "yes" || s === "kids") return "made_for_kids";
  if (s === "not_for_kids" || s === "no" || s === "not_made_for_kids") return "not_for_kids";
  return undefined;
}

function inferPlatform(body, intent, startUrl) {
  if (typeof body.platform === "string" && body.platform.trim()) {
    const p = body.platform.trim().toLowerCase();
    if (!PLATFORMS.includes(p)) {
      return {
        error: {
          ...ERRORS.invalid_request,
          message: "platform must be youtube or instagram.",
        },
      };
    }
    return { value: p };
  }
  const blob = `${intent || ""} ${startUrl || ""}`;
  if (/instagram\.com|\binstagram\b/i.test(blob)) return { value: "instagram" };
  if (/youtube\.com|studio\.youtube|\byoutube\b/i.test(blob)) return { value: "youtube" };
  return { value: null };
}

function isYoutubeUpload(value) {
  if (!value) return false;
  if (value.platform !== "youtube") return false;
  if (value.mediaPath) return true;
  return /upload/i.test(String(value.intent || ""));
}

function validateAct(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: ERRORS.invalid_request };
  }
  const intent = typeof body.intent === "string" ? body.intent.trim() : "";
  if (!intent || intent.length > 8000) {
    return {
      error: {
        ...ERRORS.invalid_request,
        message: "Body must be JSON with a non-empty intent string.",
      },
    };
  }
  let startUrl = null;
  if (body.startUrl != null && body.startUrl !== "") {
    if (!isHttpUrl(body.startUrl)) {
      return {
        error: { ...ERRORS.invalid_request, message: "startUrl must be http:// or https://." },
      };
    }
    startUrl = String(body.startUrl).trim();
  }
  const inferred = inferPlatform(body, intent, startUrl);
  if (inferred.error) return inferred;
  const platform = inferred.value;

  const vis = normalizeVisibility(body.visibility);
  if (vis === undefined) {
    return {
      error: {
        ...ERRORS.invalid_request,
        message: "visibility must be UNLISTED, PUBLIC, or PRIVATE.",
      },
    };
  }
  const audience = normalizeAudience(body.audience);
  if (audience === undefined) {
    return {
      error: {
        ...ERRORS.invalid_request,
        message: "audience must be not_for_kids or made_for_kids.",
      },
    };
  }

  const tags = normalizeTags(body.tags);
  if (tags == null) {
    return { error: ERRORS.invalid_request };
  }

  const parsed = parseIntent(intent);
  const title =
    body.title == null || body.title === "" ? parsed.title : String(body.title);
  const descriptionRaw =
    body.description != null && body.description !== ""
      ? String(body.description)
      : body.caption != null && body.caption !== ""
        ? String(body.caption)
        : parsed.description;
  const caption =
    body.caption != null && body.caption !== ""
      ? String(body.caption)
      : descriptionRaw || "";
  const mediaPath =
    body.mediaPath == null || body.mediaPath === "" ? null : String(body.mediaPath);
  const noPublish = body.noPublish != null ? Boolean(body.noPublish) : Boolean(parsed.noPublish);

  const wantsUpload = platform === "youtube" && (Boolean(mediaPath) || /upload/i.test(intent));
  if (wantsUpload && !startUrl) {
    startUrl = "https://studio.youtube.com";
  }
  if (platform === "instagram" && !startUrl) {
    startUrl = "https://www.instagram.com/";
  }

  return {
    value: {
      intent,
      startUrl,
      confirmToStart: Boolean(body.confirmToStart),
      platform,
      mediaPath,
      title: title || null,
      description: descriptionRaw || null,
      caption,
      tags,
      visibility: vis || (wantsUpload ? "UNLISTED" : null),
      audience: audience || (wantsUpload ? "not_for_kids" : null),
      noPublish,
      fillTitle: title || null,
      fillDescription: descriptionRaw || null,
    },
  };
}

function validateTool(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: ERRORS.invalid_request };
  }
  const tool = typeof body.tool === "string" ? body.tool.trim() : "";
  if (!TOOLS.includes(tool)) {
    return {
      error: {
        ...ERRORS.invalid_request,
        message: `tool must be one of: ${TOOLS.join(", ")}.`,
      },
    };
  }
  const args = { ...body };
  delete args.tool;
  delete args.id;
  return { value: { tool, args } };
}

function publicRequest(req) {
  if (!req) return null;
  return {
    id: req.id,
    kind: req.kind,
    platform: req.platform || null,
    caption: req.caption || "",
    title: req.title || null,
    description: req.description || null,
    tags: req.tags || [],
    mediaPath: req.mediaPath || null,
    visibility: req.visibility || null,
    audience: req.audience || null,
    intent: req.intent || null,
    startUrl: req.startUrl || null,
    confirmToStart: Boolean(req.confirmToStart),
    noPublish: Boolean(req.noPublish),
    fillTitle: req.fillTitle || null,
    fillDescription: req.fillDescription || null,
    status: req.status,
    gate: req.gate || null,
    error: req.error || null,
    progress: req.progress || null,
    step: req.step || null,
    planKind: req.planKind || null,
    planStep: req.planStep || null,
    tabId: req.tabId || null,
    createdAt: req.createdAt,
    updatedAt: req.updatedAt,
    expiresAt: req.expiresAt,
  };
}

function publicAct(req) {
  if (!req) return null;
  const plan = req.plan
    ? {
        kind: req.plan.kind,
        noPublish: Boolean(req.plan.noPublish),
        visibility: req.plan.visibility || null,
        audience: req.plan.audience || null,
        audienceNote: req.plan.audienceNote || null,
        steps: Array.isArray(req.plan.steps) ? req.plan.steps.map((s) => s.id) : [],
      }
    : null;
  return {
    ...publicRequest(req),
    command: req.command
      ? {
          id: req.command.id,
          tool: req.command.tool,
          args: req.command.args,
          status: req.command.status,
        }
      : null,
    snapshot: req.snapshotMeta || null,
    axCount: req.axCount || 0,
    allowGatedOnce: Boolean(req.allowGatedOnce),
    newTab: Boolean(req.newTab),
    plan,
  };
}

function composerUrl(platform) {
  if (platform === "youtube") return "https://studio.youtube.com";
  if (platform === "instagram") return "https://www.instagram.com/";
  return null;
}

function postRequestToAct(parsed) {
  const title = parsed.title || "";
  const caption = parsed.caption || "";
  const intent = `Upload to ${parsed.platform}. Title ${title}. Description ${caption}.`;
  return {
    kind: "post-request",
    platform: parsed.platform,
    caption: parsed.caption,
    title: parsed.title,
    description: parsed.caption || null,
    tags: parsed.tags,
    mediaPath: parsed.mediaPath,
    visibility: parsed.platform === "youtube" ? "UNLISTED" : null,
    audience: parsed.platform === "youtube" ? "not_for_kids" : null,
    intent,
    startUrl: composerUrl(parsed.platform),
    confirmToStart: true,
    noPublish: false,
    fillTitle: parsed.title,
    fillDescription: parsed.caption,
  };
}

module.exports = {
  PLATFORMS,
  STATUSES,
  BLOCKING_STATUSES,
  BUSY_STATUSES,
  PARKED_STATUSES,
  LIVE_STATUSES,
  TOOLS,
  GATED_VERBS,
  ERRORS,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_TTL_MS,
  parseIntent,
  normalizeTags,
  normalizeVisibility,
  normalizeAudience,
  inferPlatform,
  isYoutubeUpload,
  isBusyStatus,
  isParkedStatus,
  isLiveStatus,
  isConfirmStatus,
  validatePostRequest,
  validateAct,
  validateTool,
  publicRequest,
  publicAct,
  composerUrl,
  postRequestToAct,
};
