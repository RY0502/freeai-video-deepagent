import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { bindYouTubeUploadAuthorization } from "../src/authorization.js";
import {
  finalVideoArtifactPaths,
  finalVideoFileName,
  finalVideoPartialFileName,
  finalVideoStem,
  isLegacyFinalVideoFileName,
  isPromptFinalVideoFileName,
  isPromptFinalVideoPartialFileName,
} from "../src/final-video.js";

test("final video names are meaningful, deterministic, and attempt-specific", () => {
  const prompt = "Create a video of Two dinosaurs fighting in a jungle!";
  assert.equal(finalVideoStem(prompt), "two-dinosaurs-fighting-in-a-jungle");
  assert.equal(finalVideoFileName(prompt, 1), "two-dinosaurs-fighting-in-a-jungle-1.mp4");
  assert.equal(finalVideoFileName(prompt, 2), "two-dinosaurs-fighting-in-a-jungle-2.mp4");
  assert.equal(
    finalVideoPartialFileName(prompt, 2),
    "two-dinosaurs-fighting-in-a-jungle-2.part.mp4",
  );
});

test("final video names discard control markers and filesystem-unsafe prompt punctuation", () => {
  const prompt = "Create a video of ../../Night: horror? * | <escape>";
  const authorizedPrompt = bindYouTubeUploadAuthorization(prompt, true);
  const expected = "night-horror-escape-4.mp4";
  assert.equal(finalVideoFileName(prompt, 4), expected);
  assert.equal(finalVideoFileName(authorizedPrompt, 4), expected);
  assert.equal(path.basename(finalVideoFileName(prompt, 4)), expected);
  assert.doesNotMatch(expected, /[\\/:*?"<>|]/u);
});

test("final video path components stay below common filesystem byte limits", () => {
  const name = finalVideoFileName(`Create a video of ${"界".repeat(500)}`, 9_007_199_254_740_991);
  assert.ok(Buffer.byteLength(name, "utf8") <= 255);
  assert.match(name, /-9007199254740991\.mp4$/u);
  assert.throws(() => finalVideoFileName("A cat", 0), /positive safe integer/);
});

test("final video artifact paths remain direct children of the run directory", () => {
  const runDirectory = path.resolve("/tmp/video-run");
  const paths = finalVideoArtifactPaths(
    runDirectory,
    "Create a video of ../../a romantic sunset",
    3,
  );
  assert.equal(paths.outputPath, path.join(runDirectory, "a-romantic-sunset-3.mp4"));
  assert.equal(paths.partialPath, path.join(runDirectory, "a-romantic-sunset-3.part.mp4"));
  assert.equal(path.dirname(paths.outputPath), runDirectory);
  assert.equal(path.dirname(paths.partialPath), runDirectory);
});

test("new and retained legacy final namespaces are distinguished from staging files", () => {
  const prompt = "Create a video of ocean waves";
  assert.equal(isPromptFinalVideoFileName("ocean-waves-12.mp4", prompt), true);
  assert.equal(isPromptFinalVideoPartialFileName("ocean-waves-12.part.mp4", prompt), true);
  assert.equal(isPromptFinalVideoFileName("another-prompt-12.mp4", prompt), false);
  assert.equal(isPromptFinalVideoFileName("ocean-waves-12.part.mp4", prompt), false);
  assert.equal(isLegacyFinalVideoFileName("final-12.mp4"), true);
  assert.equal(isLegacyFinalVideoFileName("final.mp4"), true);
  assert.equal(isLegacyFinalVideoFileName("final-12.part.mp4"), false);
});
