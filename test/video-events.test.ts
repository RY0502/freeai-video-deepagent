import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import ffmpegStaticModule from "ffmpeg-static";

import {
  AgnesError,
  type AgnesPollOptions,
  type AgnesSubmitVideoRequest,
  type AgnesVideoClient,
  type AgnesVideoTask,
} from "../src/agnes/index.js";
import type { VideoPlan } from "../src/agent/videoPlan.js";
import { bindYouTubeUploadAuthorization } from "../src/authorization.js";
import { loadConfig } from "../src/config.js";
import type { ElevenLabsClient } from "../src/elevenlabs/index.js";
import {
  FreeAiMusicError,
  type FreeAiMusicClient,
  type FreeAiMusicDownloadRequest,
  type FreeAiMusicRequest,
} from "../src/freeai/index.js";
import {
  AUDIO_MIX_REVISION,
  BACKGROUND_MUSIC_MIX,
  SOURCE_AUDIO_INSPECTION_REVISION,
  SOURCE_AUDIO_MIN_ACTIVE_SECONDS,
  SOURCE_AUDIO_MIN_MEAN_DBFS,
  SOURCE_AUDIO_MIN_PEAK_DBFS,
  SOURCE_AUDIO_MIN_SILENCE_SECONDS,
  SOURCE_AUDIO_SILENCE_THRESHOLD_DBFS,
  createSpawnProcessRunner,
  type SourceAudioInspectionDocument,
} from "../src/media/index.js";
import { VideoRunStateStore, videoCheckpointKeys } from "../src/state/index.js";
import {
  VIDEO_TOOL_NAMES,
  AGNES_NATIVE_AUDIO_MODEL,
  SOURCE_AUDIO_ANALYSIS_MODEL,
  agnesVideoPrompt,
  createVideoAgentTools,
  legacyAgnesVideoPrompt,
  videoSnapshotEvent,
  type VideoAgentEvent,
  type VideoToolBundle,
} from "../src/tools/videoAgentTools.js";
import { sha256File } from "../src/utils/files.js";
import { YouTubeUploadError, type YouTubeUploader } from "../src/youtube/index.js";

const ffmpegPath = ffmpegStaticModule as unknown as string | null;
const PROMPT = "A red kite crosses a windy hill";

function currentFinalDetails(): Record<string, unknown> {
  return {
    audioMixRevision: AUDIO_MIX_REVISION,
    sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
    sourceAudioAnalysisSha256: "e".repeat(64),
    sourceVideoSha256: "a".repeat(64),
    foregroundAudioMode: "agnes_native",
    foleySha256: null,
    foleyReconciliationRevision: null,
    foleyReconciliationSha256: null,
    musicDependencyStatus: "included",
    musicSha256: "d".repeat(64),
    backgroundMusicRequested: true,
    backgroundMusicIncluded: true,
    foleyOnlyFallback: false,
    musicVolume: 0.10,
    foleyVolume: 1,
    backgroundMusicMix: BACKGROUND_MUSIC_MIX,
  };
}

function sourceAudioInspectionDocument(
  sourceVideoSha256: string,
  usable = true,
): SourceAudioInspectionDocument {
  return {
    schemaVersion: 2,
    inspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
    sourceVideoSha256,
    durationSeconds: 4,
    audioStream: usable
      ? {
          codecName: "aac",
          sampleRate: 48_000,
          channels: 2,
          durationSeconds: 4,
        }
      : null,
    thresholds: {
      silenceDbfs: SOURCE_AUDIO_SILENCE_THRESHOLD_DBFS,
      minimumSilenceSeconds: SOURCE_AUDIO_MIN_SILENCE_SECONDS,
      minimumPeakDbfs: SOURCE_AUDIO_MIN_PEAK_DBFS,
      minimumMeanDbfs: SOURCE_AUDIO_MIN_MEAN_DBFS,
      minimumActiveSeconds: SOURCE_AUDIO_MIN_ACTIVE_SECONDS,
    },
    peakVolumeDbfs: usable ? -8 : null,
    meanVolumeDbfs: usable ? -30 : null,
    silentDurationSeconds: usable ? 1 : 4,
    activeDurationSeconds: usable ? 3 : 0,
    usable,
    reason: usable
      ? "Embedded source audio contains a meaningful decodable signal."
      : "The Agnes video has no embedded audio stream.",
  };
}

async function writeCurrentNativeForeground(
  state: VideoRunStateStore,
  originalPrompt: string,
  runDirectory: string,
): Promise<{
  sourceVideoSha256: string;
  sourceAudioAnalysisSha256: string;
}> {
  const sourcePath = path.join(runDirectory, "video", "source.mp4");
  const sourceContents = "agnes-video-with-native-audio";
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.join(runDirectory, "audio"), { recursive: true });
  await writeFile(sourcePath, sourceContents);
  const sourceVideoSha256 = createHash("sha256").update(sourceContents).digest("hex");
  await state.startCheckpoint(originalPrompt, videoCheckpointKeys.sourceVideo, {
    provider: "agnes",
    model: "agnes-video-2.5-flash",
  });
  await state.completeCheckpoint(originalPrompt, videoCheckpointKeys.sourceVideo, {
    path: sourcePath,
    sha256: sourceVideoSha256,
    durationSeconds: 4,
    provider: "agnes",
    model: "agnes-video-2.5-flash",
  });

  const analysisPath = path.join(runDirectory, "analysis", "source-audio.json");
  const document = sourceAudioInspectionDocument(sourceVideoSha256);
  await mkdir(path.dirname(analysisPath), { recursive: true });
  await writeFile(analysisPath, `${JSON.stringify(document, null, 2)}\n`);
  const sourceAudioAnalysisSha256 = await sha256File(analysisPath);
  await state.startCheckpoint(originalPrompt, videoCheckpointKeys.sourceAudioAnalysis, {
    provider: "local",
    model: SOURCE_AUDIO_ANALYSIS_MODEL,
  });
  await state.completeCheckpoint(originalPrompt, videoCheckpointKeys.sourceAudioAnalysis, {
    path: analysisPath,
    sha256: sourceAudioAnalysisSha256,
    durationSeconds: 4,
    provider: "local",
    model: SOURCE_AUDIO_ANALYSIS_MODEL,
    details: {
      inspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      sourceVideoSha256,
      usable: true,
    },
  });

  const nativeDetails = {
    nativeSourceAudioSelected: true,
    foregroundAudioMode: "agnes_native",
    sourceVideoSha256,
    sourceAudioAnalysisSha256,
    sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
  };
  await state.startCheckpoint(originalPrompt, videoCheckpointKeys.foley, {
    provider: "agnes",
    model: AGNES_NATIVE_AUDIO_MODEL,
    details: nativeDetails,
  });
  await state.skipCheckpoint(
    originalPrompt,
    videoCheckpointKeys.foley,
    "ElevenLabs Foley is not needed because the Agnes source contains usable embedded audio.",
    nativeDetails,
  );

  return { sourceVideoSha256, sourceAudioAnalysisSha256 };
}

