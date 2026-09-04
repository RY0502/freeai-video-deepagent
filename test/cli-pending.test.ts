import assert from "node:assert/strict";
import test from "node:test";

import type { VideoPlan } from "../src/agent/videoPlan.js";
import {
  inspectRequiredMediaForShortCircuit,
  publicCheckpoint,
  youtubeUploadRequiresManualReconciliation,
} from "../src/cli.js";
import {
  videoCheckpointKeys,
  type ArtifactCheckpoint,
  type PersistedProviderJob,
  type VideoCheckpointKey,
} from "../src/state/index.js";
import { AUDIO_MIX_REVISION, SOURCE_AUDIO_INSPECTION_REVISION } from "../src/media/index.js";
import {
  AGNES_NATIVE_AUDIO_MODEL,
  SOURCE_AUDIO_ANALYSIS_MODEL,
} from "../src/tools/videoAgentTools.js";
import {
  FOLEY_RECONCILIATION_MODEL,
  FOLEY_RECONCILIATION_REVISION,
} from "../src/vision/index.js";

const NOW = new Date("2026-09-03T10:00:00.000Z");
const FUTURE = "2026-09-03T11:00:00.000Z";
const SOURCE_SHA256 = "a".repeat(64);
const SOURCE_AUDIO_ANALYSIS_SHA256 = "d".repeat(64);

function plan(musicEnabled = true): VideoPlan {
  return {
    music: musicEnabled ? { enabled: true } : { enabled: false },
  } as unknown as VideoPlan;
}

function receipt(): PersistedProviderJob {
  return {
    schemaVersion: 2,
    provider: "agnes",
    id: "internal-agnes-id",
    videoId: "video-agnes-456",
    taskId: "task-agnes-456",
    keyFingerprint: "a".repeat(64),
    keyLabel: "key-3",
    model: "agnes-video-2.5-flash",
    requestDigest: "b".repeat(64),
  };
}

function checkpoint(overrides: Partial<ArtifactCheckpoint>): ArtifactCheckpoint {
  return {
    schemaVersion: 2,
    status: "failed",
    attempt: 1,
    startedAt: "2026-09-03T09:00:00.000Z",
    updatedAt: "2026-09-03T09:00:00.000Z",
    ...overrides,
  } as ArtifactCheckpoint;
}

async function inspect(
  checkpoints: Map<VideoCheckpointKey, ArtifactCheckpoint>,
  musicEnabled = true,
) {
  const foley = checkpoints.get(videoCheckpointKeys.foley);
  if (
    foley?.status === "completed"
    && foley.provider === "elevenlabs+local"
    && !checkpoints.has(videoCheckpointKeys.foleyAnalysis)
  ) checkpoints.set(videoCheckpointKeys.foleyAnalysis, foleyAnalysis());
  return inspectRequiredMediaForShortCircuit({
    plan: plan(musicEnabled),
    now: NOW,
    loadCheckpoint: (key) => checkpoints.get(key) ?? null,
    validateCompletedArtifact: async (value) => value.status === "completed",
  });
}

function completed(path: string): ArtifactCheckpoint {
  return checkpoint({
    status: "completed",
    path,
    sha256: path.endsWith("/source.mp4") ? SOURCE_SHA256 : "c".repeat(64),
    ...(path.endsWith("/music.wav")
      ? { provider: "free.ai", model: "ace-step" }
      : path.endsWith("/foley-mix.wav")
        ? {
            provider: "elevenlabs+local",
            model: "eleven_text_to_sound_v2+ffmpeg",
            details: {
              audioMixRevision: AUDIO_MIX_REVISION,
              sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
              sourceAudioAnalysisSha256: SOURCE_AUDIO_ANALYSIS_SHA256,
              foleyReconciliationRevision: FOLEY_RECONCILIATION_REVISION,
              foleyReconciliationSha256: "f".repeat(64),
              sourceVideoSha256: SOURCE_SHA256,
            },
          }
        : {}),
  });
}

function sourceAudioAnalysis(usable = false): ArtifactCheckpoint {
  return checkpoint({
    status: "completed",
    path: "/local/analysis/source-audio.json",
    sha256: SOURCE_AUDIO_ANALYSIS_SHA256,
    provider: "local",
    model: SOURCE_AUDIO_ANALYSIS_MODEL,
    details: {
      inspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      sourceVideoSha256: SOURCE_SHA256,
      usable,
    },
  });
}

