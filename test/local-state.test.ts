import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashUserPrompt } from "freetier-deepagent-framework";

import { VideoPlanSchema, type VideoPlan } from "../src/agent/videoPlan.js";
import { loadConfig } from "../src/config.js";
import { finalVideoArtifactPaths } from "../src/final-video.js";
import { AUDIO_MIX_REVISION, SOURCE_AUDIO_INSPECTION_REVISION } from "../src/media/index.js";
import {
  VideoRunStateStore,
  videoCheckpointKeys,
  type PersistedProviderJob,
} from "../src/state/index.js";
import {
  AGNES_NATIVE_AUDIO_MODEL,
  cleanupValidatedRunArtifacts,
  recoverInterruptedLocalAssembly,
  resetInterruptedFoleyAggregation,
  resetInterruptedLocalAssembly,
  type FinalArtifactDependencies,
} from "../src/tools/videoAgentTools.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function agnesReceipt(overrides: Partial<PersistedProviderJob> = {}): PersistedProviderJob {
  return {
    schemaVersion: 2,
    provider: "agnes",
    id: "task-agnes-123",
    videoId: "video-agnes-123",
    taskId: "task-agnes-123",
    keyFingerprint: SHA_A,
    keyLabel: "key-2",
    model: "agnes-video-2.5-flash",
    requestDigest: SHA_B,
    ...overrides,
  };
}

function continuousPlan(musicEnabled = true): VideoPlan {
  const timelineBeats = [
    {
      beatId: "setup",
      startSeconds: 0,
      endSeconds: 4,
      narrativePurpose: "Establish the batsman, delivery, stadium, and the impending strike.",
      visualAction: "The bowler releases the ball and the batsman plants his front foot for the shot.",
      cameraDirection: "Track laterally at waist height while keeping the bat and ball clearly visible.",
      composition: "Medium-wide stadium view with the batsman dominant and the crowd behind him.",
    },
    {
      beatId: "payoff",
      startSeconds: 4,
      endSeconds: 8,
      narrativePurpose: "Complete the strike, ball flight, boundary clearance, and crowd reaction.",
      visualAction: "The bat sends the ball over the rope as the batsman follows through and the crowd celebrates.",
      cameraDirection: "Continue the same lateral move, then tilt gently to follow the ball over the rope.",
      composition: "Keep the batsman foregrounded while revealing the ball path and cheering grandstand.",
    },
  ] as const;

  return VideoPlanSchema.parse({
    schemaVersion: 2,
    concept: "A batsman strikes a cricket ball over the boundary as the crowd celebrates.",
    creativeScript:
      "A bowler delivers toward one focused batsman. The batsman steps into a clean lofted drive, the ball rises over the boundary rope, and the packed crowd erupts while the camera follows the complete action without a cut.",
    totalDurationSeconds: 8,
    continuityBible: {
      id: "continuous-cricket",
      visualStyle: "Cinematic sports realism with crisp natural motion and restrained depth of field.",
      subjects: [{
        id: "batsman",
        role: "primary",
        invariantAppearance: "The same athletic right-handed batsman with a navy helmet and white uniform.",
        wardrobeOrSurface: "Plain white cricket uniform, navy helmet, gloves, and batting pads.",
        props: ["one unmarked wooden bat", "one white cricket ball"],
        identityAnchors: ["navy helmet", "plain white uniform", "white batting pads"],
      }],
      environment: {
        location: "The center pitch of one packed outdoor cricket stadium with a boundary rope.",
        backgroundAnchors: ["packed grandstand", "green outfield", "white boundary rope"],
        timeOfDay: "Clear late afternoon",
        weatherOrAtmosphere: "Dry still air with consistent natural daylight",
      },
      lighting: "Warm late-afternoon light from frame left with one stable shadow direction.",
      colorPalette: ["grass green", "uniform white", "helmet navy", "warm sunlight"],
      cameraLanguage: "One smooth lateral tracking take with a fixed medium telephoto lens.",
      supportingAnchors: ["the same packed crowd", "the same boundary rope", "the same pitch markings"],
      negativeConstraints: ["no identity drift", "no duplicate ball", "no text or watermark"],
    },
    visualPrompt:
      "One uninterrupted cinematic cricket take: follow the same right-handed batsman as the delivery arrives, the bat makes a clean lofted strike, the white ball clears the rope, and the same packed crowd reacts under stable late-afternoon light.",
    cameraMotion: "slow pan right",
    cameraDirection: "Use one smooth rightward tracking pan, preserving lens, exposure, and screen direction.",
    negativePrompt: "No cuts, identity drift, duplicate ball, warped bat, text, logo, or watermark.",
    timelineBeats,
    foleyCues: [],
    music: musicEnabled
      ? {
          enabled: true,
          prompt: "A restrained cinematic sports underscore that builds gently toward the boundary-shot payoff.",
          negativePrompt: "No vocals, crowd, impacts, bat sounds, or distracting heavy bass.",
          genre: "cinematic orchestral",
          mood: "Focused anticipation resolving into warm triumph",
          role: "background",
          tempoBpm: 104,
          syncStrategy: "Build quietly through setup and lift only after the visible boundary clearance.",
          durationSeconds: 8,
          beats: timelineBeats.map(({ beatId, startSeconds, endSeconds }) => ({
            beatId,
            startSeconds,
            endSeconds,
            direction: beatId === "setup"
              ? "Sparse pulse and soft strings create restrained anticipation under the foreground effects."
              : "A modest harmonic lift supports the payoff without masking the crowd or impact sounds.",
          })),
        }
      : {
          enabled: false,
          reason: "The prompt explicitly requests foreground sound effects without background music.",
        },
    delivery: {
      visualStyle: "cinematic",
      aspectRatio: "16:9",
      width: 1280,
      height: 704,
      fps: 24,
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
    },
  });
}

