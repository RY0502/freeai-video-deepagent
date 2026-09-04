import assert from "node:assert/strict";
import test from "node:test";

import type { VideoPlan } from "../src/agent/videoPlan.js";
import { AUDIO_MIX_REVISION, SOURCE_AUDIO_INSPECTION_REVISION } from "../src/media/index.js";
import {
  FOLEY_RECONCILIATION_MODEL,
  FOLEY_RECONCILIATION_REVISION,
} from "../src/vision/index.js";
import { reconcileDueMediaCheckpoints, type MediaToolInvoker } from "../src/reconcile.js";
import {
  type ArtifactCheckpoint,
  type PersistedProviderJob,
  VideoRunStateStore,
  videoCheckpointKeys,
} from "../src/state/index.js";
import {
  AGNES_NATIVE_AUDIO_MODEL,
  SOURCE_AUDIO_ANALYSIS_MODEL,
} from "../src/tools/videoAgentTools.js";

const NOW = new Date("2026-09-03T10:00:00.000Z");
const BEFORE = "2026-09-03T09:00:00.000Z";
const AFTER = "2026-09-03T11:00:00.000Z";
const SOURCE_SHA256 = "c".repeat(64);
const SOURCE_AUDIO_ANALYSIS_SHA256 = "d".repeat(64);
const FOLEY_ANALYSIS_SHA256 = "f".repeat(64);

function receipt(statusSuffix = "123"): PersistedProviderJob {
  return {
    schemaVersion: 2,
    provider: "agnes",
    id: `task-${statusSuffix}`,
    videoId: `video-${statusSuffix}`,
    taskId: `task-${statusSuffix}`,
    keyFingerprint: "a".repeat(64),
    keyLabel: "key-1",
    model: "agnes-video-2.5-flash",
    requestDigest: "b".repeat(64),
  };
}

function checkpoint(overrides: Partial<ArtifactCheckpoint>): ArtifactCheckpoint {
  return {
    schemaVersion: 2,
    status: "failed",
    attempt: 1,
    startedAt: BEFORE,
    updatedAt: BEFORE,
    ...overrides,
  } as ArtifactCheckpoint;
}

function completedSource(sourceVideoSha256 = SOURCE_SHA256): ArtifactCheckpoint {
  return checkpoint({
    status: "completed",
    path: "/local/video/source.mp4",
    sha256: sourceVideoSha256,
    provider: "agnes",
    model: "agnes-video-2.5-flash",
  });
}

function sourceAudioAnalysis(
  sourceVideoSha256 = SOURCE_SHA256,
  usable = false,
): ArtifactCheckpoint {
  return checkpoint({
    status: "completed",
    path: "/local/analysis/source-audio.json",
    sha256: SOURCE_AUDIO_ANALYSIS_SHA256,
    provider: "local",
    model: SOURCE_AUDIO_ANALYSIS_MODEL,
    details: {
      inspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      sourceVideoSha256,
      usable,
    },
  });
}

function foleyAnalysis(sourceVideoSha256 = SOURCE_SHA256): ArtifactCheckpoint {
  return checkpoint({
    status: "completed",
    path: "/local/analysis/observed-foley-plan.json",
    sha256: FOLEY_ANALYSIS_SHA256,
    provider: "vision-orchestrator+ffmpeg",
    model: FOLEY_RECONCILIATION_MODEL,
    details: {
      reconciliationRevision: FOLEY_RECONCILIATION_REVISION,
      sourceVideoSha256,
    },
  });
}

function currentFoley(sourceVideoSha256 = SOURCE_SHA256): ArtifactCheckpoint {
  return checkpoint({
    status: "completed",
    path: "/local/audio/foley-mix.wav",
    sha256: "e".repeat(64),
    provider: "elevenlabs+local",
    model: "eleven_text_to_sound_v2+ffmpeg",
    details: {
      audioMixRevision: AUDIO_MIX_REVISION,
      sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      sourceAudioAnalysisSha256: SOURCE_AUDIO_ANALYSIS_SHA256,
      foleyReconciliationRevision: FOLEY_RECONCILIATION_REVISION,
      foleyReconciliationSha256: FOLEY_ANALYSIS_SHA256,
      sourceVideoSha256,
    },
  });
}

