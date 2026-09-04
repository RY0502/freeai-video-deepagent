import assert from 'node:assert/strict';
import test from 'node:test';

import { VideoPlanSchema, type VideoPlan } from '../src/agent/videoPlan.js';
import { bindYouTubeUploadAuthorization } from '../src/authorization.js';
import { assertYouTubeConfig, loadConfig } from '../src/config.js';
import {
  AUDIO_MIX_REVISION,
  BACKGROUND_MUSIC_MIX,
  FOLEY_CUE_MAX_NORMALIZATION_GAIN_DB,
  FOLEY_CUE_MIN_USABLE_PEAK_DBFS,
  FOLEY_CUE_TARGET_MEAN_DBFS,
  SOURCE_AUDIO_INSPECTION_REVISION,
} from '../src/media/index.js';
import type { ArtifactCheckpoint } from '../src/state/index.js';
import {
  agnesVideoPrompt,
  finalArtifactDependenciesMatch,
  finalAudioMixRevisionIsCurrent,
  musicPrompt,
  resolveGenerationConfiguration,
  resolvePromptPreferencesForConfig,
} from '../src/tools/videoAgentTools.js';
import { FOLEY_RECONCILIATION_REVISION } from '../src/vision/index.js';

function currentPlan(musicEnabled = true): VideoPlan {
  const firstAction = 'The orange cat places one white paw onto the driveway and looks toward the car.';
  const beats = [
    {
      beatId: 'approach',
      startSeconds: 0,
      endSeconds: 3,
      narrativePurpose: 'Establish the cat and its careful approach to the stationary red car.',
      visualAction: `[1.50s] ${firstAction} The car remains stationary beside the garage.`,
      cameraDirection: 'Pan slowly left while maintaining one continuous cat-eye-height viewpoint.',
      composition: 'Frame the cat in the foreground with the red car and brick garage behind it.',
    },
    {
      beatId: 'reflection',
      startSeconds: 3,
      endSeconds: 7,
      narrativePurpose: 'Resolve the short story as the cat recognizes its reflection and settles.',
      visualAction: 'The same cat reaches the door, recognizes its reflection, and settles beside the car.',
      cameraDirection: 'Continue the same pan and ease into a stable final frame without a cut.',
      composition: 'Keep the cat, red car, garage, sunlight, and palette visually unchanged.',
    },
  ];

  return VideoPlanSchema.parse({
    schemaVersion: 2,
    concept: 'A curious orange cat approaches a red car and discovers its reflection.',
    creativeScript:
      'A curious orange cat crosses a warm driveway toward a parked red car. It walks cautiously, notices movement '
      + 'in the glossy door, then realizes the other cat is its own reflection and relaxes into a quiet final pose.',
    totalDurationSeconds: 7,
    continuityBible: {
      id: 'orange-cat-world',
      visualStyle: 'Warm animated cinematic imagery with restrained depth of field and stable geometry.',
      subjects: [{
        id: 'orange-cat',
        role: 'primary',
        invariantAppearance: 'A small orange tabby with emerald eyes, four white paws, and a plain blue collar.',
        wardrobeOrSurface: 'Short orange tabby coat and one unmarked plain blue collar.',
        props: [],
        identityAnchors: ['orange stripes', 'emerald eyes', 'four white paws', 'blue collar'],
      }],
      environment: {
        location: 'A clean concrete driveway in front of one weathered brick garage.',
        backgroundAnchors: ['red compact car', 'brick garage', 'closed silver garage door'],
        timeOfDay: 'Warm late afternoon',
        weatherOrAtmosphere: 'Dry and still with no precipitation or wind',
      },
      lighting: 'Stable late-afternoon sunlight from frame right with one consistent soft shadow.',
      colorPalette: ['warm orange', 'brick red', 'silver gray', 'collar blue'],
      cameraLanguage: 'One slow leftward pan at cat-eye height with a constant lens and exposure.',
      supportingAnchors: ['red car remains parked', 'garage door remains shut', 'driveway stays empty'],
      negativeConstraints: ['no identity drift', 'no visible text', 'no malformed geometry'],
    },
    visualPrompt:
      'Render one continuous animated view of the same orange tabby approaching the same parked red compact car, '
      + 'following the exact timed action, stable garage geometry, fixed late-afternoon light, and final reflection payoff.',
    cameraMotion: 'slow pan left',
    cameraDirection: 'Use one slow leftward pan at cat-eye height and settle gently on the final reflection pose.',
    negativePrompt: 'No captions, no duplicate cats, no malformed paws, no jump cuts, logos, or watermark.',
    timelineBeats: beats,
    foleyCues: [{
      cueId: 'paw-step',
      atSeconds: 1.5,
      sound: 'One clean cat paw step on a concrete driveway.',
      durationSeconds: 0.5,
      intensity: 'subtle',
      spatialPosition: 'center',
      category: 'movement',
      prominence: 'foreground',
      visualAction: firstAction,
      continuous: false,
      timingClass: 'must_sync',
    }],
    music: musicEnabled
      ? {
          enabled: true,
          prompt: 'A restrained pop underscore that follows the complete seven-second visual story.',
          negativePrompt: 'No vocals, Foley, creature sounds, engines, weather, or loud transients.',
          durationSeconds: 7,
          genre: 'pop',
          tempoBpm: 120,
          featuredInstrument: 'piano',
          mood: 'Bright forward motion with a gentle curious finish',
          role: 'background',
          syncStrategy: 'Use two connected phrases matching the approach and reflection windows.',
          beats: beats.map((beat) => ({
            beatId: beat.beatId,
            startSeconds: beat.startSeconds,
            endSeconds: beat.endSeconds,
            direction: `Support the ${beat.beatId} window quietly beneath the foreground sound.`,
          })),
        }
      : {
          enabled: false,
          reason: 'The user explicitly requested synchronized Foley without any background music.',
        },
    delivery: {
      visualStyle: 'animation',
      aspectRatio: '16:9',
      width: 1280,
      height: 704,
      fps: 30,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
    },
  });
}

