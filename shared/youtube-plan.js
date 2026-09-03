/**
 * Deterministic YouTube Studio upload plan.
 * Default audience is “No, it’s not made for kids” unless `audience` is set.
 * Default visibility is UNLISTED unless `visibility` is set.
 * noPublish=true never requests Confirm and never clicks Publish/Save/Done.
 */

const STUDIO_URL = "https://studio.youtube.com";
const DEFAULT_VISIBILITY = "UNLISTED";
const DEFAULT_AUDIENCE = "not_for_kids";
const AUDIENCE_NOT_FOR_KIDS = "No, it's not made for kids";
const AUDIENCE_MADE_FOR_KIDS = "Yes, it's made for kids";

function visibilityLabel(visibility) {
  if (visibility === "PUBLIC") return "Public";
  if (visibility === "PRIVATE") return "Private";
  return "Unlisted";
}

function audienceLabel(audience) {
  return audience === "made_for_kids" ? AUDIENCE_MADE_FOR_KIDS : AUDIENCE_NOT_FOR_KIDS;
}

function buildYoutubeUploadPlan(act) {
  const visibility = act.visibility || DEFAULT_VISIBILITY;
  const audience = act.audience || DEFAULT_AUDIENCE;
  const noPublish = Boolean(act.noPublish);
  const visName = visibilityLabel(visibility);
  const audName = audienceLabel(audience);
  return {
    kind: "youtube_upload",
    studioUrl: STUDIO_URL,
    visibility,
    audience,
    audienceDefault: DEFAULT_AUDIENCE,
    audienceNote:
      "Default audience is “No, it’s not made for kids” unless an explicit audience is provided.",
    visibilityDefault: DEFAULT_VISIBILITY,
    noPublish,
    steps: [
      { id: "open_studio", where: "sw", action: "navigate", url: STUDIO_URL, dedicatedTab: true },
      { id: "wait_load", where: "sw", action: "wait.load" },
      { id: "overlay_ping", where: "sw", action: "overlay.ping" },
      { id: "click_create", where: "page", action: "click", name: "Create" },
      { id: "click_upload_videos", where: "page", action: "click", name: "Upload videos" },
      { id: "attach_file", where: "page", action: "attachFile", required: true },
      { id: "fill_title", where: "page", action: "type", field: "title" },
      { id: "fill_description", where: "page", action: "type", field: "description" },
      { id: "audience_not_for_kids", where: "page", action: "click", name: audName, field: "audience" },
      { id: "next_after_details", where: "page", action: "click", name: "Next" },
      { id: "next_video_elements", where: "page", action: "click", name: "Next", optionalIfMissing: true },
      { id: "next_checks", where: "page", action: "click", name: "Next", optionalIfMissing: true },
      { id: "visibility", where: "page", action: "click", name: visName, field: "visibility" },
      {
        id: "stop_publish",
        where: "page",
        action: noPublish ? "ready_for_publish" : "waiting_confirm",
        gateNames: ["Publish", "Save", "Done"],
      },
    ],
  };
}

function planStepIds(plan) {
  return (plan && Array.isArray(plan.steps) ? plan.steps : []).map((s) => s.id);
}

module.exports = {
  STUDIO_URL,
  DEFAULT_VISIBILITY,
  DEFAULT_AUDIENCE,
  AUDIENCE_NOT_FOR_KIDS,
  AUDIENCE_MADE_FOR_KIDS,
  buildYoutubeUploadPlan,
  planStepIds,
  visibilityLabel,
  audienceLabel,
};