async function writeValidFinalVideo(outputPath: string): Promise<void> {
  assert.ok(ffmpegPath, "ffmpeg-static is unavailable");
  await createSpawnProcessRunner({ timeoutMs: 30_000 })(ffmpegPath, [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-n",
    "-f", "lavfi", "-i", "color=c=red:s=720x1280:r=24:d=4",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-t", "4", "-shortest",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-ac", "2",
    outputPath,
  ]);
}

function plan(): VideoPlan {
  return {
    schemaVersion: 2,
    concept: "A red kite crosses a windy hill and settles into a graceful final climb.",
    creativeScript: "A bright red kite enters above a green hill, dips as a gust bends the grass, then catches the wind and climbs into a clear golden sky for a calm visual payoff.",
    totalDurationSeconds: 4,
    continuityBible: {
      id: "kite-film",
      visualStyle: "A cinematic natural-light miniature adventure with realistic motion.",
      subjects: [{
        id: "red-kite",
        role: "primary",
        invariantAppearance: "One diamond-shaped crimson kite with a short white ribbon tail.",
        wardrobeOrSurface: "Matte crimson paper and thin dark spars.",
        props: ["white ribbon tail"],
        identityAnchors: ["diamond silhouette", "crimson surface", "white ribbon tail"],
      }],
      environment: {
        location: "One rolling green hill beneath an open sky.",
        backgroundAnchors: ["single oak tree", "distant low ridge"],
        timeOfDay: "late afternoon",
        weatherOrAtmosphere: "steady visible breeze and clear air",
      },
      lighting: "Warm low sunlight remains consistent from camera left.",
      colorPalette: ["crimson", "meadow green", "warm gold"],
      cameraLanguage: "A restrained dolly follows the same kite without cutting away.",
      supportingAnchors: ["bending grass", "small oak tree"],
      negativeConstraints: ["no duplicate kite", "no captions", "no malformed ribbon"],
    },
    visualPrompt: "One continuous cinematic view follows a single crimson diamond kite over a windy green hill; it dips close to bending grass, recovers smoothly, and climbs into warm late-afternoon light while all identity and landscape anchors remain stable.",
    cameraMotion: "dolly forward",
    cameraDirection: "Dolly forward gently beneath the kite, lower during its dip, then tilt slightly into the final climb.",
    negativePrompt: "no duplicate kite, no text, no logo, no malformed ribbon, no hard cuts",
    timelineBeats: [
      {
        beatId: "arrival",
        startSeconds: 0,
        endSeconds: 2,
        narrativePurpose: "Establish the kite and the wind-bent hillside.",
        visualAction: "The single crimson kite enters above the hill and begins a controlled dip toward the bending grass.",
        cameraDirection: "Track forward at a steady low angle beneath the kite.",
        composition: "Keep the kite upper center with the oak as a stable background anchor.",
      },
      {
        beatId: "climb",
        startSeconds: 2,
        endSeconds: 4,
        narrativePurpose: "Resolve the dip with a clear upward visual payoff.",
        visualAction: "The kite catches the gust, its white tail straightens, and it climbs into the warm clear sky.",
        cameraDirection: "Continue forward and tilt gently upward without a cut.",
        composition: "Let the kite finish against open gold sky while the ridge stays low in frame.",
      },
    ],
    foleyCues: [],
    music: {
      enabled: true,
      prompt: "A delicate, sparse instrumental cue that rises gently with the kite and resolves cleanly.",
      negativePrompt: "no vocals, no sound effects, no heavy percussion",
      genre: "ambient",
      mood: "hopeful and airy",
      role: "background",
      tempoBpm: 84,
      syncStrategy: "Begin lightly, add a small lift at two seconds, and resolve before the end.",
      durationSeconds: 4,
      beats: [
        { beatId: "arrival", startSeconds: 0, endSeconds: 2, direction: "Use a quiet suspended opening phrase." },
        { beatId: "climb", startSeconds: 2, endSeconds: 4, direction: "Rise gently and resolve with no tail." },
      ],
    },
    delivery: {
      visualStyle: "cinematic",
      aspectRatio: "9:16",
      width: 720,
      height: 1280,
      fps: 24,
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
    },
  };
}

function task(status: AgnesVideoTask["status"], progress: number): AgnesVideoTask {
  return {
    id: "task-primary",
    task_id: "task-poll",
    video_id: "video-stable",
    model: "agnes-video-2.5-flash",
    status,
    progress,
    keyLabel: "key-1",
    keyFingerprint: "a".repeat(64),
    ...(status === "completed" ? { metadata: { url: "https://media.example/video.mp4" } } : {}),
  };
}

function tool(bundle: VideoToolBundle, name: string) {
  const found = bundle.tools.find((candidate) => candidate.name === name);
  assert.ok(found);
  return found;
}

