/**
 * Shared schema for the loopback companion and MV3 agent.
 * Keep this file free of secrets, cookies, and tokens.
 */

const PLATFORMS = ["youtube", "instagram"];

const STATUSES = [
  "pending",
  "confirmed",
  "running",
  "awaiting_gate",
  "completed",
  "published",
  "denied",
  "aborted",
  "expired",
  "failed",
];

/** Statuses that block a second POST /v1/act or /v1/post-request. */
const BLOCKING_STATUSES = ["pending", "confirmed", "running", "awaiting_gate"];

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
  const parsed = parseIntent(intent);
  return {
    value: {
      intent,
      startUrl,
      confirmToStart: Boolean(body.confirmToStart),
      noPublish: parsed.noPublish,
      fillTitle: parsed.title,
      fillDescription: parsed.description,
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
    tags: req.tags || [],
    mediaPath: req.mediaPath || null,
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
    createdAt: req.createdAt,
    updatedAt: req.updatedAt,
    expiresAt: req.expiresAt,
  };
}

function publicAct(req) {
  if (!req) return null;
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
  };
}

function composerUrl(platform) {
  if (platform === "youtube") return "https://www.youtube.com/upload";
  if (platform === "instagram") return "https://www.instagram.com/";
  return null;
}

function postRequestToAct(parsed) {
  const title = parsed.title || "";
  const caption = parsed.caption || "";
  const intent = `Post to ${parsed.platform}. Title ${title}. Description ${caption}.`;
  return {
    kind: "post-request",
    platform: parsed.platform,
    caption: parsed.caption,
    title: parsed.title,
    tags: parsed.tags,
    mediaPath: parsed.mediaPath,
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
  TOOLS,
  GATED_VERBS,
  ERRORS,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_TTL_MS,
  parseIntent,
  validatePostRequest,
  validateAct,
  validateTool,
  publicRequest,
  publicAct,
  postRequestToAct,
};