test('configuration defaults cover Agnes video, ElevenLabs Foley, and Free.ai music', () => {
  const config = loadConfig({});

  assert.equal(config.AGNES_BASE_URL, 'https://apihub.agnes-ai.com');
  assert.equal(config.AGNES_REQUEST_TIMEOUT_MS, 60_000);
  assert.equal(config.AGNES_POLL_INTERVAL_MS, 30_000);
  assert.equal(config.AGNES_POLL_WINDOW_MS, 480_000);
  assert.equal(config.FREE_AI_BASE_URL, 'https://api.free.ai');
  assert.equal(config.FREE_AI_REQUEST_TIMEOUT_MS, 180_000);
  assert.equal(config.FREE_AI_RETRY_DELAY_MS, 6_000);
  assert.equal(config.FREE_AI_MUSIC_MAX_DOWNLOAD_BYTES, 64 * 1024 * 1024);
  assert.equal(config.ELEVENLABS_BASE_URL, 'https://api.elevenlabs.io');
  assert.equal(config.ELEVENLABS_REQUEST_TIMEOUT_MS, 180_000);
  assert.equal(config.VIDEO_STYLE, 'cinematic');
  assert.equal(config.VIDEO_ASPECT_RATIO, '16:9');
  assert.equal(config.VIDEO_FPS, 24);
  assert.equal(config.VIDEO_MUSIC_VOLUME, 0.10);
  assert.equal(config.VIDEO_FOLEY_VOLUME, 1);
  assert.equal(config.YOUTUBE_UPLOAD_ENABLED, false);
  assert.equal(config.YOUTUBE_DEFAULT_PRIVACY, 'private');
  assert.equal(config.YOUTUBE_DEFAULT_MADE_FOR_KIDS, false);
  assert.equal(config.YOUTUBE_DEFAULT_CONTAINS_SYNTHETIC_MEDIA, true);

  assert.throws(() => loadConfig({ AGNES_BASE_URL: 'not-a-url' }), /AGNES_BASE_URL|url/i);
  assert.throws(() => loadConfig({ FREE_AI_BASE_URL: 'not-a-url' }), /FREE_AI_BASE_URL|url/i);
  assert.throws(() => loadConfig({ ELEVENLABS_BASE_URL: 'not-a-url' }), /ELEVENLABS_BASE_URL|url/i);
  assert.throws(
    () => loadConfig({ AGNES_POLL_INTERVAL_MS: '6000', AGNES_POLL_WINDOW_MS: '5000' }),
    /AGNES_POLL_INTERVAL_MS.*must not exceed/i,
  );
});