test("Agnes receipt survives an eight-minute pending result and rerun polls it without another POST", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agnes-video-events-"));
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);
  const events: VideoAgentEvent[] = [];
  let submissions = 0;
  let resumedTask: AgnesVideoTask | undefined;

  try {
    await state.ensureManifest(PROMPT);
    await state.savePlan(PROMPT, plan());
    const firstAgnes = {
      async submitVideo(request: AgnesSubmitVideoRequest) {
        submissions += 1;
        request.onAttempt?.({ keyLabel: "key-1" });
        return task("queued", 0);
      },
      async pollUntilTerminal(initial: AgnesVideoTask, options: AgnesPollOptions) {
        assert.equal(initial.video_id, "video-stable");
        await options.onPoll?.(task("in_progress", 42));
        return { outcome: "timed_out" as const, task: task("in_progress", 42) };
      },
    } as unknown as AgnesVideoClient;
    const first = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: firstAgnes,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
      onEvent: (event) => events.push(event),
    });
    const pending = JSON.parse(String(await tool(first, VIDEO_TOOL_NAMES.generateVideo).invoke({}))) as Record<string, unknown>;
    assert.equal(pending.status, "pending");
    assert.equal(first.currentInvocationPending()?.includes("eight-minute"), true);

    const stored = await state.loadCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo);
    assert.equal(stored?.status, "in_progress");
    assert.equal(stored?.providerStatus, "in_progress");
    assert.equal(stored?.providerJob?.id, "task-primary");
    assert.equal(stored?.providerJob?.videoId, "video-stable");
    assert.equal(stored?.providerJob?.taskId, "task-poll");
    assert.equal(stored?.providerJob?.keyFingerprint, "a".repeat(64));
    assert.equal(events.some((event) => event.event === "video_task_submitted"), true);
    assert.equal(events.some((event) => event.event === "video_poll_result"), true);
    assert.equal(events.some((event) => event.event === "video_poll_window_exhausted"), true);

    const secondAgnes = {
      async submitVideo() {
        submissions += 1;
        throw new Error("resume must not submit");
      },
      async pollUntilTerminal(initial: AgnesVideoTask, options: AgnesPollOptions) {
        resumedTask = initial;
        const completed = task("completed", 100);
        await options.onPoll?.(completed);
        return { outcome: "completed" as const, task: completed };
      },
      async downloadCompletedVideo(_task: AgnesVideoTask, outputPath: string) {
        await mkdir(path.dirname(outputPath), { recursive: true });
        const bytes = Buffer.from("finished-agnes-video");
        await writeFile(outputPath, bytes);
        return {
          outputPath,
          url: "https://media.example/video.mp4",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          contentType: "video/mp4",
        };
      },
    } as unknown as AgnesVideoClient;
    const second = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: secondAgnes,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
      onEvent: (event) => events.push(event),
    });
    const completed = JSON.parse(String(await tool(second, VIDEO_TOOL_NAMES.generateVideo).invoke({}))) as Record<string, unknown>;
    assert.equal(completed.status, "completed");
    assert.equal(submissions, 1);
    assert.equal(resumedTask?.video_id, "video-stable");
    assert.equal(resumedTask?.keyFingerprint, "a".repeat(64));
    assert.equal(await readFile(path.join(runDirectory, "video", "source.mp4"), "utf8"), "finished-agnes-video");
    assert.equal((await state.loadCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo))?.status, "completed");
    assert.equal(events.some((event) => event.event === "video_downloaded"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a persisted completed receipt without a cached URL is re-fetched and downloaded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agnes-completed-refetch-"));
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);
  let submissions = 0;
  let polls = 0;

  try {
    await state.ensureManifest(PROMPT);
    await state.savePlan(PROMPT, plan());
    await state.startCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo, {
      provider: "agnes",
      model: "agnes-video-2.5-flash",
      details: { requestDigest: "unused-by-test" },
    });

    const initialTask = task("completed", 100);
    await state.updateProviderJobCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo, {
      providerJob: {
        schemaVersion: 2,
        provider: "agnes",
        id: initialTask.id,
        videoId: initialTask.video_id,
        taskId: initialTask.task_id,
        keyFingerprint: initialTask.keyFingerprint,
        keyLabel: initialTask.keyLabel,
        model: "agnes-video-2.5-flash",
        requestDigest: createHash("sha256").update(JSON.stringify({
          model: "agnes-video-2.5-flash",
          prompt: agnesVideoPrompt(plan()),
          seconds: "4",
          mode: "text",
          size: "720P",
          aspect_ratio: "9:16",
          n: 1,
        })).digest("hex"),
      },
      providerStatus: "completed",
      progress: 100,
    });

    const agnes = {
      async submitVideo() {
        submissions += 1;
        throw new Error("a completed receipt must never be resubmitted");
      },
      async pollUntilTerminal(initial: AgnesVideoTask, options: AgnesPollOptions) {
        polls += 1;
        assert.equal(initial.status, "completed");
        assert.equal(initial.metadata, undefined);
        const refreshed = task("completed", 100);
        await options.onPoll?.(refreshed);
        return { outcome: "completed" as const, task: refreshed };
      },
      async downloadCompletedVideo(_task: AgnesVideoTask, outputPath: string) {
        await mkdir(path.dirname(outputPath), { recursive: true });
        const bytes = Buffer.from("refetched-completed-video");
        await writeFile(outputPath, bytes);
        return {
          outputPath,
          url: "https://media.example/video.mp4",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          contentType: "video/mp4",
        };
      },
    } as unknown as AgnesVideoClient;
    const bundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
    });

    const result = JSON.parse(String(
      await tool(bundle, VIDEO_TOOL_NAMES.generateVideo).invoke({}),
    )) as Record<string, unknown>;
    assert.equal(result.status, "completed");
    assert.equal(submissions, 0);
    assert.equal(polls, 1);
    assert.equal(
      await readFile(path.join(runDirectory, "video", "source.mp4"), "utf8"),
      "refetched-completed-video",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an Agnes task accepted with the legacy prompt digest resumes after the native-sound prompt upgrade", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agnes-legacy-prompt-resume-"));
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);
  let submissions = 0;
  let polls = 0;

  try {
    const lockedPlan = plan();
    await state.ensureManifest(PROMPT);
    await state.savePlan(PROMPT, lockedPlan);
    const legacyDigest = createHash("sha256").update(JSON.stringify({
      model: "agnes-video-2.5-flash",
      prompt: legacyAgnesVideoPrompt(lockedPlan),
      seconds: "4",
      mode: "text",
      size: "720P",
      aspect_ratio: "9:16",
      n: 1,
    })).digest("hex");
    await state.startCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo, {
      provider: "agnes",
      model: "agnes-video-2.5-flash",
      details: {
        submissionIntent: "accepted",
        requestDigest: legacyDigest,
        agnesPromptRevision: 1,
      },
    });
    const accepted = task("in_progress", 64);
    await state.updateProviderJobCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo, {
      providerJob: {
        schemaVersion: 2,
        provider: "agnes",
        id: accepted.id,
        videoId: accepted.video_id,
        taskId: accepted.task_id,
        keyFingerprint: accepted.keyFingerprint,
        keyLabel: accepted.keyLabel,
        model: "agnes-video-2.5-flash",
        requestDigest: legacyDigest,
      },
      providerStatus: "in_progress",
      progress: 64,
    });

    const agnes = {
      async submitVideo() {
        submissions += 1;
        throw new Error("a retained legacy receipt must never be resubmitted");
      },
      async pollUntilTerminal(initial: AgnesVideoTask, options: AgnesPollOptions) {
        polls += 1;
        assert.equal(initial.video_id, accepted.video_id);
        assert.equal(initial.status, "in_progress");
        const completed = task("completed", 100);
        await options.onPoll?.(completed);
        return { outcome: "completed" as const, task: completed };
      },
      async downloadCompletedVideo(_task: AgnesVideoTask, outputPath: string) {
        await mkdir(path.dirname(outputPath), { recursive: true });
        const bytes = Buffer.from("legacy-prompt-task-video");
        await writeFile(outputPath, bytes);
        return {
          outputPath,
          url: "https://media.example/legacy-task.mp4",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          contentType: "video/mp4",
        };
      },
    } as unknown as AgnesVideoClient;
    const bundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
    });

    const result = JSON.parse(String(
      await tool(bundle, VIDEO_TOOL_NAMES.generateVideo).invoke({}),
    )) as Record<string, unknown>;
    assert.equal(result.status, "completed");
    assert.equal(submissions, 0);
    assert.equal(polls, 1);
    const completed = await state.loadCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.providerJob?.requestDigest, legacyDigest);
    assert.equal(completed?.details?.agnesPromptRevision, 1);
    assert.equal(
      await readFile(path.join(runDirectory, "video", "source.mp4"), "utf8"),
      "legacy-prompt-task-video",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ambiguous pre-receipt checkpoint is logged and never automatically resubmitted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agnes-video-ambiguous-"));
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);
  let submissions = 0;
  try {
    await state.ensureManifest(PROMPT);
    await state.savePlan(PROMPT, plan());
    await state.startCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo, {
      provider: "agnes",
      model: "agnes-video-2.5-flash",
      details: { submissionIntent: "prepared" },
    });
    const bundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: { async submitVideo() { submissions += 1; return task("queued", 0); } } as unknown as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
    });
    const result = JSON.parse(String(await tool(bundle, VIDEO_TOOL_NAMES.generateVideo).invoke({}))) as Record<string, unknown>;
    assert.equal(result.status, "unknown");
    assert.equal(result.retrySafe, false);
    assert.equal(submissions, 0);
    assert.equal((await state.loadCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo))?.status, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh queue-full rejection is retry-safe and the next invocation submits again", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agnes-video-capacity-retry-"));
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);
  const events: VideoAgentEvent[] = [];
  let submissions = 0;

  try {
    await state.ensureManifest(PROMPT);
    await state.savePlan(PROMPT, plan());
    const rejected = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: {
        async submitVideo() {
          submissions += 1;
          throw new AgnesError("video queue is full, please retry later", {
            kind: "provider_capacity",
          });
        },
      } as unknown as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
      onEvent: (event) => events.push(event),
    });

    const failed = JSON.parse(String(
      await tool(rejected, VIDEO_TOOL_NAMES.generateVideo).invoke({}),
    )) as Record<string, unknown>;
    assert.equal(failed.status, "failed");
    assert.equal(failed.retrySafe, true);
    assert.equal(failed.retryOn, "next_invocation");
    const rejectedCheckpoint = await state.loadCheckpoint(
      PROMPT,
      videoCheckpointKeys.sourceVideo,
    );
    assert.equal(rejectedCheckpoint?.status, "failed");
    assert.equal(rejectedCheckpoint?.retrySafe, true);
    assert.equal(rejectedCheckpoint?.providerJob, undefined);

    const accepted = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: {
        async submitVideo(request: AgnesSubmitVideoRequest) {
          submissions += 1;
          request.onAttempt?.({ keyLabel: "key-1" });
          return task("queued", 0);
        },
        async pollUntilTerminal(initial: AgnesVideoTask) {
          return { outcome: "timed_out" as const, task: initial };
        },
      } as unknown as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
      onEvent: (event) => events.push(event),
    });
    const pending = JSON.parse(String(
      await tool(accepted, VIDEO_TOOL_NAMES.generateVideo).invoke({}),
    )) as Record<string, unknown>;
    assert.equal(pending.status, "pending");
    assert.equal(submissions, 2);
    const acceptedCheckpoint = await state.loadCheckpoint(
      PROMPT,
      videoCheckpointKeys.sourceVideo,
    );
    assert.equal(acceptedCheckpoint?.attempt, 2);
    assert.equal(acceptedCheckpoint?.providerJob?.videoId, "video-stable");
    assert.deepEqual(
      events
        .filter((event) => event.event === "video_submission_started")
        .map((event) => ({ attemptNumber: event.attemptNumber, resubmission: event.resubmission })),
      [
        { attemptNumber: 1, resubmission: false },
        { attemptNumber: 2, resubmission: true },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy unknown queue-full checkpoint is migrated and resubmitted once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agnes-video-capacity-migration-"));
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);
  const events: VideoAgentEvent[] = [];
  let submissions = 0;

  try {
    await state.ensureManifest(PROMPT);
    await state.savePlan(PROMPT, plan());
    await state.startCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo, {
      provider: "agnes",
      model: "agnes-video-2.5-flash",
      details: { submissionIntent: "prepared" },
    });
    await state.markUnknown(
      PROMPT,
      videoCheckpointKeys.sourceVideo,
      "video queue is full, please retry later",
    );

    const bundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: {
        async submitVideo() {
          submissions += 1;
          return task("queued", 0);
        },
        async pollUntilTerminal(initial: AgnesVideoTask) {
          return { outcome: "timed_out" as const, task: initial };
        },
      } as unknown as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
      onEvent: (event) => events.push(event),
    });
    const result = JSON.parse(String(
      await tool(bundle, VIDEO_TOOL_NAMES.generateVideo).invoke({}),
    )) as Record<string, unknown>;
    assert.equal(result.status, "pending");
    assert.equal(submissions, 1);
    const checkpoint = await state.loadCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo);
    assert.equal(checkpoint?.attempt, 2);
    assert.equal(checkpoint?.providerJob?.videoId, "video-stable");
    const submitted = events.find((event) => event.event === "video_submission_started");
    assert.equal(submitted?.event, "video_submission_started");
    if (submitted?.event === "video_submission_started") {
      assert.equal(submitted.attemptNumber, 2);
      assert.equal(submitted.resubmission, true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queued snapshot is explicitly visible in structured logs", async () => {
  const now = new Date().toISOString();
  const event = await videoSnapshotEvent({
    schemaVersion: 2,
    status: "queued",
    attempt: 1,
    provider: "agnes",
    model: "agnes-video-2.5-flash",
    providerStatus: "queued",
    providerJob: {
      schemaVersion: 2,
      provider: "agnes",
      id: "id-one",
      videoId: "video-one",
      taskId: "task-one",
      keyFingerprint: "b".repeat(64),
      keyLabel: "key-2",
      model: "agnes-video-2.5-flash",
      requestDigest: "c".repeat(64),
    },
    details: { progress: 7 },
    startedAt: now,
    updatedAt: now,
  });
  assert.equal(event?.event, "video_poll_result");
  if (event?.event === "video_poll_result") {
    assert.equal(event.status, "queued");
    assert.equal(event.progress, 7);
    assert.equal(event.videoId, "video-one");
  }

  const completedEvent = await videoSnapshotEvent({
    schemaVersion: 2,
    status: "in_progress",
    attempt: 1,
    provider: "agnes",
    model: "agnes-video-2.5-flash",
    providerStatus: "completed",
    providerJob: {
      schemaVersion: 2,
      provider: "agnes",
      id: "id-two",
      videoId: "video-two",
      taskId: "task-two",
      keyFingerprint: "d".repeat(64),
      keyLabel: "key-1",
      model: "agnes-video-2.5-flash",
      requestDigest: "e".repeat(64),
    },
    details: { progress: 100 },
    startedAt: now,
    updatedAt: now,
  });
  assert.equal(completedEvent?.event, "video_poll_result");
  if (completedEvent?.event === "video_poll_result") {
    assert.equal(completedEvent.status, "completed");
    assert.equal(completedEvent.progress, 100);
  }
});