function plan(musicEnabled = true): VideoPlan {
  return {
    music: musicEnabled ? { enabled: true } : { enabled: false },
  } as unknown as VideoPlan;
}

function namedTool(name: string, invoked: string[], outcome: unknown = { status: "checked" }): MediaToolInvoker {
  return {
    async invoke(input) {
      assert.deepEqual(input, {});
      invoked.push(name);
      return outcome;
    },
  };
}

test("startup reconciliation does nothing until a continuous plan is locked", async () => {
  let invoked = false;
  const stateStore = {
    loadPlan: async () => null,
    loadCheckpoint: async () => { throw new Error("must not read checkpoints"); },
  } as unknown as VideoRunStateStore;
  const tool: MediaToolInvoker = {
    async invoke() {
      invoked = true;
      return undefined;
    },
  };

  assert.deepEqual(await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "prompt",
    tools: { generateVideo: tool, generateFoley: tool, generateMusic: tool },
    now: NOW,
  }), []);
  assert.equal(invoked, false);
});

test("queued and rendering Agnes receipts resume polling and never advance to other media while pending", async () => {
  for (const providerStatus of ["queued", "in_progress"] as const) {
    const acceptedReceipt = receipt(providerStatus);
    const sourceCheckpoint = checkpoint({
      status: providerStatus,
      provider: "agnes",
      model: acceptedReceipt.model,
      externalId: acceptedReceipt.videoId,
      providerStatus,
      providerJob: acceptedReceipt,
      details: { progress: providerStatus === "queued" ? 0 : 63 },
    });
    const checkpoints = new Map<string, ArtifactCheckpoint>([
      [videoCheckpointKeys.sourceVideo, sourceCheckpoint],
      [videoCheckpointKeys.foley, checkpoint({
        status: "failed",
        retrySafe: true,
        error: "Foley can resume only after video polling finishes.",
      })],
      [videoCheckpointKeys.music, checkpoint({
        status: "failed",
        retrySafe: true,
        error: "Music can resume only after video polling finishes.",
      })],
    ]);
    const stateStore = {
      loadPlan: async () => plan(true),
      loadCheckpoint: async (_prompt: string, key: string) => checkpoints.get(key) ?? null,
      resetCheckpointForRetry: async () => {
        throw new Error("an accepted Agnes receipt must never be reset");
      },
    } as unknown as VideoRunStateStore;
    const invoked: string[] = [];
    const outcomes = await reconcileDueMediaCheckpoints({
      stateStore,
      originalPrompt: "prompt",
      now: NOW,
      tools: {
        generateVideo: namedTool("video-poll", invoked, JSON.stringify({
          status: "pending",
          reason: `Agnes task ${acceptedReceipt.videoId} is still ${providerStatus}.`,
          videoId: acceptedReceipt.videoId,
        })),
        generateFoley: namedTool("foley", invoked),
        generateMusic: namedTool("music", invoked),
      },
    });

    assert.deepEqual(invoked, ["video-poll"]);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.key, videoCheckpointKeys.sourceVideo);
    assert.equal(outcomes[0]?.stopsInvocation, true);
    assert.match(outcomes[0]?.pendingReason ?? "", new RegExp(acceptedReceipt.videoId));
    assert.strictEqual(checkpoints.get(videoCheckpointKeys.sourceVideo), sourceCheckpoint);
    assert.deepEqual(sourceCheckpoint.providerJob, acceptedReceipt);
  }
});