test('YouTube runtime becomes configurable only with the complete OAuth environment', () => {
  assert.throws(() => assertYouTubeConfig(loadConfig({})), /disabled/i);
  assert.throws(() => assertYouTubeConfig(loadConfig({
    YOUTUBE_UPLOAD_ENABLED: 'true',
  })), /YOUTUBE_CLIENT_ID.*YOUTUBE_CLIENT_SECRET.*YOUTUBE_REFRESH_TOKEN/i);
  assert.doesNotThrow(() => assertYouTubeConfig(loadConfig({
    YOUTUBE_UPLOAD_ENABLED: 'true',
    YOUTUBE_CLIENT_ID: 'client-id',
    YOUTUBE_CLIENT_SECRET: 'client-secret',
    YOUTUBE_REFRESH_TOKEN: 'refresh-token',
  })));
});

test('explicit prompt controls are resolved globally for the one provider render', () => {
  const preferences = resolvePromptPreferencesForConfig(
    'Create an animation video. Aspect ratio: 16:9. Camera motion: slow pan left. '
      + 'Negative prompt: no captions, no duplicate cats. Use pop background music at 120 BPM featuring piano. '
      + 'Clean up after successful generation.',
    loadConfig({}),
  );

  assert.deepEqual(preferences.video, {
    style: 'animation',
    aspectRatio: '16:9',
    width: 1280,
    height: 704,
    fps: 24,
    styleSource: 'prompt',
    aspectRatioSource: 'prompt',
    cameraMotion: 'slow pan left',
    cameraMotionSource: 'prompt',
    negativePrompt: 'no captions, no duplicate cats',
    negativePromptSource: 'prompt',
  });
  assert.deepEqual(preferences.music, {
    genre: 'pop',
    tempoBpm: 120,
    featuredInstrument: 'piano',
  });
  assert.deepEqual(preferences.backgroundMusic, { enabled: true, source: 'default' });
  assert.equal(preferences.cleanupAfterSuccess, true);
});

test('the locked plan drives Agnes video, ElevenLabs Foley, and Free.ai music', () => {
  const config = loadConfig({
    VIDEO_MUSIC_VOLUME: '0.15',
    VIDEO_FOLEY_VOLUME: '1.1',
  });
  const plan = currentPlan();
  const originalPrompt =
    'Create an animation video. Aspect ratio: 16:9. Camera motion: slow pan left. '
    + 'Negative prompt: no captions, no duplicate cats. Use pop background music at 120 BPM featuring piano. '
    + 'Clean up after successful generation.';

  const resolved = resolveGenerationConfiguration(plan, originalPrompt, config);

  assert.deepEqual(resolved, {
    video: {
      provider: 'agnes',
      model: 'agnes-video-2.5-flash',
      durationSeconds: 7,
      visualStyle: 'animation',
      aspectRatio: '16:9',
      width: 1280,
      height: 704,
      fps: 30,
      cameraMotion: 'slow pan left',
      negativePrompt: 'No captions, no duplicate cats, no malformed paws, no jump cuts, logos, or watermark.',
    },
    foley: {
      provider: 'elevenlabs',
      model: 'eleven_text_to_sound_v2',
      role: 'fallback',
      trigger: 'missing_or_unusable_agnes_audio',
      sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      durationSeconds: 7,
      cueCount: 1,
      placement: 'local_ffmpeg_sample_timeline',
      audioMixRevision: AUDIO_MIX_REVISION,
      foleyReconciliationRevision: FOLEY_RECONCILIATION_REVISION,
      cueTargetMeanDbfs: FOLEY_CUE_TARGET_MEAN_DBFS,
      cueMaxNormalizationGainDb: FOLEY_CUE_MAX_NORMALIZATION_GAIN_DB,
      cueMinUsablePeakDbfs: FOLEY_CUE_MIN_USABLE_PEAK_DBFS,
      prominenceGain: { foreground: 1, supporting: 0.55, ambient: 0.4 },
      intensityGain: { strong: 1, medium: 0.9, subtle: 0.7 },
    },
    music: {
      enabled: true,
      provider: 'free.ai',
      model: 'ace-step',
      durationSeconds: 7,
      providerDurationSeconds: 10,
      genre: 'pop',
      mood: 'Bright forward motion with a gentle curious finish',
      tempoBpm: 120,
      featuredInstrument: 'piano',
      role: 'background',
    },
    assembly: {
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      musicVolume: 0.15,
      foleyVolume: 1.1,
      audioMixRevision: AUDIO_MIX_REVISION,
      backgroundMusicMix: BACKGROUND_MUSIC_MIX,
    },
    cleanupAfterSuccess: true,
  });
});