test("music tool replaces a legacy track with logged Free.ai retries and a WAV checkpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "freeai-music-events-"));
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);
  const events: VideoAgentEvent[] = [];

  try {
    await state.ensureManifest(PROMPT);
    await state.savePlan(PROMPT, plan());
    await writeCurrentNativeForeground(state, PROMPT, runDirectory);
    const legacyMusicPath = path.join(runDirectory, "audio", "music.mp3");
    await mkdir(path.dirname(legacyMusicPath), { recursive: true });
    await writeFile(legacyMusicPath, "legacy-eleven-music");
    await state.startCheckpoint(PROMPT, videoCheckpointKeys.music, {
      provider: "elevenlabs",
      model: "music_v2",
    });
    await state.completeCheckpoint(PROMPT, videoCheckpointKeys.music, {
      path: legacyMusicPath,
      sha256: createHash("sha256").update("legacy-eleven-music").digest("hex"),
      durationSeconds: 4,
      provider: "elevenlabs",
      model: "music_v2",
    });

    let requests = 0;
    const freeAiMusic = {
      async generateMusic(request: FreeAiMusicRequest) {
        requests += 1;
        assert.equal(request.durationSeconds, 4);
        assert.equal(request.genre, "ambient");
        assert.equal(request.tempo, 84);
        assert.match(request.prompt, /Compose 10 seconds/i);
        assert.equal(request.outputPath, path.join(runDirectory, "audio", "music.wav"));
        request.onAttempt?.({
          phase: "generation",
          attemptNumber: 1,
          maxAttempts: 4,
          keyLabel: "key-1",
        });
        request.onAttempt?.({
          phase: "generation",
          attemptNumber: 2,
          maxAttempts: 4,
          keyLabel: "key-2",
        });
        await request.onSubmitted?.({
          url: "https://media.example/music.wav",
          externalId: "music-123",
          model: "ace-step",
          keyLabel: "key-2",
          generationAttempts: 2,
          providerDurationSeconds: 10,
        });
        request.onAttempt?.({ phase: "download", attemptNumber: 1, maxAttempts: 4 });
        await writeFile(request.outputPath, "free-ai-wav");
        return {
          filePath: request.outputPath,
          url: "https://media.example/music.wav",
          externalId: "music-123",
          model: "ace-step" as const,
          keyLabel: "key-2",
          generationAttempts: 2,
          downloadAttempts: 1,
          providerDurationSeconds: 10,
          contentType: "audio/wav",
        };
      },
    } as unknown as FreeAiMusicClient;
    const bundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic,
      validateMusicArtifact: async () => {},
      onEvent: (event) => events.push(event),
    });

    const result = JSON.parse(String(
      await tool(bundle, VIDEO_TOOL_NAMES.generateMusic).invoke({}),
    )) as Record<string, unknown>;
    assert.equal(result.status, "completed");
    assert.equal(result.model, "ace-step");
    assert.equal(result.generationAttempts, 2);
    assert.equal(requests, 1);

    const checkpoint = await state.loadCheckpoint(PROMPT, videoCheckpointKeys.music);
    assert.equal(checkpoint?.path, path.join(runDirectory, "audio", "music.wav"));
    assert.equal(checkpoint?.provider, "free.ai");
    assert.equal(checkpoint?.model, "ace-step");
    assert.equal(checkpoint?.details?.generationAttempts, 2);
    assert.equal(await readFile(checkpoint?.path as string, "utf8"), "free-ai-wav");
    assert.deepEqual(events.filter(({ event }) => event === "music_key_attempt"), [
      {
        event: "music_key_attempt",
        model: "ace-step",
        keyLabel: "key-1",
        attemptNumber: 1,
        maxAttempts: 4,
      },
      {
        event: "music_key_attempt",
        model: "ace-step",
        keyLabel: "key-2",
        attemptNumber: 2,
        maxAttempts: 4,
      },
    ]);
    assert.equal(events.some(({ event }) => event === "music_download_attempt"), true);
    assert.equal(events.some(({ event }) => event === "music_downloaded"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exhausted Free.ai music is durably omitted and never retried", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "freeai-music-resume-"));
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);
  let generations = 0;
  let laterCalls = 0;
  const events: VideoAgentEvent[] = [];

  try {
    await state.ensureManifest(PROMPT);
    await state.savePlan(PROMPT, plan());
    await writeCurrentNativeForeground(state, PROMPT, runDirectory);

    const firstClient = {
      async generateMusic(request: FreeAiMusicRequest) {
        generations += 1;
        await request.onSubmitted?.({
          url: "https://media.example/retained-music.wav",
          externalId: "music-retained",
          model: "ace-step",
          keyLabel: "key-3",
          generationAttempts: 1,
          providerDurationSeconds: 10,
        });
        throw new FreeAiMusicError("music CDN unavailable after four attempts", {
          kind: "download",
          retryExhausted: true,
        });
      },
    } as unknown as FreeAiMusicClient;
    const firstBundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: firstClient,
      onEvent: (event) => events.push(event),
    });
    const skipped = JSON.parse(String(
      await tool(firstBundle, VIDEO_TOOL_NAMES.generateMusic).invoke({}),
    )) as Record<string, unknown>;
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.foleyOnly, true);
    assert.match(String(skipped.instruction), /continue directly to final assembly/i);
    assert.equal(firstBundle.currentInvocationFailure(), null);
    assert.equal(events.some(({ event }) => event === "music_generation_failed"), true);
    assert.equal(events.some(({ event }) => event === "music_omitted"), true);

    // A stale non-empty deterministic file must not resurrect music after the
    // bounded download cycle selected the durable Foley-only fallback.
    await writeFile(path.join(runDirectory, "audio", "music.wav"), "stale-corrupt-audio");
    const omitted = await state.loadCheckpoint(PROMPT, videoCheckpointKeys.music);
    assert.equal(omitted?.status, "skipped");
    assert.equal(omitted?.url, undefined);
    assert.equal(omitted?.externalId, undefined);
    assert.equal(omitted?.details?.foleyOnlyFallback, true);

    const secondClient = {
      async generateMusic() {
        laterCalls += 1;
        throw new Error("durably skipped music must not be regenerated");
      },
      async downloadMusic() {
        laterCalls += 1;
        throw new Error("durably skipped music must not be downloaded");
      },
    } as unknown as FreeAiMusicClient;
    const secondBundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: secondClient,
    });
    const reusedSkip = JSON.parse(String(
      await tool(secondBundle, VIDEO_TOOL_NAMES.generateMusic).invoke({}),
    )) as Record<string, unknown>;

    assert.equal(reusedSkip.status, "skipped");
    assert.equal(reusedSkip.persisted, true);
    assert.equal(generations, 1);
    assert.equal(laterCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted accepted Free.ai URL resumes only its download", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "freeai-music-interrupted-"));
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);
  let generations = 0;
  let downloads = 0;

  try {
    await state.ensureManifest(PROMPT);
    await state.savePlan(PROMPT, plan());
    await writeCurrentNativeForeground(state, PROMPT, runDirectory);
    await state.startCheckpoint(PROMPT, videoCheckpointKeys.music, {
      provider: "free.ai",
      model: "ace-step",
    });
    await state.recordDownloadableMediaReceipt(PROMPT, videoCheckpointKeys.music, {
      url: "https://media.example/interrupted-music.wav",
      externalId: "music-interrupted",
      durationSeconds: 4,
      provider: "free.ai",
      model: "ace-step",
      details: { generationAttempts: 2, providerDurationSeconds: 10, keyLabel: "key-2" },
    });

    const freeAiMusic = {
      async generateMusic() {
        generations += 1;
        throw new Error("resume must not submit another generation");
      },
      async downloadMusic(request: FreeAiMusicDownloadRequest) {
        downloads += 1;
        assert.equal(request.url, "https://media.example/interrupted-music.wav");
        await writeFile(request.outputPath, "resumed-free-ai-wav");
        return {
          filePath: request.outputPath,
          url: request.url,
          downloadAttempts: 1,
          contentType: "audio/wav",
        };
      },
    } as unknown as FreeAiMusicClient;
    const bundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic,
      validateMusicArtifact: async () => {},
    });
    const result = JSON.parse(String(
      await tool(bundle, VIDEO_TOOL_NAMES.generateMusic).invoke({}),
    )) as Record<string, unknown>;

    assert.equal(result.status, "completed");
    assert.equal(generations, 0);
    assert.equal(downloads, 1);
    const checkpoint = await state.loadCheckpoint(PROMPT, videoCheckpointKeys.music);
    assert.equal(checkpoint?.status, "completed");
    assert.equal(checkpoint?.attempt, 2);
    assert.equal(checkpoint?.details?.downloadResumed, true);
    assert.equal(checkpoint?.details?.generationAttempts, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an atomically downloaded music file is adopted after a crash before checkpoint finalization", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "freeai-music-crash-window-"));
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);
  let providerCalls = 0;

  try {
    await state.ensureManifest(PROMPT);
    await state.savePlan(PROMPT, plan());
    await writeCurrentNativeForeground(state, PROMPT, runDirectory);
    await state.startCheckpoint(PROMPT, videoCheckpointKeys.music, {
      provider: "free.ai",
      model: "ace-step",
    });
    await state.recordDownloadableMediaReceipt(PROMPT, videoCheckpointKeys.music, {
      url: "https://media.example/already-downloaded.wav",
      externalId: "accepted-music-id",
      provider: "free.ai",
      model: "ace-step",
      durationSeconds: 4,
      details: { generationAttempts: 2, providerDurationSeconds: 10, keyLabel: "key-2" },
    });
    const musicPath = path.join(runDirectory, "audio", "music.wav");
    await writeFile(musicPath, "atomically-renamed-valid-wav");

    const restarted = new VideoRunStateStore(runDirectory);
    await restarted.ensureManifest(PROMPT);
    const freeAiMusic = {
      async generateMusic() {
        providerCalls += 1;
        throw new Error("must not regenerate an already downloaded track");
      },
      async downloadMusic() {
        providerCalls += 1;
        throw new Error("must not redownload an already downloaded track");
      },
    } as unknown as FreeAiMusicClient;
    const bundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: restarted,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic,
      validateMusicArtifact: async ({ inputPath, minimumDurationSeconds }) => {
        assert.equal(inputPath, musicPath);
        assert.equal(minimumDurationSeconds, 4);
      },
    });

    const result = JSON.parse(String(
      await tool(bundle, VIDEO_TOOL_NAMES.generateMusic).invoke({}),
    )) as Record<string, unknown>;
    assert.equal(result.status, "recovered");
    assert.equal(result.providerRequestRepeated, false);
    assert.equal(result.downloadRepeated, false);
    assert.equal(providerCalls, 0);
    const checkpoint = await restarted.loadCheckpoint(PROMPT, videoCheckpointKeys.music);
    assert.equal(checkpoint?.status, "completed");
    assert.equal(checkpoint?.externalId, "accepted-music-id");
    assert.equal(checkpoint?.details?.recoveredFromLocalArtifact, true);
    assert.equal(checkpoint?.details?.mediaValidated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed generic-content music download is durably omitted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "freeai-invalid-music-"));
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);

  try {
    await state.ensureManifest(PROMPT);
    await state.savePlan(PROMPT, plan());
    await writeCurrentNativeForeground(state, PROMPT, runDirectory);
    const musicPath = path.join(runDirectory, "audio", "music.wav");
    const freeAiMusic = {
      async generateMusic(request: FreeAiMusicRequest) {
        await request.onSubmitted?.({
          url: "https://media.example/not-really-audio",
          externalId: "invalid-audio-id",
          model: "ace-step",
          keyLabel: "key-1",
          generationAttempts: 1,
          providerDurationSeconds: 10,
        });
        await writeFile(request.outputPath, "<html>temporary provider error</html>");
        return {
          filePath: request.outputPath,
          url: "https://media.example/not-really-audio",
          externalId: "invalid-audio-id",
          model: "ace-step" as const,
          keyLabel: "key-1",
          generationAttempts: 1,
          downloadAttempts: 1,
          providerDurationSeconds: 10,
          contentType: "application/octet-stream",
        };
      },
    } as unknown as FreeAiMusicClient;
    const bundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic,
      validateMusicArtifact: async () => {
        throw new Error("FFprobe found no audio stream");
      },
    });

    const result = JSON.parse(String(
      await tool(bundle, VIDEO_TOOL_NAMES.generateMusic).invoke({}),
    )) as Record<string, unknown>;
    assert.equal(result.status, "skipped");
    assert.equal(result.foleyOnly, true);
    assert.equal(bundle.currentInvocationFailure(), null);
    await assert.rejects(readFile(musicPath), /ENOENT/);
    const checkpoint = await state.loadCheckpoint(PROMPT, videoCheckpointKeys.music);
    assert.equal(checkpoint?.status, "skipped");
    assert.match(checkpoint?.error ?? "", /unusable music file/i);
    assert.equal(checkpoint?.details?.optionalArtifactOmitted, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YouTube tool uploads all locked generated metadata with trusted policy settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "youtube-metadata-tool-"));
  const uploadPrompt = bindYouTubeUploadAuthorization("Create a red kite video.", true);
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(uploadPrompt);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);
  const events: VideoAgentEvent[] = [];
  let captured: Parameters<YouTubeUploader["upload"]>[0] | undefined;

  try {
    await state.ensureManifest(uploadPrompt);
    await state.savePlan(uploadPrompt, {
      ...plan(),
      youtubeUpload: {
        requested: true,
        title: "The Red Kite's Final Climb",
        description: "A short AI-generated cinematic story about a red kite mastering the wind.",
        tags: ["red kite", "cinematic short", "wind", "AI video", "visual story"],
        categoryId: "24",
        privacyStatus: "private",
        madeForKids: false,
      },
    });
    const finalPath = path.join(runDirectory, "final-1.mp4");
    await mkdir(runDirectory, { recursive: true });
    await writeValidFinalVideo(finalPath);
    await state.startCheckpoint(uploadPrompt, videoCheckpointKeys.assembly, {
      provider: "local",
      model: "ffmpeg-static",
    });
    await state.completeCheckpoint(uploadPrompt, videoCheckpointKeys.assembly, {
      path: finalPath,
      sha256: await sha256File(finalPath),
      durationSeconds: 4,
      details: currentFinalDetails(),
    });

    const uploader: YouTubeUploader = {
      async upload(input) {
        captured = input;
        return {
          videoId: "youtube-video-123",
          url: "https://youtu.be/youtube-video-123",
          privacyStatus: "private",
        };
      },
    };
    const bundle = createVideoAgentTools({
      originalPrompt: uploadPrompt,
      runDirectory,
      config: loadConfig({
        YOUTUBE_DEFAULT_PRIVACY: "private",
        YOUTUBE_DEFAULT_MADE_FOR_KIDS: "false",
        YOUTUBE_DEFAULT_CONTAINS_SYNTHETIC_MEDIA: "true",
      }),
      stateStore: state,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
      youtube: { uploader, authorizationToken: "tool-authorization-token" },
      onEvent: (event) => events.push(event),
    });
    const result = JSON.parse(String(
      await tool(bundle, VIDEO_TOOL_NAMES.youtubeUpload).invoke({}),
    )) as Record<string, unknown>;

    assert.equal(result.status, "completed");
    assert.equal(captured?.title, "The Red Kite's Final Climb");
    assert.match(captured?.description ?? "", /AI-generated cinematic story/);
    assert.deepEqual(captured?.tags, ["red kite", "cinematic short", "wind", "AI video", "visual story"]);
    assert.equal(captured?.categoryId, "24");
    assert.equal(captured?.privacyStatus, "private");
    assert.equal(captured?.selfDeclaredMadeForKids, false);
    assert.equal(captured?.containsSyntheticMedia, true);
    assert.equal(captured?.notifySubscribers, false);
    assert.equal(captured?.authorization.confirmed, true);
    assert.equal(captured?.authorization.token, "tool-authorization-token");
    assert.equal(events.some(({ event }) => event === "youtube_upload_started"), true);
    assert.equal(events.some(({ event }) => event === "youtube_upload_completed"), true);
    const checkpoint = await state.loadCheckpoint(uploadPrompt, videoCheckpointKeys.youtubeUpload);
    assert.equal(checkpoint?.status, "completed");
    assert.equal(checkpoint?.externalId, "youtube-video-123");
    assert.equal(checkpoint?.details?.categoryId, "24");
    assert.deepEqual(checkpoint?.details?.tags, captured?.tags);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ambiguous YouTube transport outcome is never uploaded again in-process or after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "youtube-ambiguous-tool-"));
  const uploadPrompt = bindYouTubeUploadAuthorization("Create a red kite video.", true);
  const runId = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(uploadPrompt);
  const runDirectory = path.join(root, runId);
  const state = new VideoRunStateStore(runDirectory);
  let uploadCalls = 0;

  try {
    await state.ensureManifest(uploadPrompt);
    await state.savePlan(uploadPrompt, {
      ...plan(),
      youtubeUpload: {
        requested: true,
        title: "The Red Kite's Final Climb",
        description: "A short AI-generated cinematic story about a red kite mastering the wind.",
        tags: ["red kite", "cinematic short", "wind", "AI video", "visual story"],
        categoryId: "24",
        privacyStatus: "private",
        madeForKids: false,
      },
    });
    const finalPath = path.join(runDirectory, "final-1.mp4");
    await mkdir(runDirectory, { recursive: true });
    await writeValidFinalVideo(finalPath);
    await state.startCheckpoint(uploadPrompt, videoCheckpointKeys.assembly, {
      provider: "local",
      model: "ffmpeg-static",
    });
    await state.completeCheckpoint(uploadPrompt, videoCheckpointKeys.assembly, {
      path: finalPath,
      sha256: await sha256File(finalPath),
      durationSeconds: 4,
      details: currentFinalDetails(),
    });

    const uploader: YouTubeUploader = {
      async upload() {
        uploadCalls += 1;
        throw new YouTubeUploadError("Connection closed before the response", {
          ambiguousOutcome: true,
        });
      },
    };
    const createBundle = (store: VideoRunStateStore) => createVideoAgentTools({
      originalPrompt: uploadPrompt,
      runDirectory,
      config: loadConfig({}),
      stateStore: store,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
      youtube: { uploader, authorizationToken: "tool-authorization-token" },
    });

    const firstBundle = createBundle(state);
    const first = JSON.parse(String(
      await tool(firstBundle, VIDEO_TOOL_NAMES.youtubeUpload).invoke({}),
    )) as Record<string, unknown>;
    assert.equal(first.status, "unknown");
    assert.equal(first.retrySafe, false);
    assert.equal(first.ambiguousOutcome, true);
    assert.equal(uploadCalls, 1);
    let checkpoint = await state.loadCheckpoint(uploadPrompt, videoCheckpointKeys.youtubeUpload);
    assert.equal(checkpoint?.status, "unknown");
    assert.equal(checkpoint?.retrySafe, false);
    assert.equal(checkpoint?.details?.manualReconciliationRequired, true);
    assert.equal((await state.loadManifest(uploadPrompt))?.status, "failed");

    await tool(firstBundle, VIDEO_TOOL_NAMES.youtubeUpload).invoke({});
    assert.equal(uploadCalls, 1);

    const restarted = new VideoRunStateStore(runDirectory);
    const secondBundle = createBundle(restarted);
    const resumed = JSON.parse(String(
      await tool(secondBundle, VIDEO_TOOL_NAMES.youtubeUpload).invoke({}),
    )) as Record<string, unknown>;
    assert.equal(resumed.status, "unknown");
    assert.equal(resumed.retrySafe, false);
    assert.equal(uploadCalls, 1);
    checkpoint = await restarted.loadCheckpoint(uploadPrompt, videoCheckpointKeys.youtubeUpload);
    assert.equal(checkpoint?.status, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
