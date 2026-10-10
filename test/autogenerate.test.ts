import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findEligibleAutogenerateRuns,
  hasVideoAlreadyGeneratedOnDisk,
  isRunEligibleForAutogenerate,
} from "../src/state/autogenerateRuns.js";
import { videoCheckpointKeys, type VideoRunManifest } from "../src/state/videoRunState.js";

function baseManifest(status: VideoRunManifest["status"] = "generating"): VideoRunManifest {
  return {
    schemaVersion: 2,
    promptHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    originalPrompt: "Test video prompt",
    status,
    youtubeUploadRequested: false,
    planStored: true,
    createdAt: "2026-10-10T10:00:00.000Z",
    updatedAt: "2026-10-10T10:00:00.000Z",
  };
}

test("isRunEligibleForAutogenerate rejects completed runs and completed assembly", () => {
  const completedManifest = baseManifest("completed");
  assert.equal(isRunEligibleForAutogenerate(completedManifest, {}).eligible, false);

  const generatingManifest = baseManifest("generating");
  const completedAssembly = {
    [videoCheckpointKeys.assembly]: {
      schemaVersion: 2 as const,
      status: "completed" as const,
      attempt: 1,
      path: "/runs/test/final.mp4",
      startedAt: "2026-10-10T10:00:00.000Z",
      updatedAt: "2026-10-10T10:05:00.000Z",
    },
  };
  assert.equal(isRunEligibleForAutogenerate(generatingManifest, completedAssembly).eligible, false);
});