test('resolved configuration logs generated YouTube metadata and trusted policy values', () => {
  const plan = VideoPlanSchema.parse({
    ...currentPlan(),
    youtubeUpload: {
      requested: true,
      title: 'The Curious Cat and the Red Car',
      description: 'A short AI-generated animated story about curiosity and reflection.',
      tags: ['orange cat', 'animated short', 'red car', 'AI video', 'visual story'],
      categoryId: '24',
      privacyStatus: 'unlisted',
      madeForKids: true,
    },
  });
  const resolved = resolveGenerationConfiguration(
    plan,
    bindYouTubeUploadAuthorization('Create an animation video.', true),
    loadConfig({
      YOUTUBE_DEFAULT_PRIVACY: 'unlisted',
      YOUTUBE_DEFAULT_MADE_FOR_KIDS: 'true',
      YOUTUBE_DEFAULT_CONTAINS_SYNTHETIC_MEDIA: 'true',
    }),
  );

  assert.deepEqual(resolved.youtube, {
    requested: true,
    title: 'The Curious Cat and the Red Car',
    description: 'A short AI-generated animated story about curiosity and reflection.',
    tags: ['orange cat', 'animated short', 'red car', 'AI video', 'visual story'],
    categoryId: '24',
    privacyStatus: 'unlisted',
    madeForKids: true,
    containsSyntheticMedia: true,
    notifySubscribers: false,
  });
});

test('provider prompts serialize the global controls, timed beats, and restrained music settings', () => {
  const plan = currentPlan();
  const video = agnesVideoPrompt(plan);
  assert.match(video, /one continuous 7-second animation video, 16:9/i);
  assert.match(video, /Camera motion: slow pan left/i);
  assert.match(video, /0\.00-3\.00s \[approach\]/);
  assert.match(video, /\[1\.50s\] The orange cat places one white paw/i);
  assert.match(video, /broad continuous action windows/i);
  assert.doesNotMatch(video, /synchronized action:/i);
  assert.match(video, /Avoid: No captions, no duplicate cats/i);
  assert.match(video, /Generate synchronized natural diegetic production audio/i);
  assert.match(video, /Near 1\.50s: One clean cat paw step on a concrete driveway/i);
  assert.match(video, /Do not generate background music, score, songs, lyrics, narration/i);

  const music = musicPrompt(plan);
  assert.match(music, /Compose 10 seconds of sparse instrumental background music/i);
  assert.match(music, /final edit uses only the first 7\.00 seconds/i);
  assert.match(music, /remaining provider tail subdued because it will be trimmed locally/i);
  assert.match(music, /Narrative concept to score: A curious orange cat approaches a red car/i);
  assert.match(music, /Complete story arc to score emotionally: A curious orange cat crosses a warm driveway/i);
  assert.match(music, /subject, action, stakes, atmosphere, and payoff/i);
  assert.match(music, /do not substitute generic stock ambience/i);
  assert.match(music, /Do not imitate its literal voices, impacts, vehicles, weather, creatures/i);
  assert.match(music, /Genre: pop/);
  assert.match(music, /Tempo: 120 BPM/);
  assert.match(music, /Treat 120 BPM as the perceived primary pulse/i);
  assert.match(music, /Never render it in double-time/i);
  assert.match(music, /Keep rhythmic density restrained/i);
  assert.match(music, /broad musical texture and phrase shape, not action-by-action hits/i);
  assert.match(music, /Foley owns every transient/i);
  assert.match(music, /Feature piano/);
  assert.match(music, /0\.00-3\.00s \[approach\]/);
  assert.match(music, /no speech, lyrics, creature sounds, engines, weather, impacts/i);
});

test('slow background music explicitly forbids a busy or double-time interpretation', () => {
  const plan = currentPlan();
  if (!plan.music.enabled) assert.fail('currentPlan must enable music');
  plan.music.tempoBpm = 60;

  const music = musicPrompt(plan);
  assert.match(music, /Treat 60 BPM as the perceived primary pulse/i);
  assert.match(music, /Never render it in double-time/i);
  assert.match(music, /long sustained phrases with very few note attacks/i);
  assert.match(music, /No busy percussion, rapid arpeggios, ostinatos, rhythmic fills, or fast repeated notes/i);
  assert.match(music, /do not accent individual Foley timestamps/i);
});

