import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/cli-args.js";

test("joins positional words into a prompt", () => {
  assert.deepEqual(parseCliArgs(["make", "a", "cat", "video"]), {
    kind: "run",
    prompt: "make a cat video",
    youtubeUploadRequested: false,
  });
});

test("requires an explicit YouTube capability flag for publication", () => {
  assert.deepEqual(parseCliArgs(["--youtube", "make a cat video"]), {
    kind: "run",
    prompt: "make a cat video",
    youtubeUploadRequested: true,
  });
  assert.throws(() => parseCliArgs(["--youtube"]), /requires a video prompt/);
});

test("parses a valid resume id", () => {
  const runId = "a".repeat(64);
  assert.deepEqual(parseCliArgs(["--resume", runId]), { kind: "resume", runId });
});

test("rejects unsafe or malformed run ids", () => {
  assert.throws(() => parseCliArgs(["--status", "../../.env"]), /64-character/);
});