test("isRunEligibleForAutogenerate accepts runs with Agnes providerJob receipt", () => {
  const manifest = baseManifest("generating");
  const checkpoints = {
    [videoCheckpointKeys.sourceVideo]: {
      schemaVersion: 2 as const,
      status: "in_progress" as const,
      attempt: 1,
      startedAt: "2026-10-10T10:00:00.000Z",
      updatedAt: "2026-10-10T10:01:00.000Z",
      providerJob: {
        schemaVersion: 2 as const,
        provider: "agnes" as const,
        id: "job-1",
        videoId: "vid-123",
        taskId: "task-456",
        keyFingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        keyLabel: "key-1",
        model: "agnes-video-2.5-flash" as const,
        requestDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    },
  };

  const result = isRunEligibleForAutogenerate(manifest, checkpoints);
  assert.equal(result.eligible, true);
  assert.equal(result.hasProviderJob, true);
});

test("isRunEligibleForAutogenerate accepts runs with Agnes submission in_progress, queued, or unknown", () => {
  const manifest = baseManifest("generating");

  for (const status of ["in_progress", "queued", "deferred", "unknown"] as const) {
    const checkpoints = {
      [videoCheckpointKeys.sourceVideo]: {
        schemaVersion: 2 as const,
        status,
        attempt: 1,
        startedAt: "2026-10-10T10:00:00.000Z",
        updatedAt: "2026-10-10T10:01:00.000Z",
        error: status === "unknown" ? "Network issue" : undefined,
      },
    };

    const result = isRunEligibleForAutogenerate(manifest, checkpoints);
    assert.equal(result.eligible, true, `Expected eligible for status ${status}`);
    assert.equal(result.hasProviderJob, false);
  }
});

test("findEligibleAutogenerateRuns orders eligible runs oldest first", async () => {
  const testRoot = path.join(tmpdir(), `auto-runs-test-${Date.now()}`);
  await mkdir(testRoot, { recursive: true });

  const run1Id = "1111111111111111111111111111111111111111111111111111111111111111";
  const run2Id = "2222222222222222222222222222222222222222222222222222222222222222";
  const run3Id = "3333333333333333333333333333333333333333333333333333333333333333";

  const run1Dir = path.join(testRoot, run1Id);
  const run2Dir = path.join(testRoot, run2Id);
  const run3Dir = path.join(testRoot, run3Id);

  await mkdir(run1Dir, { recursive: true });
  await mkdir(run2Dir, { recursive: true });
  await mkdir(run3Dir, { recursive: true });

  // Run 1: created at 12:00, in_progress (eligible, newer than run 2)
  await writeFile(path.join(run1Dir, "run.json"), JSON.stringify({
    schemaVersion: 2,
    runId: run1Id,
    originalPrompt: "Prompt 1",
    runDirectory: run1Dir,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
  }));
  await writeFile(path.join(run1Dir, "pipeline-state.json"), JSON.stringify({
    schemaVersion: 2,
    manifest: { ...baseManifest(), createdAt: "2026-10-10T12:00:00.000Z" },
    checkpoints: {
      [videoCheckpointKeys.sourceVideo]: {
        schemaVersion: 2,
        status: "in_progress",
        attempt: 1,
        startedAt: "2026-10-10T12:00:00.000Z",
        updatedAt: "2026-10-10T12:00:00.000Z",
      },
    },
  }));

  // Run 2: created at 09:00 (oldest eligible)
  await writeFile(path.join(run2Dir, "run.json"), JSON.stringify({
    schemaVersion: 2,
    runId: run2Id,
    originalPrompt: "Prompt 2",
    runDirectory: run2Dir,
    createdAt: "2026-10-10T09:00:00.000Z",
    updatedAt: "2026-10-10T09:00:00.000Z",
  }));
  await writeFile(path.join(run2Dir, "pipeline-state.json"), JSON.stringify({
    schemaVersion: 2,
    manifest: { ...baseManifest(), createdAt: "2026-10-10T09:00:00.000Z" },
    checkpoints: {
      [videoCheckpointKeys.sourceVideo]: {
        schemaVersion: 2,
        status: "queued",
        attempt: 1,
        startedAt: "2026-10-10T09:00:00.000Z",
        updatedAt: "2026-10-10T09:00:00.000Z",
        providerJob: {
          schemaVersion: 2,
          provider: "agnes",
          id: "job-2",
          videoId: "vid-2",
          taskId: "task-2",
          keyFingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          keyLabel: "key-1",
          model: "agnes-video-2.5-flash",
          requestDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      },
    },
  }));

  // Run 3: completed (ineligible)
  await writeFile(path.join(run3Dir, "run.json"), JSON.stringify({
    schemaVersion: 2,
    runId: run3Id,
    originalPrompt: "Prompt 3",
    runDirectory: run3Dir,
    createdAt: "2026-10-10T08:00:00.000Z",
    updatedAt: "2026-10-10T08:30:00.000Z",
  }));
  await writeFile(path.join(run3Dir, "pipeline-state.json"), JSON.stringify({
    schemaVersion: 2,
    manifest: { ...baseManifest("completed"), createdAt: "2026-10-10T08:00:00.000Z" },
    checkpoints: {
      [videoCheckpointKeys.assembly]: {
        schemaVersion: 2,
        status: "completed",
        attempt: 1,
        path: "/final.mp4",
        startedAt: "2026-10-10T08:00:00.000Z",
        updatedAt: "2026-10-10T08:30:00.000Z",
      },
    },
  }));

  try {
    const eligible = await findEligibleAutogenerateRuns(testRoot);
    assert.equal(eligible.length, 2);
    // Oldest first: Run 2 (09:00) must be first, then Run 1 (12:00)
    assert.equal(eligible[0]?.runId, run2Id);
    assert.equal(eligible[1]?.runId, run1Id);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("findEligibleAutogenerateRuns ignores runs for which video is already generated on disk", async () => {
  const testRoot = path.join(tmpdir(), `auto-runs-ondisk-test-${Date.now()}`);
  await mkdir(testRoot, { recursive: true });

  const runId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const runDir = path.join(testRoot, runId);
  await mkdir(runDir, { recursive: true });

  // Run has in_progress Agnes submission, but video is already on disk
  await writeFile(path.join(runDir, "run.json"), JSON.stringify({
    schemaVersion: 2,
    runId,
    originalPrompt: "Prompt with existing video",
    runDirectory: runDir,
    createdAt: "2026-10-10T10:00:00.000Z",
    updatedAt: "2026-10-10T10:00:00.000Z",
  }));
  await writeFile(path.join(runDir, "pipeline-state.json"), JSON.stringify({
    schemaVersion: 2,
    manifest: { ...baseManifest(), createdAt: "2026-10-10T10:00:00.000Z" },
    checkpoints: {
      [videoCheckpointKeys.sourceVideo]: {
        schemaVersion: 2,
        status: "in_progress",
        attempt: 1,
        startedAt: "2026-10-10T10:00:00.000Z",
        updatedAt: "2026-10-10T10:00:00.000Z",
      },
    },
  }));

  // Create generated final video file on disk
  const finalVideoFile = path.join(runDir, "prompt-with-existing-video-1.mp4");
  await writeFile(finalVideoFile, Buffer.from("dummy-final-video-content"));

  try {
    assert.equal(await hasVideoAlreadyGeneratedOnDisk(runDir), true);
    const eligible = await findEligibleAutogenerateRuns(testRoot);
    // Run should be skipped because video is already on disk
    assert.equal(eligible.length, 0);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