function foleyAnalysis(): ArtifactCheckpoint {
  return checkpoint({
    status: "completed",
    path: "/local/analysis/observed-foley-plan.json",
    sha256: "f".repeat(64),
    provider: "vision-orchestrator+ffmpeg",
    model: FOLEY_RECONCILIATION_MODEL,
    details: {
      reconciliationRevision: FOLEY_RECONCILIATION_REVISION,
      sourceVideoSha256: SOURCE_SHA256,
    },
  });
}

function nativeSelection(): ArtifactCheckpoint {
  return checkpoint({
    status: "skipped",
    provider: "agnes",
    model: AGNES_NATIVE_AUDIO_MODEL,
    error: "Usable embedded Agnes audio selected.",
    details: {
      nativeSourceAudioSelected: true,
      foregroundAudioMode: "agnes_native",
      sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      sourceVideoSha256: SOURCE_SHA256,
      sourceAudioAnalysisSha256: SOURCE_AUDIO_ANALYSIS_SHA256,
    },
  });
}

test("an accepted queued or rendering Agnes task short-circuits before another agent run", async () => {
  for (const status of ["queued", "in_progress"] as const) {
    const providerJob = receipt();
    const checkpoints = new Map<VideoCheckpointKey, ArtifactCheckpoint>([
      [videoCheckpointKeys.sourceVideo, checkpoint({
        status,
        provider: "agnes",
        model: providerJob.model,
        providerStatus: status,
        providerJob,
        externalId: providerJob.videoId,
        details: { progress: status === "queued" ? 0 : 58 },
      })],
      [videoCheckpointKeys.foley, completed("/local/audio/foley-mix.wav")],
      [videoCheckpointKeys.music, completed("/local/audio/music.wav")],
    ]);

    const result = await inspect(checkpoints);
    assert.equal(result.shouldShortCircuit, true);
    assert.equal(result.assemblyCanRun, false);
    assert.deepEqual(result.requiredKeys, [
      videoCheckpointKeys.sourceVideo,
      videoCheckpointKeys.foley,
      videoCheckpointKeys.music,
    ]);
    assert.deepEqual(result.actionableKeys, []);
    assert.deepEqual(result.waiting, [{
      key: videoCheckpointKeys.sourceVideo,
      status,
      reason: "provider_pending",
    }]);
  }
});

test("missing, deferred, ambiguous, and locally reusable media are classified deterministically", async () => {
  const missingMusic = await inspect(new Map([
    [videoCheckpointKeys.sourceVideo, completed("/local/video/source.mp4")],
    [videoCheckpointKeys.sourceAudioAnalysis, sourceAudioAnalysis()],
    [videoCheckpointKeys.foley, completed("/local/audio/foley-mix.wav")],
  ]));
  assert.equal(missingMusic.shouldShortCircuit, false);
  assert.deepEqual(missingMusic.missingKeys, [videoCheckpointKeys.music]);
  assert.deepEqual(missingMusic.actionableKeys, [videoCheckpointKeys.music]);

  const deferredFoley = await inspect(new Map([
    [videoCheckpointKeys.sourceVideo, completed("/local/video/source.mp4")],
    [videoCheckpointKeys.sourceAudioAnalysis, sourceAudioAnalysis()],
    [videoCheckpointKeys.foley, checkpoint({
      status: "deferred",
      retryAt: FUTURE,
      retrySafe: true,
      error: "ElevenLabs rate limit",
    })],
    [videoCheckpointKeys.music, completed("/local/audio/music.wav")],
  ]));
  assert.equal(deferredFoley.shouldShortCircuit, true);
  assert.deepEqual(deferredFoley.waiting, [{
    key: videoCheckpointKeys.foley,
    status: "deferred",
    reason: "deferred_not_due",
    retryAt: FUTURE,
  }]);

  const ambiguousVideo = await inspect(new Map([
    [videoCheckpointKeys.sourceVideo, checkpoint({
      status: "unknown",
      provider: "agnes",
      retrySafe: false,
      error: "The POST outcome is ambiguous and no video_id was returned.",
    })],
    [videoCheckpointKeys.foley, completed("/local/audio/foley-mix.wav")],
    [videoCheckpointKeys.music, completed("/local/audio/music.wav")],
  ]));
  assert.equal(ambiguousVideo.shouldShortCircuit, true);
  assert.deepEqual(ambiguousVideo.waiting.map(({ reason }) => reason), ["ambiguous_submission"]);

  const ready = await inspect(new Map([
    [videoCheckpointKeys.sourceVideo, completed("/local/video/source.mp4")],
    [videoCheckpointKeys.sourceAudioAnalysis, sourceAudioAnalysis()],
    [videoCheckpointKeys.foley, completed("/local/audio/foley-mix.wav")],
    [videoCheckpointKeys.music, completed("/local/audio/music.wav")],
  ]));
  assert.equal(ready.assemblyCanRun, true);
  assert.equal(ready.shouldShortCircuit, false);
  assert.deepEqual(ready.readyKeys, [
    videoCheckpointKeys.sourceVideo,
    videoCheckpointKeys.foley,
    videoCheckpointKeys.music,
  ]);
});