test("a completed Agnes task is downloaded, then its missing source-audio analysis runs in the same reconciliation", async () => {
  const acceptedReceipt = receipt("download");
  const checkpoints = new Map<string, ArtifactCheckpoint>([
    [videoCheckpointKeys.sourceVideo, checkpoint({
      status: "completed",
      path: "/missing/video/source.mp4",
      sha256: SOURCE_SHA256,
      provider: "agnes",
      model: acceptedReceipt.model,
      externalId: acceptedReceipt.videoId,
      providerStatus: "completed",
      providerJob: acceptedReceipt,
    })],
  ]);
  const stateStore = {
    loadPlan: async () => plan(false),
    loadCheckpoint: async (_prompt: string, key: string) => checkpoints.get(key) ?? null,
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  const outcomes = await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "Foley only",
    now: NOW,
    tools: {
      generateVideo: {
        async invoke(input) {
          assert.deepEqual(input, {});
          invoked.push("video-resume-download");
          checkpoints.set(videoCheckpointKeys.sourceVideo, completedSource());
          return { status: "completed", videoId: acceptedReceipt.videoId };
        },
      },
      generateFoley: namedTool("foley", invoked),
      generateMusic: namedTool("music", invoked),
    },
  });

  assert.deepEqual(invoked, ["video-resume-download", "foley"]);
  assert.deepEqual(outcomes.map(({ key }) => key), [
    videoCheckpointKeys.sourceVideo,
    videoCheckpointKeys.sourceAudioAnalysis,
  ]);
  assert.equal(outcomes[0]?.stopsInvocation, undefined);
});

test("reconciliation uses the single source, global Foley, and optional music checkpoint order", async () => {
  const checkpoints = new Map<string, ArtifactCheckpoint>([
    [videoCheckpointKeys.sourceVideo, completedSource()],
    [videoCheckpointKeys.sourceAudioAnalysis, sourceAudioAnalysis()],
    [videoCheckpointKeys.foley, checkpoint({
      status: "deferred",
      retrySafe: true,
      retryAt: BEFORE,
      error: "Foley rate limit elapsed.",
    })],
    [videoCheckpointKeys.music, checkpoint({
      status: "failed",
      retrySafe: true,
      error: "Music credits were replenished.",
    })],
  ]);
  const loaded: string[] = [];
  const stateStore = {
    loadPlan: async () => plan(true),
    loadCheckpoint: async (_prompt: string, key: string) => {
      loaded.push(key);
      return checkpoints.get(key) ?? null;
    },
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  const outcomes = await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "prompt",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foley", invoked),
      generateMusic: namedTool("music", invoked),
    },
  });

  assert.deepEqual(loaded, [
    videoCheckpointKeys.sourceVideo,
    videoCheckpointKeys.sourceVideo,
    videoCheckpointKeys.sourceAudioAnalysis,
    videoCheckpointKeys.foley,
    videoCheckpointKeys.foleyAnalysis,
    videoCheckpointKeys.music,
  ]);
  assert.deepEqual(invoked, ["foley", "music"]);
  assert.deepEqual(outcomes.map(({ key }) => key), [
    videoCheckpointKeys.foley,
    videoCheckpointKeys.music,
  ]);
});

test("startup reconciliation resumes an ambiguous synchronous Foley request", async () => {
  const checkpoints = new Map<string, ArtifactCheckpoint>([
    [videoCheckpointKeys.sourceVideo, completedSource()],
    [videoCheckpointKeys.sourceAudioAnalysis, sourceAudioAnalysis()],
    [videoCheckpointKeys.foley, checkpoint({
      status: "unknown",
      retrySafe: false,
      provider: "elevenlabs+local",
      model: "eleven_text_to_sound_v2+ffmpeg",
      error: "The synchronous response was lost.",
    })],
  ]);
  const stateStore = {
    loadPlan: async () => plan(false),
    loadCheckpoint: async (_prompt: string, key: string) => checkpoints.get(key) ?? null,
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  const outcomes = await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "prompt",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foley", invoked, { status: "completed" }),
      generateMusic: namedTool("music", invoked),
    },
  });

  assert.deepEqual(invoked, ["foley"]);
  assert.deepEqual(outcomes.map(({ key }) => key), [videoCheckpointKeys.foley]);
});