test("persists an accepted Agnes receipt and updates the same task while polling", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "video-agnes-state-"));
  try {
    const prompt = "Create a continuous cricket video.";
    const runDirectory = path.join(temporaryRoot, hashUserPrompt(prompt));
    await mkdir(runDirectory);
    const state = new VideoRunStateStore(runDirectory);
    const key = videoCheckpointKeys.sourceVideo;
    const rawKey = "agnes-secret-that-must-not-be-persisted";
    const receipt = agnesReceipt({
      keyFingerprint: createHash("sha256").update(rawKey).digest("hex"),
    });

    await state.ensureManifest(prompt);
    await state.startCheckpoint(prompt, key, {
      provider: "agnes",
      model: "agnes-video-2.5-flash",
      details: { submissionIntent: "prepared", requestDigest: receipt.requestDigest },
    });
    const queued = await state.updateProviderJobCheckpoint(prompt, key, {
      providerJob: receipt,
      providerStatus: "queued",
      progress: 0,
      details: { submissionIntent: "accepted" },
    });
    assert.equal(queued.status, "queued");
    assert.equal(queued.externalId, receipt.videoId);
    assert.deepEqual(queued.providerJob, receipt);
    assert.equal((await state.loadManifest(prompt))?.status, "pending");
    await assert.rejects(
      state.startCheckpoint(prompt, key, { provider: "agnes" }),
      /refusing a concurrent or duplicate start/,
    );

    const restarted = new VideoRunStateStore(runDirectory);
    const restored = await restarted.loadCheckpoint(prompt, key);
    assert.equal(restored?.providerJob?.id, "task-agnes-123");
    assert.equal(restored?.providerJob?.taskId, "task-agnes-123");
    assert.equal(restored?.providerJob?.videoId, "video-agnes-123");
    assert.equal(restored?.providerJob?.keyFingerprint, receipt.keyFingerprint);

    const rendering = await restarted.updateProviderJobCheckpoint(prompt, key, {
      providerJob: receipt,
      providerStatus: "in_progress",
      progress: 47,
    });
    assert.equal(rendering.status, "in_progress");
    assert.equal(rendering.providerStatus, "in_progress");
    assert.equal(rendering.details?.progress, 47);
    assert.equal(rendering.attempt, 1);
    assert.deepEqual(rendering.providerJob, receipt);

    const serialized = await readFile(path.join(runDirectory, "pipeline-state.json"), "utf8");
    assert.doesNotMatch(serialized, new RegExp(rawKey));
    assert.match(serialized, new RegExp(receipt.keyFingerprint));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("adopts only the deterministic single-render video, global Foley, and music artifacts", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "video-agnes-adoption-"));
  try {
    const prompt = "Create a continuous cricket video with a restrained score.";
    const runDirectory = path.join(temporaryRoot, hashUserPrompt(prompt));
    await mkdir(path.join(runDirectory, "video"), { recursive: true });
    await mkdir(path.join(runDirectory, "audio"), { recursive: true });
    await writeFile(path.join(runDirectory, "plan.json"), `${JSON.stringify(continuousPlan(true), null, 2)}\n`);
    const sourcePath = path.join(runDirectory, "video", "source.mp4");
    const foleyPath = path.join(runDirectory, "audio", "foley-mix.wav");
    const musicPath = path.join(runDirectory, "audio", "music.wav");
    await writeFile(sourcePath, "single-agnes-render");
    await writeFile(foleyPath, "global-timed-foley");
    await writeFile(musicPath, "free-ai-music");
    await mkdir(path.join(runDirectory, "scenes"));
    await writeFile(path.join(runDirectory, "scenes", "scene-1.mp4"), "legacy-scene");

    const state = new VideoRunStateStore(runDirectory);
    const manifest = await state.ensureManifest(prompt);
    assert.equal(manifest.planStored, true);

    const source = await state.loadCheckpoint(prompt, videoCheckpointKeys.sourceVideo);
    const foley = await state.loadCheckpoint(prompt, videoCheckpointKeys.foley);
    const music = await state.loadCheckpoint(prompt, videoCheckpointKeys.music);
    assert.equal(source?.path, sourcePath);
    assert.equal(source?.durationSeconds, 8);
    assert.equal(source?.provider, "agnes");
    assert.equal(source?.model, "agnes-video-2.5-flash");
    assert.equal(source?.details?.recoveredFromLocalArtifact, true);
    assert.equal(foley?.path, foleyPath);
    assert.equal(foley?.provider, "elevenlabs+local");
    assert.equal(foley?.details?.globalTimeline, true);
    assert.equal(music?.path, musicPath);
    assert.equal(music?.provider, "free.ai");
    assert.equal(music?.model, "ace-step");

    assert.deepEqual(
      new Set((await state.listCheckpoints(prompt)).map(({ key }) => key)),
      new Set([
        videoCheckpointKeys.sourceVideo,
        videoCheckpointKeys.foley,
        videoCheckpointKeys.music,
      ]),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("a durable optional-music skip survives restart and blocks stale artifact adoption", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "video-music-skip-"));
  try {
    const prompt = "Create a continuous cricket video with best-effort background music.";
    const runDirectory = path.join(temporaryRoot, hashUserPrompt(prompt));
    const state = new VideoRunStateStore(runDirectory);
    await state.ensureManifest(prompt);
    await state.savePlan(prompt, continuousPlan(true));
    await state.startCheckpoint(prompt, videoCheckpointKeys.music, {
      provider: "free.ai",
      model: "ace-step",
    });
    await state.recordDownloadableMediaReceipt(prompt, videoCheckpointKeys.music, {
      url: "https://media.example/music.wav",
      externalId: "music-generated",
      durationSeconds: 8,
      provider: "free.ai",
      model: "ace-step",
    });
    const skipped = await state.skipCheckpoint(
      prompt,
      videoCheckpointKeys.music,
      "Free.ai music download remained unavailable after four attempts.",
      { foleyOnlyFallback: true, retriesExhausted: true },
    );
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.url, undefined);
    assert.equal(skipped.externalId, undefined);
    assert.equal(skipped.retrySafe, false);

    const staleMusicPath = path.join(runDirectory, "audio", "music.wav");
    await mkdir(path.dirname(staleMusicPath), { recursive: true });
    await writeFile(staleMusicPath, "stale-or-partial-music");
    const restarted = new VideoRunStateStore(runDirectory);
    const restored = await restarted.loadCheckpoint(prompt, videoCheckpointKeys.music);
    assert.equal(restored?.status, "skipped");
    assert.equal(restored?.path, undefined);
    assert.equal(restored?.details?.optionalArtifactOmitted, true);
    assert.equal(restored?.details?.foleyOnlyFallback, true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("a stale Foley file cannot overwrite an active native-audio selection", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "video-native-selection-"));
  try {
    const prompt = "Create a continuous video with native animal sounds.";
    const runDirectory = path.join(temporaryRoot, hashUserPrompt(prompt));
    await mkdir(path.join(runDirectory, "audio"), { recursive: true });
    await writeFile(
      path.join(runDirectory, "plan.json"),
      `${JSON.stringify(continuousPlan(true), null, 2)}\n`,
    );
    await writeFile(path.join(runDirectory, "audio", "foley-mix.wav"), "stale-foley");

    const state = new VideoRunStateStore(runDirectory);
    await state.ensureManifest(prompt);
    assert.equal(
      (await state.loadCheckpoint(prompt, videoCheckpointKeys.foley))?.provider,
      "elevenlabs+local",
    );

    await state.startCheckpoint(prompt, videoCheckpointKeys.foley, {
      provider: "agnes",
      model: AGNES_NATIVE_AUDIO_MODEL,
      details: { foregroundAudioMode: "agnes_native" },
    });
    const active = await state.loadCheckpoint(prompt, videoCheckpointKeys.foley);
    assert.equal(active?.status, "in_progress");
    assert.equal(active?.provider, "agnes");
    assert.equal(active?.model, AGNES_NATIVE_AUDIO_MODEL);

    const skipped = await state.skipCheckpoint(
      prompt,
      videoCheckpointKeys.foley,
      "Usable native audio selected.",
      { foregroundAudioMode: "agnes_native", nativeSourceAudioSelected: true },
    );
    assert.equal(skipped.provider, "agnes");
    assert.equal(skipped.model, AGNES_NATIVE_AUDIO_MODEL);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("an uncheckpointed partial final is never auto-adopted", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "video-partial-final-"));
  try {
    const prompt = "Create a continuous video of ocean waves.";
    const runDirectory = path.join(temporaryRoot, hashUserPrompt(prompt));
    await mkdir(runDirectory);
    const namedFinal = finalVideoArtifactPaths(runDirectory, prompt, 99).outputPath;
    await writeFile(namedFinal, "partial ffmpeg output");
    await writeFile(path.join(runDirectory, "final-98.mp4"), "legacy partial ffmpeg output");
    const state = new VideoRunStateStore(runDirectory);
    await state.ensureManifest(prompt);
    assert.equal(await state.loadCheckpoint(prompt, videoCheckpointKeys.assembly), null);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("an interrupted Foley aggregate resets while completed cue assets remain reusable", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "video-foley-interrupted-"));
  try {
    const prompt = "Create a continuous cricket video.";
    const runDirectory = path.join(temporaryRoot, hashUserPrompt(prompt));
    const state = new VideoRunStateStore(runDirectory);
    await state.ensureManifest(prompt);
    await state.savePlan(prompt, continuousPlan(true));
    const started = await state.startCheckpoint(prompt, videoCheckpointKeys.foley, {
      provider: "elevenlabs+local",
      model: "eleven_text_to_sound_v2+ffmpeg",
    });
    const cuePath = path.join(runDirectory, "audio", "foley-cues", "retained-cue.mp3");
    const mixPath = path.join(runDirectory, "audio", "foley-mix.wav");
    await mkdir(path.dirname(cuePath), { recursive: true });
    await writeFile(cuePath, "completed-cue");
    await writeFile(mixPath, "partial-mix");

    const reset = await resetInterruptedFoleyAggregation({
      stateStore: state,
      originalPrompt: prompt,
      runDirectory,
      checkpoint: started,
    });
    assert.equal(reset?.status, "failed");
    assert.equal(reset?.retrySafe, true);
    assert.equal(reset?.details?.interruptedFoleyAggregationRecovered, true);
    await assert.rejects(access(mixPath), /ENOENT/);
    assert.equal(await readFile(cuePath, "utf8"), "completed-cue");

    const resumed = await state.startCheckpoint(prompt, videoCheckpointKeys.foley, {
      provider: "elevenlabs+local",
      model: "eleven_text_to_sound_v2+ffmpeg",
    });
    assert.equal(resumed.status, "in_progress");
    assert.equal(resumed.attempt, 2);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("a lost synchronous ElevenLabs response becomes retryable on a later invocation", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "video-foley-ambiguous-"));
  try {
    const prompt = "Create a continuous sports video.";
    const runDirectory = path.join(temporaryRoot, hashUserPrompt(prompt));
    const state = new VideoRunStateStore(runDirectory);
    await state.ensureManifest(prompt);
    await state.savePlan(prompt, continuousPlan(true));
    await state.startCheckpoint(prompt, videoCheckpointKeys.foley, {
      provider: "elevenlabs+local",
      model: "eleven_text_to_sound_v2+ffmpeg",
    });
    const unknown = await state.markUnknown(
      prompt,
      videoCheckpointKeys.foley,
      "Provider response was lost.",
    );
    const cuePath = path.join(runDirectory, "audio", "foley-cues", "retained-cue.mp3");
    await mkdir(path.dirname(cuePath), { recursive: true });
    await writeFile(cuePath, "completed-cue");

    const reset = await resetInterruptedFoleyAggregation({
      stateStore: state,
      originalPrompt: prompt,
      runDirectory,
      checkpoint: unknown,
    });

    assert.equal(reset?.status, "failed");
    assert.equal(reset?.retrySafe, true);
    assert.equal(reset?.details?.ambiguousFoleyResponseRetriedOnLaterInvocation, true);
    assert.equal(await readFile(cuePath, "utf8"), "completed-cue");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("an interrupted local assembly removes its prompt-named staging and published paths plus its legacy attempt", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "video-assembly-interrupted-"));
  try {
    const prompt = "Create a continuous cricket video.";
    const runDirectory = path.join(temporaryRoot, hashUserPrompt(prompt));
    const state = new VideoRunStateStore(runDirectory);
    await state.ensureManifest(prompt);
    await state.savePlan(prompt, continuousPlan(true));
    const started = await state.startCheckpoint(prompt, videoCheckpointKeys.assembly, {
      provider: "local",
      model: "ffmpeg-static",
    });
    const { outputPath, partialPath } = finalVideoArtifactPaths(
      runDirectory,
      prompt,
      started.attempt,
    );
    const legacyPath = path.join(runDirectory, `final-${started.attempt}.mp4`);
    const unrelatedPath = path.join(runDirectory, "notes.txt");
    await writeFile(outputPath, "published-before-checkpoint-crash");
    await writeFile(partialPath, "partial-final");
    await writeFile(legacyPath, "legacy-partial-final");
    await writeFile(unrelatedPath, "keep-me");

    const reset = await resetInterruptedLocalAssembly({
      stateStore: state,
      originalPrompt: prompt,
      runDirectory,
      checkpoint: started,
    });
    assert.equal(reset?.status, "failed");
    assert.equal(reset?.retrySafe, true);
    assert.equal(reset?.details?.interruptedLocalAssemblyRecovered, true);
    await assert.rejects(access(outputPath), /ENOENT/);
    await assert.rejects(access(partialPath), /ENOENT/);
    await assert.rejects(access(legacyPath), /ENOENT/);
    assert.equal(await readFile(unrelatedPath, "utf8"), "keep-me");

    const resumed = await state.startCheckpoint(prompt, videoCheckpointKeys.assembly, {
      provider: "local",
      model: "ffmpeg-static",
    });
    assert.equal(resumed.status, "in_progress");
    assert.equal(resumed.attempt, 2);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("a validated prompt-named staging file resumes without another FFmpeg render", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "video-assembly-recovery-"));
  try {
    const prompt = "Create a video of a romantic sunset over a quiet lake with no background music.";
    const runDirectory = path.join(temporaryRoot, hashUserPrompt(prompt));
    const state = new VideoRunStateStore(runDirectory);
    const plan = continuousPlan(false);
    const config = loadConfig({});
    const dependencies: FinalArtifactDependencies = {
      foregroundAudioMode: "agnes_native",
      sourceVideoSha256: SHA_A,
      sourceAudioAnalysisSha256: SHA_B,
      foleySha256: null,
      reconciliationSha256: null,
      musicDependencyStatus: "disabled",
      musicSha256: null,
    };
    await state.ensureManifest(prompt);
    await state.savePlan(prompt, plan);
    const started = await state.startCheckpoint(prompt, videoCheckpointKeys.assembly, {
      provider: "local",
      model: "ffmpeg-static",
      details: {
        audioMixRevision: AUDIO_MIX_REVISION,
        sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
        sourceVideoSha256: dependencies.sourceVideoSha256,
        sourceAudioAnalysisSha256: dependencies.sourceAudioAnalysisSha256,
        foregroundAudioMode: dependencies.foregroundAudioMode,
        foleySha256: null,
        foleyReconciliationRevision: null,
        foleyReconciliationSha256: null,
        musicDependencyStatus: "disabled",
        musicSha256: null,
        backgroundMusicRequested: false,
        backgroundMusicIncluded: false,
        foleyOnlyFallback: false,
        musicVolume: config.VIDEO_MUSIC_VOLUME,
        foleyVolume: config.VIDEO_FOLEY_VOLUME,
      },
    });
    const { outputPath, partialPath } = finalVideoArtifactPaths(
      runDirectory,
      prompt,
      started.attempt,
    );
    await writeFile(partialPath, "already-validated-staging-video");
    let validations = 0;
    const recovered = await recoverInterruptedLocalAssembly({
      stateStore: state,
      originalPrompt: prompt,
      runDirectory,
      checkpoint: started,
      config,
      plan,
      expectedDependencies: dependencies,
      validateVideoArtifact: async (input) => {
        validations += 1;
        assert.equal(input.outputPath, partialPath);
        return {
          outputPath: input.outputPath,
          durationSeconds: 8,
          width: 1280,
          height: 704,
          fps: 24,
          videoCodec: "h264",
          audioCodec: "aac",
          audioSampleRate: 48_000,
          audioChannels: 2,
        };
      },
    });

    assert.equal(validations, 1);
    assert.equal(recovered?.source, "staging_output");
    assert.equal(recovered?.checkpoint.status, "completed");
    assert.equal(recovered?.checkpoint.path, outputPath);
    assert.equal(await readFile(outputPath, "utf8"), "already-validated-staging-video");
    await assert.rejects(access(partialPath), /ENOENT/);
    assert.equal((await state.loadManifest(prompt))?.status, "completed");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("a retained final cannot mask newly started Foley reconciliation", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "video-stale-final-status-"));
  try {
    const prompt = "Create a continuous cricket video.";
    const runDirectory = path.join(temporaryRoot, hashUserPrompt(prompt));
    const state = new VideoRunStateStore(runDirectory);
    await state.ensureManifest(prompt);
    await state.savePlan(prompt, continuousPlan(true));

    await state.startCheckpoint(prompt, videoCheckpointKeys.assembly, {
      provider: "local",
      model: "ffmpeg-static",
    });
    await state.completeCheckpoint(prompt, videoCheckpointKeys.assembly, {
      path: path.join(runDirectory, "final-1.mp4"),
      sha256: SHA_A,
      durationSeconds: 8,
      provider: "local",
      model: "ffmpeg-static",
    });
    assert.equal((await state.ensureManifest(prompt)).status, "completed");

    await state.startCheckpoint(prompt, videoCheckpointKeys.foley, {
      provider: "elevenlabs+local",
      model: "eleven_text_to_sound_v2+ffmpeg",
    });
    assert.equal((await state.loadManifest(prompt))?.status, "generating");

    await state.markUnknown(
      prompt,
      videoCheckpointKeys.foley,
      "The synchronous provider response was lost.",
    );
    assert.equal((await state.ensureManifest(prompt)).status, "generating");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("cleanup retains artifacts by default and removes them only through the explicit gate", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "video-cleanup-gate-"));
  try {
    const prompt = "Create a continuous cricket video.";
    const runDirectory = path.join(temporaryRoot, hashUserPrompt(prompt));
    const videoDirectory = path.join(runDirectory, "video");
    const audioDirectory = path.join(runDirectory, "audio");
    const analysisDirectory = path.join(runDirectory, "analysis");
    await mkdir(videoDirectory, { recursive: true });
    await mkdir(audioDirectory, { recursive: true });
    await mkdir(analysisDirectory, { recursive: true });
    const sourcePath = path.join(videoDirectory, "source.mp4");
    const foleyPath = path.join(audioDirectory, "foley-mix.wav");
    const musicPath = path.join(audioDirectory, "music.wav");
    const finalPath = path.join(runDirectory, "final-1.mp4");
    const oldFinalPath = path.join(runDirectory, "final-0.mp4");
    const supersededNamedFinal = finalVideoArtifactPaths(runDirectory, prompt, 2).outputPath;
    const supersededNamedPartial = finalVideoArtifactPaths(runDirectory, prompt, 3).partialPath;
    const analysisPath = path.join(analysisDirectory, "observed-foley-plan.json");
    await writeFile(sourcePath, "source");
    await writeFile(foleyPath, "foley");
    await writeFile(musicPath, "music");
    await writeFile(finalPath, "final");
    await writeFile(oldFinalPath, "old-final");
    await writeFile(supersededNamedFinal, "superseded-named-final");
    await writeFile(supersededNamedPartial, "superseded-named-partial");
    await writeFile(analysisPath, "analysis");

    const state = new VideoRunStateStore(runDirectory);
    await state.ensureManifest(prompt);
    const receipt = agnesReceipt();
    await state.startCheckpoint(prompt, videoCheckpointKeys.sourceVideo, {
      provider: "agnes",
      model: receipt.model,
    });
    await state.updateProviderJobCheckpoint(prompt, videoCheckpointKeys.sourceVideo, {
      providerJob: receipt,
      providerStatus: "completed",
      progress: 100,
      url: "https://cdn.agnes-ai.example/video.mp4?token=secret",
    });
    await state.completeCheckpoint(prompt, videoCheckpointKeys.sourceVideo, {
      path: sourcePath,
      sha256: sha256("source"),
      durationSeconds: 8,
      providerJob: receipt,
    });
    for (const [key, filePath, contents] of [
      [videoCheckpointKeys.foley, foleyPath, "foley"],
      [videoCheckpointKeys.music, musicPath, "music"],
    ] as const) {
      await state.startCheckpoint(prompt, key, key === videoCheckpointKeys.music
        ? { provider: "free.ai", model: "ace-step" }
        : { provider: "elevenlabs+local" });
      await state.completeCheckpoint(prompt, key, {
        path: filePath,
        sha256: sha256(contents),
        durationSeconds: 8,
      });
    }
    await state.startCheckpoint(prompt, videoCheckpointKeys.assembly, {
      provider: "local",
      model: "ffmpeg-static",
    });
    await state.completeCheckpoint(prompt, videoCheckpointKeys.assembly, {
      path: finalPath,
      sha256: sha256("final"),
      durationSeconds: 8,
      provider: "local",
      model: "ffmpeg-static",
    });

    let compactCalls = 0;
    const retained = await cleanupValidatedRunArtifacts({
      requested: false,
      runDirectory,
      retainedFinalPath: finalPath,
      originalPrompt: prompt,
      compactReceipts: async () => {
        compactCalls += 1;
        await state.compactCompletedArtifacts(prompt);
      },
    });
    assert.equal(retained.performed, false);
    assert.equal(retained.retention, "retained");
    assert.equal(compactCalls, 0);
    await assert.doesNotReject(access(sourcePath));
    await assert.doesNotReject(access(foleyPath));
    await assert.doesNotReject(access(musicPath));
    await assert.doesNotReject(access(analysisPath));
    assert.ok(await state.loadCheckpoint(prompt, videoCheckpointKeys.sourceVideo));

    const removed = await cleanupValidatedRunArtifacts({
      requested: true,
      runDirectory,
      retainedFinalPath: finalPath,
      originalPrompt: prompt,
      compactReceipts: async () => {
        compactCalls += 1;
        await state.compactCompletedArtifacts(prompt);
      },
    });
    assert.equal(removed.performed, true);
    assert.equal(removed.retention, "removed");
    assert.equal(compactCalls, 1);
    await assert.rejects(access(videoDirectory), { code: "ENOENT" });
    await assert.rejects(access(audioDirectory), { code: "ENOENT" });
    await assert.rejects(access(analysisDirectory), { code: "ENOENT" });
    await assert.rejects(access(oldFinalPath), { code: "ENOENT" });
    await assert.rejects(access(supersededNamedFinal), { code: "ENOENT" });
    await assert.rejects(access(supersededNamedPartial), { code: "ENOENT" });
    await assert.doesNotReject(access(finalPath));
    assert.deepEqual(
      (await state.listCheckpoints(prompt)).map(({ key }) => key),
      [videoCheckpointKeys.assembly],
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