test("a completed track from the previous music provider is actionable, not assembly-ready", async () => {
  const result = await inspect(new Map([
    [videoCheckpointKeys.sourceVideo, completed("/local/video/source.mp4")],
    [videoCheckpointKeys.sourceAudioAnalysis, sourceAudioAnalysis()],
    [videoCheckpointKeys.foley, completed("/local/audio/foley-mix.wav")],
    [videoCheckpointKeys.music, checkpoint({
      status: "completed",
      path: "/local/audio/music.mp3",
      sha256: "c".repeat(64),
      provider: "elevenlabs",
      model: "music_v2",
    })],
  ]));

  assert.equal(result.assemblyCanRun, false);
  assert.deepEqual(result.readyKeys, [
    videoCheckpointKeys.sourceVideo,
    videoCheckpointKeys.foley,
  ]);
  assert.deepEqual(result.actionableKeys, [videoCheckpointKeys.music]);
});

test("a completed Foley stem from an older audio mix is actionable, not assembly-ready", async () => {
  const result = await inspect(new Map([
    [videoCheckpointKeys.sourceVideo, completed("/local/video/source.mp4")],
    [videoCheckpointKeys.sourceAudioAnalysis, sourceAudioAnalysis()],
    [videoCheckpointKeys.foley, checkpoint({
      status: "completed",
      path: "/local/audio/foley-mix.wav",
      sha256: "c".repeat(64),
      provider: "elevenlabs+local",
      model: "eleven_text_to_sound_v2+ffmpeg",
      details: { audioMixRevision: AUDIO_MIX_REVISION - 1 },
    })],
    [videoCheckpointKeys.music, completed("/local/audio/music.wav")],
  ]));

  assert.equal(result.assemblyCanRun, false);
  assert.deepEqual(result.readyKeys, [
    videoCheckpointKeys.sourceVideo,
    videoCheckpointKeys.music,
  ]);
  assert.deepEqual(result.actionableKeys, [videoCheckpointKeys.foley]);
});

test("durably skipped optional music is waived for Foley-only assembly", async () => {
  const result = await inspect(new Map([
    [videoCheckpointKeys.sourceVideo, completed("/local/video/source.mp4")],
    [videoCheckpointKeys.sourceAudioAnalysis, sourceAudioAnalysis()],
    [videoCheckpointKeys.foley, completed("/local/audio/foley-mix.wav")],
    [videoCheckpointKeys.music, checkpoint({
      status: "skipped",
      provider: "free.ai",
      model: "ace-step",
      retrySafe: false,
      error: "Free.ai music remained unavailable after four attempts.",
      details: { optionalArtifactOmitted: true, foleyOnlyFallback: true },
    })],
  ]));

  assert.equal(result.assemblyCanRun, true);
  assert.equal(result.shouldShortCircuit, false);
  assert.deepEqual(result.readyKeys, [
    videoCheckpointKeys.sourceVideo,
    videoCheckpointKeys.foley,
  ]);
  assert.deepEqual(result.omittedKeys, [videoCheckpointKeys.music]);
  assert.deepEqual(result.waiting, []);
  assert.deepEqual(result.actionableKeys, []);
});