test("startup reconciliation locally remixes a completed stale Foley stem", async () => {
  const staleFoley = checkpoint({
    status: "completed",
    path: "/local/audio/foley-mix.wav",
    sha256: "c".repeat(64),
    provider: "elevenlabs+local",
    model: "eleven_text_to_sound_v2+ffmpeg",
    details: { audioMixRevision: AUDIO_MIX_REVISION - 1 },
  });
  const checkpoints = new Map<string, ArtifactCheckpoint>([
    [videoCheckpointKeys.sourceVideo, completedSource()],
    [videoCheckpointKeys.sourceAudioAnalysis, sourceAudioAnalysis()],
    [videoCheckpointKeys.foley, staleFoley],
  ]);
  const stateStore = {
    loadPlan: async () => plan(false),
    loadCheckpoint: async (_prompt: string, key: string) => checkpoints.get(key) ?? null,
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  const outcomes = await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "Foley only",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foley-remix", invoked, { status: "completed" }),
      generateMusic: namedTool("music", invoked),
    },
  });

  assert.deepEqual(invoked, ["foley-remix"]);
  assert.deepEqual(outcomes.map(({ key }) => key), [videoCheckpointKeys.foley]);
});

test("startup reconciliation leaves a current completed Foley stem untouched", async () => {
  const foley = currentFoley();
  const stateStore = {
    loadPlan: async () => plan(false),
    loadCheckpoint: async (_prompt: string, key: string) => {
      if (key === videoCheckpointKeys.sourceVideo) return completedSource();
      if (key === videoCheckpointKeys.sourceAudioAnalysis) return sourceAudioAnalysis();
      if (key === videoCheckpointKeys.foley) return foley;
      if (key === videoCheckpointKeys.foleyAnalysis) return foleyAnalysis();
      return null;
    },
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  assert.deepEqual(await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "Foley only",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foley", invoked),
      generateMusic: namedTool("music", invoked),
    },
  }), []);
  assert.deepEqual(invoked, []);
});

test("startup reconciliation accepts a current native-audio selection and does not invoke ElevenLabs Foley", async () => {
  const nativeSelection = checkpoint({
    status: "skipped",
    provider: "agnes",
    model: AGNES_NATIVE_AUDIO_MODEL,
    error: "Usable Agnes audio selected.",
    details: {
      nativeSourceAudioSelected: true,
      foregroundAudioMode: "agnes_native",
      sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      sourceVideoSha256: SOURCE_SHA256,
      sourceAudioAnalysisSha256: SOURCE_AUDIO_ANALYSIS_SHA256,
    },
  });
  const stateStore = {
    loadPlan: async () => plan(true),
    loadCheckpoint: async (_prompt: string, key: string) => {
      if (key === videoCheckpointKeys.sourceVideo) return completedSource();
      if (key === videoCheckpointKeys.sourceAudioAnalysis) {
        return sourceAudioAnalysis(SOURCE_SHA256, true);
      }
      if (key === videoCheckpointKeys.foley) return nativeSelection;
      if (key === videoCheckpointKeys.music) {
        return checkpoint({ status: "failed", retrySafe: true, error: "retry music" });
      }
      return null;
    },
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  const outcomes = await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "prompt",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foley", invoked),
      generateMusic: namedTool("music", invoked),
    },
  });

  assert.deepEqual(invoked, ["music"]);
  assert.deepEqual(outcomes.map(({ key }) => key), [videoCheckpointKeys.music]);
});