test('a completed final is reusable only for the current mix revision and configured gains', () => {
  const config = loadConfig({});
  const checkpoint = {
    schemaVersion: 2,
    status: 'completed',
    attempt: 1,
    path: '/local/final.mp4',
    sha256: 'a'.repeat(64),
    provider: 'local',
    model: 'ffmpeg-static',
    startedAt: '2026-09-03T09:00:00.000Z',
    updatedAt: '2026-09-03T09:01:00.000Z',
  } satisfies ArtifactCheckpoint;

  assert.equal(finalAudioMixRevisionIsCurrent(checkpoint, config), false);
  assert.equal(finalAudioMixRevisionIsCurrent({
    ...checkpoint,
    details: {
      audioMixRevision: AUDIO_MIX_REVISION,
      sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      sourceAudioAnalysisSha256: 'f'.repeat(64),
      foregroundAudioMode: 'elevenlabs_foley',
      foleyReconciliationRevision: FOLEY_RECONCILIATION_REVISION,
      sourceVideoSha256: 'b'.repeat(64),
      foleySha256: 'c'.repeat(64),
      foleyReconciliationSha256: 'd'.repeat(64),
      musicDependencyStatus: 'included',
      musicSha256: 'e'.repeat(64),
      backgroundMusicRequested: true,
      backgroundMusicIncluded: true,
      foleyOnlyFallback: false,
      musicVolume: config.VIDEO_MUSIC_VOLUME,
      foleyVolume: config.VIDEO_FOLEY_VOLUME,
    },
  }, config), true);
  assert.equal(finalAudioMixRevisionIsCurrent({
    ...checkpoint,
    details: {
      audioMixRevision: AUDIO_MIX_REVISION,
      sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      sourceAudioAnalysisSha256: 'f'.repeat(64),
      foregroundAudioMode: 'elevenlabs_foley',
      foleyReconciliationRevision: FOLEY_RECONCILIATION_REVISION,
      sourceVideoSha256: 'b'.repeat(64),
      foleySha256: 'c'.repeat(64),
      foleyReconciliationSha256: 'd'.repeat(64),
      musicDependencyStatus: 'included',
      musicSha256: 'e'.repeat(64),
      backgroundMusicRequested: true,
      backgroundMusicIncluded: true,
      foleyOnlyFallback: false,
      musicVolume: 0.3,
      foleyVolume: config.VIDEO_FOLEY_VOLUME,
    },
  }, config), false);
});

test('a final dependency receipt is bound to the exact source, Foley, reconciliation, and music inputs', () => {
  const dependencies = {
    foregroundAudioMode: 'elevenlabs_foley' as const,
    sourceVideoSha256: 'a'.repeat(64),
    sourceAudioAnalysisSha256: 'f'.repeat(64),
    foleySha256: 'b'.repeat(64),
    reconciliationSha256: 'c'.repeat(64),
    musicDependencyStatus: 'included' as const,
    musicSha256: 'd'.repeat(64),
  };
  const checkpoint = {
    schemaVersion: 2,
    status: 'completed',
    attempt: 1,
    path: '/local/final.mp4',
    sha256: 'e'.repeat(64),
    provider: 'local',
    model: 'ffmpeg-static',
    details: {
      sourceVideoSha256: dependencies.sourceVideoSha256,
      sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      sourceAudioAnalysisSha256: dependencies.sourceAudioAnalysisSha256,
      foregroundAudioMode: dependencies.foregroundAudioMode,
      foleySha256: dependencies.foleySha256,
      foleyReconciliationRevision: FOLEY_RECONCILIATION_REVISION,
      foleyReconciliationSha256: dependencies.reconciliationSha256,
      musicDependencyStatus: dependencies.musicDependencyStatus,
      musicSha256: dependencies.musicSha256,
    },
    startedAt: '2026-09-03T09:00:00.000Z',
    updatedAt: '2026-09-03T09:01:00.000Z',
  } satisfies ArtifactCheckpoint;

  assert.equal(finalArtifactDependenciesMatch(checkpoint, dependencies), true);
  assert.equal(finalArtifactDependenciesMatch(checkpoint, {
    ...dependencies,
    sourceVideoSha256: 'f'.repeat(64),
  }), false);
  assert.equal(finalArtifactDependenciesMatch(checkpoint, {
    ...dependencies,
    sourceAudioAnalysisSha256: '0'.repeat(64),
  }), false);
  assert.equal(finalArtifactDependenciesMatch(checkpoint, {
    ...dependencies,
    foleySha256: 'f'.repeat(64),
  }), false);
  assert.equal(finalArtifactDependenciesMatch(checkpoint, {
    ...dependencies,
    reconciliationSha256: 'f'.repeat(64),
  }), false);
  assert.equal(finalArtifactDependenciesMatch(checkpoint, {
    ...dependencies,
    musicSha256: 'f'.repeat(64),
  }), false);
  assert.equal(finalArtifactDependenciesMatch(checkpoint, {
    ...dependencies,
    musicDependencyStatus: 'skipped',
    musicSha256: null,
  }), false);
});