test("a Foley-only plan requires the source and global Foley stem but not music", async () => {
  const result = await inspect(new Map([
    [videoCheckpointKeys.sourceVideo, completed("/local/video/source.mp4")],
    [videoCheckpointKeys.sourceAudioAnalysis, sourceAudioAnalysis()],
    [videoCheckpointKeys.foley, completed("/local/audio/foley-mix.wav")],
  ]), false);

  assert.equal(result.assemblyCanRun, true);
  assert.deepEqual(result.requiredKeys, [
    videoCheckpointKeys.sourceVideo,
    videoCheckpointKeys.foley,
  ]);
});

test("a current native-audio selection is foreground-ready without a Foley file", async () => {
  const result = await inspect(new Map([
    [videoCheckpointKeys.sourceVideo, completed("/local/video/source.mp4")],
    [videoCheckpointKeys.sourceAudioAnalysis, sourceAudioAnalysis(true)],
    [videoCheckpointKeys.foley, nativeSelection()],
    [videoCheckpointKeys.music, completed("/local/audio/music.wav")],
  ]));

  assert.equal(result.assemblyCanRun, true);
  assert.deepEqual(result.readyKeys, [
    videoCheckpointKeys.sourceVideo,
    videoCheckpointKeys.foley,
    videoCheckpointKeys.music,
  ]);
  assert.deepEqual(result.omittedKeys, []);
  assert.deepEqual(result.actionableKeys, []);
});

test("foreground audio is actionable when its source-audio analysis is absent", async () => {
  const result = await inspect(new Map([
    [videoCheckpointKeys.sourceVideo, completed("/local/video/source.mp4")],
    [videoCheckpointKeys.foley, completed("/local/audio/foley-mix.wav")],
  ]), false);

  assert.equal(result.assemblyCanRun, false);
  assert.deepEqual(result.readyKeys, [videoCheckpointKeys.sourceVideo]);
  assert.deepEqual(result.actionableKeys, [videoCheckpointKeys.foley]);
});

test("YouTube ambiguity requires manual reconciliation independent of current configuration", () => {
  assert.equal(youtubeUploadRequiresManualReconciliation(null), false);
  assert.equal(youtubeUploadRequiresManualReconciliation(checkpoint({
    status: "failed",
    retrySafe: true,
    error: "Definite API rejection",
  })), false);
  for (const ambiguous of [
    checkpoint({ status: "in_progress", provider: "youtube" }),
    checkpoint({ status: "unknown", retrySafe: false, error: "Socket closed" }),
    checkpoint({ status: "failed", retrySafe: false, error: "Acceptance unknown" }),
    checkpoint({ status: "completed", url: "https://youtu.be/missing-local-id" }),
  ]) {
    assert.equal(youtubeUploadRequiresManualReconciliation(ambiguous), true);
  }
  assert.equal(youtubeUploadRequiresManualReconciliation(checkpoint({
    status: "completed",
    externalId: "known-youtube-id",
  })), false);
});

test("public status shows resumable Agnes identity and progress without fingerprints or signed URLs", () => {
  const providerJob = receipt();
  const visible = publicCheckpoint(checkpoint({
    status: "in_progress",
    provider: "agnes",
    model: providerJob.model,
    providerStatus: "in_progress",
    providerJob,
    externalId: providerJob.videoId,
    url: "https://cdn.agnes-ai.example/video.mp4?signature=secret-capability",
    details: {
      progress: 58,
      keyLabel: providerJob.keyLabel,
      requestDigest: providerJob.requestDigest,
    },
  })) as Record<string, unknown>;

  assert.equal(visible.status, "in_progress");
  assert.equal(visible.providerStatus, "in_progress");
  assert.equal(visible.progress, 58);
  assert.deepEqual(visible.providerTask, {
    videoId: providerJob.videoId,
    taskId: providerJob.taskId,
    keyLabel: providerJob.keyLabel,
  });
  const serialized = JSON.stringify(visible);
  assert.doesNotMatch(serialized, new RegExp(providerJob.keyFingerprint));
  assert.doesNotMatch(serialized, new RegExp(providerJob.requestDigest));
  assert.doesNotMatch(serialized, /internal-agnes-id/);
  assert.doesNotMatch(serialized, /secret-capability/);
  assert.equal("providerJob" in visible, false);
  assert.equal("url" in visible, false);
});