test("startup reconciliation creates missing source-audio analysis and foreground selection with one Foley-tool call", async () => {
  const stateStore = {
    loadPlan: async () => plan(false),
    loadCheckpoint: async (_prompt: string, key: string) => key === videoCheckpointKeys.sourceVideo
      ? completedSource()
      : null,
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  const outcomes = await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "prompt",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foreground", invoked, { status: "native_audio_selected" }),
      generateMusic: namedTool("music", invoked),
    },
  });

  assert.deepEqual(invoked, ["foreground"]);
  assert.deepEqual(outcomes.map(({ key }) => key), [
    videoCheckpointKeys.sourceAudioAnalysis,
  ]);
});

test("startup reconciliation repairs a stale source-audio analysis with one Foley-tool call", async () => {
  const staleAnalysis = sourceAudioAnalysis("a".repeat(64), true);
  const stateStore = {
    loadPlan: async () => plan(false),
    loadCheckpoint: async (_prompt: string, key: string) => {
      if (key === videoCheckpointKeys.sourceVideo) return completedSource();
      if (key === videoCheckpointKeys.sourceAudioAnalysis) return staleAnalysis;
      return null;
    },
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  const outcomes = await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "prompt",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foreground", invoked),
      generateMusic: namedTool("music", invoked),
    },
  });

  assert.deepEqual(invoked, ["foreground"]);
  assert.deepEqual(outcomes.map(({ key }) => key), [
    videoCheckpointKeys.sourceAudioAnalysis,
  ]);
});

test("startup reconciliation rebuilds Foley when its source-video binding changed", async () => {
  const foley = checkpoint({
    status: "completed",
    path: "/local/audio/foley-mix.wav",
    sha256: "c".repeat(64),
    provider: "elevenlabs+local",
    model: "eleven_text_to_sound_v2+ffmpeg",
    details: {
      audioMixRevision: AUDIO_MIX_REVISION,
      sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      sourceAudioAnalysisSha256: SOURCE_AUDIO_ANALYSIS_SHA256,
      foleyReconciliationRevision: FOLEY_RECONCILIATION_REVISION,
      foleyReconciliationSha256: FOLEY_ANALYSIS_SHA256,
      sourceVideoSha256: "a".repeat(64),
    },
  });
  const stateStore = {
    loadPlan: async () => plan(false),
    loadCheckpoint: async (_prompt: string, key: string) => {
      if (key === videoCheckpointKeys.foley) return foley;
      if (key === videoCheckpointKeys.sourceVideo) {
        return completedSource("b".repeat(64));
      }
      if (key === videoCheckpointKeys.sourceAudioAnalysis) {
        return sourceAudioAnalysis("b".repeat(64));
      }
      if (key === videoCheckpointKeys.foleyAnalysis) {
        return foleyAnalysis("a".repeat(64));
      }
      return null;
    },
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  const result = await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "Foley only",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foley-remix", invoked, { status: "completed" }),
      generateMusic: namedTool("music", invoked),
    },
  });

  assert.deepEqual(invoked, ["foley-remix"]);
  assert.deepEqual(result.map(({ key }) => key), [videoCheckpointKeys.foley]);
});

test("startup reconciliation replaces a completed track from the previous music provider", async () => {
  const stateStore = {
    loadPlan: async () => plan(true),
    loadCheckpoint: async (_prompt: string, key: string) => key === videoCheckpointKeys.music
      ? checkpoint({
          status: "completed",
          path: "/local/audio/music.mp3",
          sha256: "c".repeat(64),
          provider: "elevenlabs",
          model: "music_v2",
        })
      : null,
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  const outcomes = await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "prompt",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foley", invoked),
      generateMusic: namedTool("free-ai-music", invoked, { status: "completed" }),
    },
  });

  assert.deepEqual(invoked, ["free-ai-music"]);
  assert.deepEqual(outcomes.map(({ key }) => key), [videoCheckpointKeys.music]);
});