test('a native-audio final dependency receipt has no synthetic Foley inputs', () => {
  const dependencies = {
    foregroundAudioMode: 'agnes_native' as const,
    sourceVideoSha256: 'a'.repeat(64),
    sourceAudioAnalysisSha256: 'b'.repeat(64),
    foleySha256: null,
    reconciliationSha256: null,
    musicDependencyStatus: 'included' as const,
    musicSha256: 'c'.repeat(64),
  };
  const checkpoint = {
    schemaVersion: 2,
    status: 'completed',
    attempt: 1,
    path: '/local/final.mp4',
    sha256: 'd'.repeat(64),
    provider: 'local',
    model: 'ffmpeg-static',
    details: {
      audioMixRevision: AUDIO_MIX_REVISION,
      sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      sourceAudioAnalysisSha256: dependencies.sourceAudioAnalysisSha256,
      sourceVideoSha256: dependencies.sourceVideoSha256,
      foregroundAudioMode: dependencies.foregroundAudioMode,
      foleySha256: null,
      foleyReconciliationRevision: null,
      foleyReconciliationSha256: null,
      musicDependencyStatus: dependencies.musicDependencyStatus,
      musicSha256: dependencies.musicSha256,
      backgroundMusicRequested: true,
      backgroundMusicIncluded: true,
      foleyOnlyFallback: false,
      musicVolume: 0.10,
      foleyVolume: 1,
    },
    startedAt: '2026-09-03T09:00:00.000Z',
    updatedAt: '2026-09-03T09:01:00.000Z',
  } satisfies ArtifactCheckpoint;

  assert.equal(finalArtifactDependenciesMatch(checkpoint, dependencies), true);
  assert.equal(finalAudioMixRevisionIsCurrent(checkpoint, loadConfig({})), true);
  assert.equal(finalArtifactDependenciesMatch(checkpoint, {
    ...dependencies,
    foregroundAudioMode: 'elevenlabs_foley',
    foleySha256: 'e'.repeat(64),
    reconciliationSha256: 'f'.repeat(64),
  }), false);
});

test('an explicit Foley-only prompt disables music while retaining the global Foley configuration', () => {
  const plan = currentPlan(false);
  const resolved = resolveGenerationConfiguration(
    plan,
    'Create the clip with Foley only and no background music',
    loadConfig({}),
  );

  assert.deepEqual(resolved.music, { enabled: false });
  assert.deepEqual(resolved.foley, {
    provider: 'elevenlabs',
    model: 'eleven_text_to_sound_v2',
    role: 'fallback',
    trigger: 'missing_or_unusable_agnes_audio',
    sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
    durationSeconds: 7,
    cueCount: 1,
    placement: 'local_ffmpeg_sample_timeline',
    audioMixRevision: AUDIO_MIX_REVISION,
    foleyReconciliationRevision: FOLEY_RECONCILIATION_REVISION,
    cueTargetMeanDbfs: FOLEY_CUE_TARGET_MEAN_DBFS,
    cueMaxNormalizationGainDb: FOLEY_CUE_MAX_NORMALIZATION_GAIN_DB,
    cueMinUsablePeakDbfs: FOLEY_CUE_MIN_USABLE_PEAK_DBFS,
    prominenceGain: { foreground: 1, supporting: 0.55, ambient: 0.4 },
    intensityGain: { strong: 1, medium: 0.9, subtle: 0.7 },
  });
  assert.throws(() => musicPrompt(plan), /explicitly disables background music/i);
});
