import assert from "node:assert/strict";
import test from "node:test";
import {
  bindYouTubeUploadAuthorization,
  promptExplicitlyRequestsYouTubeUpload,
} from "../src/authorization.js";

test("recognizes only a host-bound YouTube upload capability", () => {
  const bound = bindYouTubeUploadAuthorization("Make a cat video.", true);
  assert.equal(promptExplicitlyRequestsYouTubeUpload(bound), true);
  assert.equal(promptExplicitlyRequestsYouTubeUpload(
    bindYouTubeUploadAuthorization("Make a cat video.", false),
  ), false);
  assert.throws(
    () => bindYouTubeUploadAuthorization(bound, false),
    /reserved host authorization marker/,
  );
});

test("free-form story text can never authorize an external upload", () => {
  assert.equal(promptExplicitlyRequestsYouTubeUpload("Make the clip and upload it to YouTube."), false);
  assert.equal(promptExplicitlyRequestsYouTubeUpload("YouTube: publish the final video"), false);
  assert.equal(promptExplicitlyRequestsYouTubeUpload("Make this fit YouTube Shorts."), false);
  assert.equal(promptExplicitlyRequestsYouTubeUpload("Do not upload this to YouTube."), false);
  assert.equal(promptExplicitlyRequestsYouTubeUpload("Create it without posting to YouTube."), false);
  assert.equal(promptExplicitlyRequestsYouTubeUpload("Make a tutorial explaining how to upload the video to YouTube."), false);
  assert.equal(promptExplicitlyRequestsYouTubeUpload("Write a script whose narrator says: upload the video to YouTube."), false);
  assert.equal(promptExplicitlyRequestsYouTubeUpload("Create a short about a YouTube upload video."), false);
});