test("startup reconciliation resumes a retained Free.ai music download URL", async () => {
  const stateStore = {
    loadPlan: async () => plan(true),
    loadCheckpoint: async (_prompt: string, key: string) => key === videoCheckpointKeys.music
      ? checkpoint({
          status: "in_progress",
          provider: "free.ai",
          model: "ace-step",
          url: "https://media.example/music.wav",
          externalId: "music-accepted",
          details: { submissionAccepted: true },
        })
      : null,
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  const outcomes = await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "prompt",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foley", invoked),
      generateMusic: namedTool("music-download", invoked, { status: "completed" }),
    },
  });

  assert.deepEqual(invoked, ["music-download"]);
  assert.deepEqual(outcomes.map(({ key }) => key), [videoCheckpointKeys.music]);
});

test("startup reconciliation never retries durably skipped music, even with a stale URL", async () => {
  const stateStore = {
    loadPlan: async () => plan(true),
    loadCheckpoint: async (_prompt: string, key: string) => key === videoCheckpointKeys.music
      ? checkpoint({
          status: "skipped",
          provider: "free.ai",
          model: "ace-step",
          url: "https://media.example/stale-accepted-url.wav",
          retrySafe: false,
          error: "Music remained unavailable after the bounded attempt cycle.",
          details: { optionalArtifactOmitted: true, foleyOnlyFallback: true },
        })
      : null,
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  const outcomes = await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "prompt",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foley", invoked),
      generateMusic: namedTool("music", invoked),
    },
  });

  assert.deepEqual(invoked, []);
  assert.deepEqual(outcomes, []);
});

test("future retries and disabled music remain untouched", async () => {
  const loaded: string[] = [];
  const deferredFoley = checkpoint({
    status: "deferred",
    retrySafe: true,
    retryAt: AFTER,
    error: "Wait for the provider retry time.",
  });
  const stateStore = {
    loadPlan: async () => plan(false),
    loadCheckpoint: async (_prompt: string, key: string) => {
      loaded.push(key);
      if (key === videoCheckpointKeys.sourceVideo) return completedSource();
      if (key === videoCheckpointKeys.sourceAudioAnalysis) return sourceAudioAnalysis();
      if (key === videoCheckpointKeys.foley) return deferredFoley;
      return null;
    },
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  assert.deepEqual(await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "No background music",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foley", invoked),
      generateMusic: namedTool("music", invoked),
    },
  }), []);
  assert.deepEqual(loaded, [
    videoCheckpointKeys.sourceVideo,
    videoCheckpointKeys.sourceVideo,
    videoCheckpointKeys.sourceAudioAnalysis,
    videoCheckpointKeys.foley,
    videoCheckpointKeys.foleyAnalysis,
  ]);
  assert.deepEqual(invoked, []);
});

test("a retry-safe media failure stops reconciliation with its durable reason", async () => {
  const stateStore = {
    loadPlan: async () => plan(true),
    loadCheckpoint: async (_prompt: string, key: string) => {
      if (key === videoCheckpointKeys.sourceVideo) return completedSource();
      if (key === videoCheckpointKeys.sourceAudioAnalysis) return sourceAudioAnalysis();
      if (key === videoCheckpointKeys.foley) {
        return checkpoint({ status: "failed", retrySafe: true, error: "retry Foley" });
      }
      if (key === videoCheckpointKeys.music) {
        return checkpoint({ status: "failed", retrySafe: true, error: "retry music" });
      }
      return null;
    },
  } as unknown as VideoRunStateStore;
  const invoked: string[] = [];

  const outcomes = await reconcileDueMediaCheckpoints({
    stateStore,
    originalPrompt: "prompt",
    now: NOW,
    tools: {
      generateVideo: namedTool("video", invoked),
      generateFoley: namedTool("foley", invoked, JSON.stringify({
        status: "failed",
        retrySafe: true,
        retryOn: "next_invocation",
        reason: "ElevenLabs Foley remains unavailable.",
      })),
      generateMusic: namedTool("music", invoked),
    },
  });

  assert.deepEqual(invoked, ["foley"]);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.stopsInvocation, true);
  assert.equal(outcomes[0]?.failureReason, "ElevenLabs Foley remains unavailable.");
});
