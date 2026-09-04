import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import ffmpegStaticModule from "ffmpeg-static";

import type { AgnesVideoClient } from "../src/agnes/index.js";
import type { VideoPlan } from "../src/agent/videoPlan.js";
import { loadConfig } from "../src/config.js";
import type {
  ElevenLabsClient,
  ElevenLabsSoundEffectRequest,
} from "../src/elevenlabs/index.js";
import type { FreeAiMusicClient } from "../src/freeai/index.js";
import {
  AUDIO_MIX_REVISION,
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
import { sha256File } from "../src/utils/files.js";
import {
  FOLEY_INTENSITY_GAIN,
  FOLEY_PROMINENCE_GAIN,
  AGNES_NATIVE_AUDIO_MODEL,
  VIDEO_TOOL_NAMES,
  agnesVideoPrompt,
  completedFoleyArtifactIsValid,
  createVideoAgentTools,
  timedCueMixVolume,
  type VideoAgentEvent,
} from "../src/tools/videoAgentTools.js";
import {
  FOLEY_RECONCILIATION_REVISION,
  type FoleyVisionClient,
} from "../src/vision/index.js";

const ffmpegPath = ffmpegStaticModule as unknown as string | null;
const PROMPT = "A batsman hits a six and the crowd roars; Foley only, no background music";

function sourceAudioInspection(
  sourceVideoSha256: string,
  usable: boolean,
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

function cricketPlan(): VideoPlan {
  const batAction = "the wooden bat meets the cricket ball at the center of its face";
  const crowdAction = "the crowd sees the ball clear the boundary and rises in celebration";
  return {
    schemaVersion: 2,
    concept: "A batter makes clean contact and the crowd celebrates the visible six.",
    creativeScript: "A focused batter plants his front foot as the ball arrives, strikes it cleanly into the sky, and holds the pose while the ball clears the rope and the stadium crowd erupts.",
    totalDurationSeconds: 4,
    continuityBible: {
      id: "cricket-six",
      visualStyle: "A realistic televised cricket moment with cinematic clarity.",
      subjects: [{
        id: "batter",
        role: "primary",
        invariantAppearance: "One right-handed batter wearing a blue kit and navy helmet.",
        wardrobeOrSurface: "Blue cricket kit, white gloves, and navy helmet.",
        props: ["wooden bat"],
        identityAnchors: ["blue jersey", "navy helmet", "white gloves"],
      }],
      environment: {
        location: "A full outdoor cricket stadium viewed from near the pitch.",
        backgroundAnchors: ["green boundary rope", "packed grandstand"],
        timeOfDay: "bright afternoon",
        weatherOrAtmosphere: "clear air and energetic match atmosphere",
      },
      lighting: "Consistent bright daylight with natural stadium contrast.",
      colorPalette: ["pitch tan", "grass green", "jersey blue"],
      cameraLanguage: "One smooth tracking shot follows contact and the flight toward the rope.",
      supportingAnchors: ["white ball", "green boundary rope"],
      negativeConstraints: ["no duplicate batter", "no text overlay", "no deformed bat"],
    },
    visualPrompt: "A continuous realistic cricket shot frames one blue-clad batter stepping into a delivery, making clearly visible bat-ball contact, then follows the white ball over the green boundary before revealing the packed crowd standing and celebrating.",
    cameraMotion: "slow pan right",
    cameraDirection: "Begin tight enough to read contact, then pan with the ball and widen to include the reacting crowd.",
    negativePrompt: "no captions, no logo, no duplicate player, no extra ball, no malformed bat",
    timelineBeats: [
      {
        beatId: "contact",
        startSeconds: 0,
        endSeconds: 2,
        narrativePurpose: "Establish the delivery and show the exact decisive contact.",
        visualAction: `The batter steps forward. [1.00s] ${batAction}. The ball immediately climbs above the pitch.`,
        cameraDirection: "Hold near the batter through contact, then start following the ball.",
        composition: "Keep bat, ball, and front foot readable in the center of frame.",
      },
      {
        beatId: "celebration",
        startSeconds: 2,
        endSeconds: 4,
        narrativePurpose: "Confirm the six visually before revealing the crowd payoff.",
        visualAction: `The ball crosses the boundary. [3.10s] ${crowdAction}. Arms rise across the grandstand.`,
        cameraDirection: "Pan through the boundary and widen smoothly to the grandstand.",
        composition: "Keep the ball visible against the crowd until it clears the rope.",
      },
    ],
    foleyCues: [
      {
        cueId: "bat-contact",
        atSeconds: 1,
        durationSeconds: 0.5,
        sound: "a sharp wooden cricket bat hitting the ball at close range",
        intensity: "strong",
        spatialPosition: "center",
        category: "impact",
        prominence: "foreground",
        visualAction: batAction,
        continuous: false,
        timingClass: "must_sync",
      },
      {
        cueId: "crowd-roar",
        atSeconds: 3.1,
        durationSeconds: 0.8,
        sound: "a large stadium crowd roaring and cheering for a six",
        intensity: "strong",
        spatialPosition: "center",
        category: "crowd",
        prominence: "foreground",
        visualAction: crowdAction,
        continuous: false,
        timingClass: "must_sync",
      },
    ],
    music: {
      enabled: false,
      reason: "The user explicitly requested Foley only and no background music.",
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

async function synthesizeEffect(outputPath: string): Promise<void> {
  assert.ok(ffmpegPath, "ffmpeg-static is unavailable");
  await createSpawnProcessRunner({ timeoutMs: 30_000 })(ffmpegPath, [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-n",
    "-f", "lavfi", "-i", "sine=frequency=700:sample_rate=48000:duration=1",
    "-c:a", "libmp3lame", outputPath,
  ]);
}

async function synthesizeVideo(outputPath: string): Promise<void> {
  assert.ok(ffmpegPath, "ffmpeg-static is unavailable");
  await createSpawnProcessRunner({ timeoutMs: 30_000 })(ffmpegPath, [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-n",
    "-f", "lavfi", "-i", "color=c=green:s=720x1280:r=24:d=4",
    "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    outputPath,
  ]);
}

test("Foley cue gain combines prominence and intensity after per-cue normalization", () => {
  const cue = cricketPlan().foleyCues[0]!;
  assert.deepEqual(FOLEY_PROMINENCE_GAIN, {
    foreground: 1,
    supporting: 0.55,
    ambient: 0.4,
  });
  assert.deepEqual(FOLEY_INTENSITY_GAIN, {
    strong: 1,
    medium: 0.9,
    subtle: 0.7,
  });
  assert.equal(timedCueMixVolume(cue), 1);
  assert.equal(
    timedCueMixVolume({ ...cue, prominence: "supporting", intensity: "medium" }),
    0.55 * 0.9,
  );
  assert.equal(
    timedCueMixVolume({ ...cue, prominence: "ambient", intensity: "subtle" }),
    0.4 * 0.7,
  );
});

test("usable Agnes source audio bypasses both vision analysis and ElevenLabs Foley", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-source-audio-"));
  const hash = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, hash);
  const state = new VideoRunStateStore(runDirectory);
  const events: VideoAgentEvent[] = [];
  let visionCalls = 0;
  let elevenLabsCalls = 0;

  try {
    await state.ensureManifest(PROMPT);
    await state.savePlan(PROMPT, cricketPlan());
    const sourcePath = path.join(runDirectory, "video", "source.mp4");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await synthesizeVideo(sourcePath);
    const sourceVideoSha256 = await sha256File(sourcePath);
    await state.startCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo, {
      provider: "agnes",
      model: "agnes-video-2.5-flash",
    });
    await state.completeCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo, {
      path: sourcePath,
      sha256: sourceVideoSha256,
      durationSeconds: 4,
      provider: "agnes",
      model: "agnes-video-2.5-flash",
    });

    const bundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {
        async generateSoundEffect() {
          elevenLabsCalls += 1;
          throw new Error("ElevenLabs must not run when Agnes audio is usable");
        },
      } as unknown as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
      foleyVision: {
        async analyze() {
          visionCalls += 1;
          throw new Error("Vision must not run when Agnes audio is usable");
        },
      },
      inspectSourceAudioArtifact: async (input) => {
        assert.equal(input.sourceVideoSha256, sourceVideoSha256);
        return sourceAudioInspection(input.sourceVideoSha256, true);
      },
      onEvent: (event) => events.push(event),
    });
    const foleyTool = bundle.tools.find(({ name }) => name === VIDEO_TOOL_NAMES.generateFoley);
    assert.ok(foleyTool);

    const selected = JSON.parse(String(await foleyTool.invoke({}))) as Record<string, unknown>;
    assert.equal(selected.status, "native_audio_selected");
    assert.equal(selected.foregroundAudioMode, "agnes_native");
    assert.equal(selected.elevenLabsCalled, false);
    assert.equal(selected.visionCalled, false);
    assert.equal(visionCalls, 0);
    assert.equal(elevenLabsCalls, 0);

    const sourceAnalysis = await state.loadCheckpoint(
      PROMPT,
      videoCheckpointKeys.sourceAudioAnalysis,
    );
    assert.equal(sourceAnalysis?.status, "completed");
    assert.equal(sourceAnalysis?.details?.usable, true);
    assert.equal(sourceAnalysis?.details?.sourceVideoSha256, sourceVideoSha256);
    const selection = await state.loadCheckpoint(PROMPT, videoCheckpointKeys.foley);
    assert.equal(selection?.status, "skipped");
    assert.equal(selection?.provider, "agnes");
    assert.equal(selection?.model, AGNES_NATIVE_AUDIO_MODEL);
    assert.equal(selection?.details?.nativeSourceAudioSelected, true);
    assert.equal(selection?.details?.foregroundAudioMode, "agnes_native");
    assert.equal(selection?.details?.sourceAudioAnalysisSha256, sourceAnalysis?.sha256);
    assert.equal(
      await state.loadCheckpoint(PROMPT, videoCheckpointKeys.foleyAnalysis),
      null,
    );
    assert.equal(events.some(({ event }) => event === "source_audio_inspection_started"), true);
    assert.equal(events.some(({ event }) => event === "source_audio_inspection_completed"), true);
    assert.equal(events.some(({ event }) => event === "foley_vision_started"), false);
    assert.equal(events.some(({ event }) => event === "foley_key_attempt"), false);
    assert.deepEqual(events.filter(({ event }) => event === "foreground_audio_selected").at(-1), {
      event: "foreground_audio_selected",
      mode: "agnes_native",
      source: "generated",
      reason: "Embedded source audio contains a meaningful decodable signal.",
    });

    const reused = JSON.parse(String(await foleyTool.invoke({}))) as Record<string, unknown>;
    assert.equal(reused.status, "reused");
    assert.equal(reused.foregroundAudioMode, "agnes_native");
    assert.equal(visionCalls, 0);
    assert.equal(elevenLabsCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a no-stream Agnes source falls back to vision-synced ElevenLabs Foley at global cue timestamps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "global-foley-"));
  const hash = new VideoRunStateStore(path.join(root, "placeholder")).promptHash(PROMPT);
  const runDirectory = path.join(root, hash);
  const state = new VideoRunStateStore(runDirectory);
  const fixtureEffect = path.join(root, "effect.mp3");
  const calls: ElevenLabsSoundEffectRequest[] = [];
  const events: VideoAgentEvent[] = [];
  try {
    await synthesizeEffect(fixtureEffect);
    await state.ensureManifest(PROMPT);
    const plan = await state.savePlan(PROMPT, cricketPlan());
    const sourcePath = path.join(runDirectory, "video", "source.mp4");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await synthesizeVideo(sourcePath);
    await state.startCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo, {
      provider: "agnes",
      model: "agnes-video-2.5-flash",
    });
    await state.completeCheckpoint(PROMPT, videoCheckpointKeys.sourceVideo, {
      path: sourcePath,
      sha256: await sha256File(sourcePath),
      durationSeconds: 4,
      provider: "agnes",
      model: "agnes-video-2.5-flash",
    });

    const elevenLabs = {
      async generateSoundEffect(request: ElevenLabsSoundEffectRequest) {
        calls.push(request);
        request.onAttempt?.({ keyLabel: calls.length === 1 ? "key-1" : "key-2" });
        await copyFile(fixtureEffect, request.outputPath);
        return {
          filePath: request.outputPath,
          contentType: "audio/mpeg" as const,
          model: "eleven_text_to_sound_v2" as const,
          keyLabel: calls.length === 1 ? "key-1" : "key-2",
          requestId: `request-${calls.length}`,
        };
      },
    } as unknown as ElevenLabsClient;
    const foleyVision: FoleyVisionClient = {
      async analyze() {
        return {
          text: JSON.stringify({ cues: [
            {
              cueId: "bat-contact",
              visible: true,
              matchesPlannedCause: true,
              observedAtSeconds: 1,
              confidence: 0.98,
              observedAction: "The wooden bat first contacts the cricket ball.",
              soundDescription: "one dry close wooden crack with a short natural decay",
              reason: "The contact frame is clear.",
            },
            {
              cueId: "crowd-roar",
              visible: true,
              matchesPlannedCause: true,
              observedAtSeconds: 3.1,
              confidence: 0.96,
              observedAction: "The visible crowd rises together in celebration.",
              soundDescription: "one broad stadium cheer from a large mid-distance crowd",
              reason: "The crowd reaction is clear.",
            },
          ] }),
          provider: "test-vision",
          model: "test-vlm",
        };
      },
    };
    const bundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: {} as AgnesVideoClient,
      elevenLabs,
      freeAiMusic: {} as FreeAiMusicClient,
      foleyVision,
      inspectSourceAudioArtifact: async (input) => {
        assert.equal(input.sourceVideoPath, sourcePath);
        return sourceAudioInspection(input.sourceVideoSha256, false);
      },
      onEvent: (event) => events.push(event),
    });
    const foleyTool = bundle.tools.find(({ name }) => name === VIDEO_TOOL_NAMES.generateFoley);
    assert.ok(foleyTool);
    const result = JSON.parse(String(await foleyTool.invoke({}))) as Record<string, unknown>;
    assert.equal(result.status, "completed");
    assert.equal(result.cueCount, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls.every(({ text }) => text.includes("Single immediate event")), true);
    assert.equal(calls.every(({ text }) => text.includes("Foreground, strong")), true);
    assert.equal(calls[0]?.durationSeconds, 0.85);
    assert.equal(calls[1]?.durationSeconds, 1.15);
    assert.equal((await stat(String(result.path))).size > 0, true);

    const prompt = agnesVideoPrompt(plan);
    assert.match(prompt, /\[1\.00s\] the wooden bat meets/);
    assert.match(prompt, /\[3\.10s\] the crowd sees the ball clear/);
    assert.doesNotMatch(prompt, /synchronized action:/);
    assert.equal(events.filter(({ event }) => event === "foley_key_attempt").length, 2);
    assert.equal(events.some(({ event }) => event === "foley_completed"), true);
    assert.equal(events.some(({ event }) => event === "foley_vision_started"), true);
    assert.deepEqual(events.filter(({ event }) => event === "foreground_audio_selected").at(-1), {
      event: "foreground_audio_selected",
      mode: "elevenlabs_foley",
      source: "generated",
      reason: "The Agnes video has no embedded audio stream.",
    });
    const sourceAudioCheckpoint = await state.loadCheckpoint(
      PROMPT,
      videoCheckpointKeys.sourceAudioAnalysis,
    );
    assert.equal(sourceAudioCheckpoint?.status, "completed");
    assert.equal(sourceAudioCheckpoint?.details?.hasAudioStream, false);
    assert.equal(sourceAudioCheckpoint?.details?.usable, false);

    const reused = JSON.parse(String(await foleyTool.invoke({}))) as Record<string, unknown>;
    assert.equal(reused.status, "reused");
    assert.equal(calls.length, 2);
    const checkpoint = await state.loadCheckpoint(PROMPT, videoCheckpointKeys.foley);
    assert.equal(checkpoint?.details?.generatedCueCount, 2);
    assert.equal(checkpoint?.details?.reusedCueCount, 0);
    assert.equal(checkpoint?.details?.placement, "local_ffmpeg_sample_timeline");
    assert.equal(checkpoint?.details?.audioMixRevision, AUDIO_MIX_REVISION);
    assert.equal(checkpoint?.details?.foregroundAudioMode, "elevenlabs_foley");
    assert.equal(
      checkpoint?.details?.sourceAudioInspectionRevision,
      SOURCE_AUDIO_INSPECTION_REVISION,
    );
    assert.match(String(checkpoint?.details?.sourceAudioAnalysisSha256), /^[a-f0-9]{64}$/);
    assert.equal(checkpoint?.details?.cueTargetMeanDbfs, -20);
    assert.equal(checkpoint?.details?.foleyReconciliationRevision, FOLEY_RECONCILIATION_REVISION);
    assert.match(String(checkpoint?.details?.foleyReconciliationSha256), /^[a-f0-9]{64}$/);
    assert.equal(checkpoint?.details?.sourceVideoSha256, await sha256File(sourcePath));
    assert.equal(await completedFoleyArtifactIsValid(checkpoint, {
      sourceVideoSha256: await sha256File(sourcePath),
      sourceAudioAnalysisSha256: String(checkpoint?.details?.sourceAudioAnalysisSha256),
      reconciliationSha256: String(checkpoint?.details?.foleyReconciliationSha256),
    }), true);
    assert.equal(await completedFoleyArtifactIsValid(checkpoint, {
      sourceVideoSha256: "0".repeat(64),
      sourceAudioAnalysisSha256: String(checkpoint?.details?.sourceAudioAnalysisSha256),
      reconciliationSha256: String(checkpoint?.details?.foleyReconciliationSha256),
    }), false);
    assert.equal(await completedFoleyArtifactIsValid(checkpoint, {
      sourceVideoSha256: await sha256File(sourcePath),
      sourceAudioAnalysisSha256: "0".repeat(64),
      reconciliationSha256: String(checkpoint?.details?.foleyReconciliationSha256),
    }), false);
    assert.deepEqual(checkpoint?.details?.prominenceGain, FOLEY_PROMINENCE_GAIN);
    assert.deepEqual(checkpoint?.details?.intensityGain, FOLEY_INTENSITY_GAIN);

    assert.ok(checkpoint?.path && checkpoint.sha256);
    await state.completeCheckpoint(PROMPT, videoCheckpointKeys.foley, {
      path: checkpoint.path,
      sha256: checkpoint.sha256,
      durationSeconds: 4,
      provider: "elevenlabs+local",
      model: "eleven_text_to_sound_v2+ffmpeg",
      details: { ...checkpoint.details, audioMixRevision: AUDIO_MIX_REVISION - 1 },
    });

    const resumedBundle = createVideoAgentTools({
      originalPrompt: PROMPT,
      runDirectory,
      config: loadConfig({}),
      stateStore: state,
      agnes: {} as AgnesVideoClient,
      elevenLabs,
      freeAiMusic: {} as FreeAiMusicClient,
      foleyVision,
      inspectSourceAudioArtifact: async (input) =>
        sourceAudioInspection(input.sourceVideoSha256, false),
      onEvent: (event) => events.push(event),
    });
    const resumedFoleyTool = resumedBundle.tools.find(
      ({ name }) => name === VIDEO_TOOL_NAMES.generateFoley,
    );
    assert.ok(resumedFoleyTool);
    const remixed = JSON.parse(String(await resumedFoleyTool.invoke({}))) as Record<string, unknown>;
    assert.equal(remixed.status, "completed");
    assert.equal(calls.length, 2);
    assert.deepEqual(events.filter(({ event }) => event === "foley_mix_rebuild"), [{
      event: "foley_mix_rebuild",
      previousRevision: AUDIO_MIX_REVISION - 1,
      audioMixRevision: AUDIO_MIX_REVISION,
      cueAssetsRetained: true,
    }]);
    const remixCompleted = events.filter(({ event }) => event === "foley_completed").at(-1);
    assert.deepEqual(remixCompleted, {
      event: "foley_completed",
      path: checkpoint.path,
      cueCount: 2,
      generatedCueCount: 0,
      reusedCueCount: 2,
      source: "local_rebuild",
    });
    const currentCheckpoint = await state.loadCheckpoint(PROMPT, videoCheckpointKeys.foley);
    assert.equal(currentCheckpoint?.details?.audioMixRevision, AUDIO_MIX_REVISION);
    assert.equal(currentCheckpoint?.details?.generatedCueCount, 0);
    assert.equal(currentCheckpoint?.details?.reusedCueCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
