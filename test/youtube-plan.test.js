"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateAct, isYoutubeUpload, ERRORS, GATED_VERBS } = require("../shared/schema");
const { buildYoutubeUploadPlan, planStepIds, DEFAULT_AUDIENCE, DEFAULT_VISIBILITY } = require("../shared/youtube-plan");

describe("validateAct preserves structured upload fields", () => {
  it("keeps mediaPath, title, description, visibility, noPublish, platform", () => {
    const body = {
      platform: "youtube",
      intent: "Upload this video to YouTube Studio",
      mediaPath: "/absolute/path/video.mp4",
      title: "Studio upload test",
      description: "Loopback companion upload",
      visibility: "UNLISTED",
      noPublish: true,
      tags: ["loopback", "test"],
    };
    const { error, value } = validateAct(body);
    assert.equal(error, undefined);
    assert.equal(value.platform, "youtube");
    assert.equal(value.mediaPath, "/absolute/path/video.mp4");
    assert.equal(value.title, "Studio upload test");
    assert.equal(value.description, "Loopback companion upload");
    assert.equal(value.caption, "Loopback companion upload");
    assert.equal(value.visibility, "UNLISTED");
    assert.equal(value.noPublish, true);
    assert.equal(value.audience, "not_for_kids");
    assert.equal(value.startUrl, "https://studio.youtube.com");
    assert.deepEqual(value.tags, ["loopback", "test"]);
    assert.equal(isYoutubeUpload(value), true);
  });

  it("maps caption to description when description is omitted", () => {
    const { value } = validateAct({
      platform: "youtube",
      intent: "Upload a clip",
      mediaPath: "/tmp/a.mp4",
      title: "T",
      caption: "from caption",
      noPublish: true,
    });
    assert.equal(value.description, "from caption");
    assert.equal(value.caption, "from caption");
  });

  it("honors body.noPublish over intent text", () => {
    const { value } = validateAct({
      intent: "Upload this video to YouTube Studio and click everything",
      platform: "youtube",
      mediaPath: "/tmp/a.mp4",
      noPublish: true,
    });
    assert.equal(value.noPublish, true);
  });

  it("still hard-gates Publish/Send/Pay/Delete/Share", () => {
    assert.deepEqual(GATED_VERBS, ["publish", "post", "share", "send", "pay", "delete"]);
    assert.equal(ERRORS.gated.code, "gated");
  });
});

describe("YouTube upload plan", () => {
  it("is deterministic and stops before Publish when noPublish", () => {
    const act = validateAct({
      platform: "youtube",
      intent: "Upload this video to YouTube Studio",
      mediaPath: "/absolute/path/video.mp4",
      title: "T",
      description: "D",
      visibility: "UNLISTED",
      noPublish: true,
    }).value;
    const plan = buildYoutubeUploadPlan(act);
    assert.equal(plan.kind, "youtube_upload");
    assert.equal(plan.noPublish, true);
    assert.equal(plan.audience, DEFAULT_AUDIENCE);
    assert.equal(plan.visibility, DEFAULT_VISIBILITY);
    assert.match(plan.audienceNote, /not made for kids/i);
    const ids = planStepIds(plan);
    assert.deepEqual(ids, [
      "open_studio",
      "wait_load",
      "overlay_ping",
      "click_create",
      "click_upload_videos",
      "attach_file",
      "fill_title",
      "fill_description",
      "audience_not_for_kids",
      "next_after_details",
      "next_video_elements",
      "next_checks",
      "visibility",
      "stop_publish",
    ]);
    const stop = plan.steps.find((s) => s.id === "stop_publish");
    assert.equal(stop.action, "ready_for_publish");
    assert.deepEqual(stop.gateNames, ["Publish", "Save", "Done"]);
    assert.equal(plan.steps[0].url, "https://studio.youtube.com");
    assert.equal(plan.steps[0].dedicatedTab, true);
  });

  it("requests Confirm when noPublish is false", () => {
    const plan = buildYoutubeUploadPlan({
      visibility: "UNLISTED",
      audience: "not_for_kids",
      noPublish: false,
    });
    const stop = plan.steps.find((s) => s.id === "stop_publish");
    assert.equal(stop.action, "waiting_confirm");
  });
});
