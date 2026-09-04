import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createValidateVideoPlanTool } from '../src/agent/planTool.js';
import {
  MAX_LONG_FOREGROUND_TRANSIENTS,
  MAX_SHORT_FOREGROUND_TRANSIENTS,
  MAX_TIMELINE_BEATS,
  MAX_VIDEO_DURATION_SECONDS,
  MIN_MUST_SYNC_TRANSIENT_SPACING_SECONDS,
  MIN_VIDEO_DURATION_SECONDS,
  VideoPlanAudioChoreographyError,
  VideoPlanPromptMismatchError,
  VideoPlanSchema,
  enabledMusicForPlan,
  parseVideoPlanForPrompt,
  planUsesBackgroundMusic,
  promptExplicitlyRequestsYouTubeUpload,
  validateNewVideoPlanAudioChoreography,
} from '../src/agent/videoPlan.js';
import { bindYouTubeUploadAuthorization } from '../src/authorization.js';
import { VideoRunStateStore } from '../src/state/videoRunState.js';

function makePlan(totalDurationSeconds = 8): any {
  const secondBeatStart = Math.floor(totalDurationSeconds / 2);
  const contactAction = 'The cat visibly places one white front paw firmly onto the concrete driveway.';
  const timelineBeats = [
    {
      beatId: 'careful-approach',
      startSeconds: 0,
      endSeconds: secondBeatStart,
      narrativePurpose: 'Establish the curious cat and begin its deliberate approach toward the parked car.',
      visualAction: `[1.00s] ${contactAction} The cat then studies its reflection in the lower car door.`,
      cameraDirection: 'Begin at cat-eye height and move slowly from left to right without cutting.',
      composition: 'Keep the orange cat in the foreground and the red car and brick garage as stable anchors.',
    },
    {
      beatId: 'quiet-payoff',
      startSeconds: secondBeatStart,
      endSeconds: totalDurationSeconds,
      narrativePurpose: 'Resolve the approach with a small reaction that completes the continuous visual story.',
      visualAction: 'The cat reaches the car, sees its reflection clearly, and settles into a calm final pose.',
      cameraDirection: 'Continue the same rightward move, easing to a stable hold on the final pose.',
      composition: 'Retain the same cat, car, garage, light direction, palette, and depth throughout the payoff.',
    },
  ];

  return {
    schemaVersion: 2,
    concept: 'A curious orange cat approaches a red car in one continuous cinematic shot.',
    creativeScript:
      'An orange cat notices a red car across a sunlit driveway and approaches it with careful, measured steps. '
      + 'It studies its reflection in the door, briefly startles, then understands the harmless image and settles beside the car.',
    totalDurationSeconds,
    continuityBible: {
      id: 'cat-drive-continuity',
      visualStyle: 'Natural cinematic realism with gentle texture and restrained depth of field.',
      subjects: [{
        id: 'orange-cat',
        role: 'primary',
        invariantAppearance: 'A small orange tabby with emerald eyes, four white paws, and a plain blue collar.',
        wardrobeOrSurface: 'Short orange tabby coat, four white paws, and one unmarked blue collar.',
        props: [],
        identityAnchors: ['orange tabby stripes', 'emerald eyes', 'four white paws', 'plain blue collar'],
      }],
      environment: {
        location: 'A clean concrete driveway directly in front of one weathered brick garage.',
        backgroundAnchors: ['red compact car', 'weathered brick garage', 'silver closed garage door'],
        timeOfDay: 'Warm late afternoon',
        weatherOrAtmosphere: 'Dry still air with no wind or precipitation',
      },
      lighting: 'Warm sunlight from frame left with one soft shadow direction and fixed exposure.',
      colorPalette: ['warm orange', 'muted brick red', 'steel gray', 'collar blue'],
      cameraLanguage: 'Cat-eye-height thirty-five millimeter lens with one slow constant lateral dolly.',
      supportingAnchors: ['red compact car remains parked', 'garage door remains closed', 'driveway stays empty'],
      negativeConstraints: ['no identity drift', 'no new objects', 'no text or watermark', 'no lighting change'],
    },
    visualPrompt:
      'Create one continuous shot of the same small orange tabby crossing the driveway toward the same red compact car, '
      + 'preserving its emerald eyes, four white paws, blue collar, late-afternoon light, brick garage, and every timed action.',
    cameraMotion: 'slow pan right',
    cameraDirection: 'Use one slow left-to-right dolly at cat-eye height with constant lens, exposure, and screen direction.',
    negativePrompt: 'No jump cuts, identity drift, duplicate animals, malformed paws, captions, logos, or watermark.',
    timelineBeats,
    foleyCues: [{
      cueId: 'paw-contact',
      atSeconds: 1,
      sound: 'One crisp cat paw contact on the concrete driveway.',
      durationSeconds: 0.5,
      intensity: 'medium',
      spatialPosition: 'center',
      category: 'movement',
      prominence: 'foreground',
      visualAction: contactAction,
      continuous: false,
      timingClass: 'must_sync',
    }],
    music: {
      enabled: true,
      prompt: 'A playful but restrained instrumental cue that supports the complete continuous visual story.',
      negativePrompt: 'No vocals, Foley, loud impacts, distortion, creature sounds, or tempo drift.',
      durationSeconds: totalDurationSeconds,
      genre: 'light cinematic pizzicato',
      featuredInstrument: 'pizzicato strings',
      mood: 'Playful curiosity with a gentle sense of anticipation',
      role: 'background',
      tempoBpm: 96,
      syncStrategy: 'Use two connected phrases while leaving the timed foreground paw contact unobscured.',
      beats: timelineBeats.map((beat) => ({
        beatId: beat.beatId,
        startSeconds: beat.startSeconds,
        endSeconds: beat.endSeconds,
        direction: `Keep a restrained phrase beneath the ${beat.beatId} visual window.`,
      })),
    },
    delivery: {
      visualStyle: 'cinematic',
      aspectRatio: '16:9',
      width: 1280,
      height: 704,
      fps: 24,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
    },
  };
}

function withoutBackgroundMusic(plan = makePlan()): any {
  const value = structuredClone(plan);
  value.music = {
    enabled: false,
    reason: 'The user explicitly requested Foley-only output without any background music.',
  };
  return value;
}

function addSoundCue(
  plan: any,
  input: {
    cueId: string;
    atSeconds: number;
    continuous?: boolean;
    prominence?: 'foreground' | 'supporting' | 'ambient';
    timingClass?: 'must_sync' | 'approximate';
  },
): void {
  const visualAction = `The visible subject causes the natural sound identified as ${input.cueId}.`;
  const containingBeat = plan.timelineBeats.find((beat: any) =>
    input.atSeconds >= beat.startSeconds && input.atSeconds < beat.endSeconds,
  );
  assert.ok(containingBeat);
  containingBeat.visualAction += ` [${input.atSeconds.toFixed(2)}s] ${visualAction}`;
  plan.foleyCues.push({
    cueId: input.cueId,
    atSeconds: input.atSeconds,
    sound: `One natural, clearly audible ${input.cueId} sound from the visible subject.`,
    durationSeconds: input.continuous ? plan.totalDurationSeconds - input.atSeconds : 0.3,
    intensity: 'medium',
    spatialPosition: 'center',
    category: input.continuous ? 'ambience' : 'movement',
    prominence: input.prominence ?? 'foreground',
    visualAction,
    continuous: input.continuous ?? false,
    timingClass: input.timingClass ?? 'must_sync',
  });
}

test('VideoPlanSchema accepts the current single-render contract', () => {
  const plan = VideoPlanSchema.parse(makePlan());
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.totalDurationSeconds, 8);
  assert.equal(plan.timelineBeats.length, 2);
  assert.equal('scenes' in plan, false);
});

test('VideoPlan supports every integer duration from four through twelve seconds', () => {
  for (let duration = MIN_VIDEO_DURATION_SECONDS; duration <= MAX_VIDEO_DURATION_SECONDS; duration += 1) {
    const result = VideoPlanSchema.safeParse(makePlan(duration));
    assert.equal(result.success, true, `${duration}s: ${result.success ? '' : result.error.message}`);
  }
  assert.equal(MIN_VIDEO_DURATION_SECONDS, 4);
  assert.equal(MAX_VIDEO_DURATION_SECONDS, 12);
  assert.equal(MAX_TIMELINE_BEATS, 8);

  assert.equal(VideoPlanSchema.safeParse(makePlan(3)).success, false);
  assert.equal(VideoPlanSchema.safeParse(makePlan(13)).success, false);
  assert.equal(VideoPlanSchema.safeParse(makePlan(7.5)).success, false);
});

test('VideoPlan accepts every supported run-wide visual style, aspect ratio, and camera motion', () => {
  const visualStyles = [
    'cinematic', 'animation', 'realistic', 'artistic', 'vintage', 'anime',
    'film-noir', 'documentary', 'commercial', 'music-video',
  ];
  const aspectRatios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
  const cameraMotions = [
    'static', 'slow pan left', 'slow pan right', 'slow tilt up', 'slow tilt down',
    'slow zoom in', 'slow zoom out', 'slow orbit around', 'handheld shaky',
    'dolly forward', 'crane up',
  ];

  for (const visualStyle of visualStyles) {
    const plan = makePlan();
    plan.delivery.visualStyle = visualStyle;
    assert.equal(VideoPlanSchema.safeParse(plan).success, true, visualStyle);
  }
  for (const aspectRatio of aspectRatios) {
    const plan = makePlan();
    plan.delivery.aspectRatio = aspectRatio;
    assert.equal(VideoPlanSchema.safeParse(plan).success, true, aspectRatio);
  }
  for (const cameraMotion of cameraMotions) {
    const plan = makePlan();
    plan.cameraMotion = cameraMotion;
    assert.equal(VideoPlanSchema.safeParse(plan).success, true, cameraMotion);
  }

  const unsupported = makePlan();
  unsupported.cameraMotion = 'fast whip pan';
  assert.equal(VideoPlanSchema.safeParse(unsupported).success, false);
});

test('VideoPlan keeps the run-wide negative bible separate from the provider negative prompt', () => {
  const plan = makePlan();
  plan.continuityBible.negativeConstraints = [
    'no captions or visible text',
    'no extra animals in the driveway',
    'no identity or wardrobe changes',
  ];
  plan.negativePrompt = 'No duplicate cat, malformed paws, camera discontinuity, captions, logos, or watermark.';

  const parsed = VideoPlanSchema.parse(plan);
  assert.deepEqual(parsed.continuityBible.negativeConstraints, plan.continuityBible.negativeConstraints);
  assert.equal(parsed.negativePrompt, plan.negativePrompt);
});

test('timeline beats must be unique, gap-free, positive, and cover the whole render', () => {
  const gap = makePlan();
  gap.timelineBeats[1].startSeconds = 5;
  assert.equal(VideoPlanSchema.safeParse(gap).success, false);

  const overlap = makePlan();
  overlap.timelineBeats[1].startSeconds = 3;
  assert.equal(VideoPlanSchema.safeParse(overlap).success, false);

  const nonPositive = makePlan();
  nonPositive.timelineBeats[0].endSeconds = 0;
  assert.equal(VideoPlanSchema.safeParse(nonPositive).success, false);

  const wrongEnd = makePlan();
  wrongEnd.timelineBeats[1].endSeconds = 7;
  assert.equal(VideoPlanSchema.safeParse(wrongEnd).success, false);

  const duplicateId = makePlan();
  duplicateId.timelineBeats[1].beatId = duplicateId.timelineBeats[0].beatId;
  assert.equal(VideoPlanSchema.safeParse(duplicateId).success, false);
});

test('global Foley cues use hundredth-second timing and share their exact visible action timestamp', () => {
  const imprecise = makePlan();
  imprecise.foleyCues[0].atSeconds = 1.005;
  assert.equal(VideoPlanSchema.safeParse(imprecise).success, false);

  const missingTimedAction = makePlan();
  missingTimedAction.timelineBeats[0].visualAction = 'The cat crosses the driveway without a shared canonical audiovisual timestamp.';
  const missingResult = VideoPlanSchema.safeParse(missingTimedAction);
  assert.equal(missingResult.success, false);
  if (!missingResult.success) assert.match(missingResult.error.message, /containing beat.*shared timed action/i);

  const duplicateCueId = makePlan();
  duplicateCueId.foleyCues.push(structuredClone(duplicateCueId.foleyCues[0]));
  assert.equal(VideoPlanSchema.safeParse(duplicateCueId).success, false);
});

test('Foley cues must fit the final timeline and protect must-sync transients at its boundaries', () => {
  const overrun = makePlan();
  overrun.foleyCues[0].atSeconds = 7.8;
  overrun.foleyCues[0].durationSeconds = 0.5;
  overrun.timelineBeats[1].visualAction = `[7.80s] ${overrun.foleyCues[0].visualAction}`;
  const overrunResult = VideoPlanSchema.safeParse(overrun);
  assert.equal(overrunResult.success, false);
  if (!overrunResult.success) assert.match(overrunResult.error.message, /must end by 8\.00 seconds/i);

  const boundaryTransient = makePlan();
  boundaryTransient.foleyCues[0].atSeconds = 0.1;
  boundaryTransient.timelineBeats[0].visualAction = `[0.10s] ${boundaryTransient.foleyCues[0].visualAction}`;
  const boundaryResult = VideoPlanSchema.safeParse(boundaryTransient);
  assert.equal(boundaryResult.success, false);
  if (!boundaryResult.success) assert.match(boundaryResult.error.message, /at least 0\.20s/i);
});

test('an empty global Foley cue list deliberately represents a silent Foley stem', () => {
  const plan = makePlan();
  plan.foleyCues = [];
  assert.equal(VideoPlanSchema.safeParse(plan).success, true);
});

test('new-plan audio policy accepts sparse cues and exempts continuous ambience from transient limits', () => {
  const plan = makePlan();
  addSoundCue(plan, {
    cueId: 'driveway-ambience',
    atSeconds: 0,
    continuous: true,
    prominence: 'ambient',
    timingClass: 'approximate',
  });
  addSoundCue(plan, {
    cueId: 'second-ambience-layer',
    atSeconds: 0,
    continuous: true,
    prominence: 'foreground',
    timingClass: 'must_sync',
  });

  const parsed = VideoPlanSchema.parse(plan);
  assert.equal(validateNewVideoPlanAudioChoreography(parsed), parsed);
  assert.equal(MIN_MUST_SYNC_TRANSIENT_SPACING_SECONDS, 1.5);
});

test('new-plan audio policy rejects crowded must-sync cues without invalidating retained schema-v2 plans', () => {
  const plan = makePlan();
  addSoundCue(plan, { cueId: 'crowded-contact', atSeconds: 2 });

  // Retained plans remain parseable; only new-plan validation applies the
  // stricter choreography policy.
  const retainedPlan = VideoPlanSchema.parse(plan);
  assert.throws(
    () => validateNewVideoPlanAudioChoreography(retainedPlan),
    (error: unknown) => {
      assert.ok(error instanceof VideoPlanAudioChoreographyError);
      assert.match(error.message, /at most one is allowed per beat/i);
      assert.match(error.message, /require at least 1\.50 seconds/i);
      return true;
    },
  );
});

test('new-plan audio policy enforces duration-sensitive foreground transient budgets', () => {
  const shortPlan = makePlan(8);
  addSoundCue(shortPlan, { cueId: 'short-two', atSeconds: 2.5, timingClass: 'approximate' });
  addSoundCue(shortPlan, { cueId: 'short-three', atSeconds: 4.5, timingClass: 'approximate' });
  assert.doesNotThrow(() => validateNewVideoPlanAudioChoreography(VideoPlanSchema.parse(shortPlan)));
  addSoundCue(shortPlan, { cueId: 'short-four', atSeconds: 6.5, timingClass: 'approximate' });
  assert.throws(
    () => validateNewVideoPlanAudioChoreography(VideoPlanSchema.parse(shortPlan)),
    new RegExp(`at most ${MAX_SHORT_FOREGROUND_TRANSIENTS} foreground transients`, 'i'),
  );

  const longPlan = makePlan(12);
  addSoundCue(longPlan, { cueId: 'long-two', atSeconds: 2.5, timingClass: 'approximate' });
  addSoundCue(longPlan, { cueId: 'long-three', atSeconds: 4, timingClass: 'approximate' });
  addSoundCue(longPlan, { cueId: 'long-four', atSeconds: 7, timingClass: 'approximate' });
  assert.doesNotThrow(() => validateNewVideoPlanAudioChoreography(VideoPlanSchema.parse(longPlan)));
  addSoundCue(longPlan, { cueId: 'long-five', atSeconds: 9, timingClass: 'approximate' });
  assert.throws(
    () => validateNewVideoPlanAudioChoreography(VideoPlanSchema.parse(longPlan)),
    new RegExp(`at most ${MAX_LONG_FOREGROUND_TRANSIENTS} foreground transients`, 'i'),
  );
});

test('enabled music must use the same duration, beat IDs, and windows as the visual timeline', () => {
  const wrongDuration = makePlan();
  wrongDuration.music.durationSeconds = 7;
  assert.equal(VideoPlanSchema.safeParse(wrongDuration).success, false);

  const missingBeat = makePlan();
  missingBeat.music.beats.pop();
  assert.equal(VideoPlanSchema.safeParse(missingBeat).success, false);

  const wrongBeatId = makePlan();
  wrongBeatId.music.beats[1].beatId = 'different-beat';
  assert.equal(VideoPlanSchema.safeParse(wrongBeatId).success, false);

  const wrongBeatWindow = makePlan();
  wrongBeatWindow.music.beats[1].startSeconds = 5;
  assert.equal(VideoPlanSchema.safeParse(wrongBeatWindow).success, false);
});

test('prompt-derived music mode is enforced in both directions', () => {
  const normalPrompt = 'Create a cinematic cat video beside a red car.';
  assert.doesNotThrow(() => parseVideoPlanForPrompt(makePlan(), normalPrompt));

  const foleyOnlyPrompt = 'Create a cat video with Foley only and no background music.';
  assert.doesNotThrow(() => parseVideoPlanForPrompt(withoutBackgroundMusic(), foleyOnlyPrompt));
  assert.throws(() => parseVideoPlanForPrompt(makePlan(), foleyOnlyPrompt), /must use music\.enabled=false/i);
  assert.throws(() => parseVideoPlanForPrompt(withoutBackgroundMusic(), normalPrompt), /cannot disable background music/i);
});

test('the standalone plan validator returns recoverable feedback and keeps a locked plan immutable', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'single-render-plan-validation-'));
  const originalPrompt = 'Create a cinematic cat video beside a red car.';
  const promptHash = new VideoRunStateStore(temporaryRoot).promptHash(originalPrompt);
  const runDirectory = path.join(temporaryRoot, promptHash);
  try {
    const stateStore = new VideoRunStateStore(runDirectory);
    const validator = createValidateVideoPlanTool(originalPrompt, stateStore);

    const rejected = JSON.parse(String(await validator.invoke({ plan: withoutBackgroundMusic() } as never))) as Record<string, unknown>;
    assert.deepEqual(
      { status: rejected.status, valid: rejected.valid, recoverable: rejected.recoverable, code: rejected.code },
      { status: 'rejected', valid: false, recoverable: true, code: 'VIDEO_PLAN_PROMPT_MISMATCH' },
    );
    assert.equal(await stateStore.loadPlan(originalPrompt), null);

    const stored = JSON.parse(String(await validator.invoke({ plan: makePlan() } as never))) as Record<string, unknown>;
    assert.equal(stored.status, 'stored');
    assert.equal(stored.timelineBeatCount, 2);
    assert.equal(stored.totalDurationSeconds, 8);

    const reused = JSON.parse(String(await validator.invoke({ plan: makePlan(12) } as never))) as Record<string, unknown>;
    assert.equal(reused.status, 'reused');
    assert.equal(reused.changedPlanRejected, true);
    assert.equal((await stateStore.loadPlan(originalPrompt))?.totalDurationSeconds, 8);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('music helpers expose the enabled or explicitly disabled global mode', () => {
  const enabled = VideoPlanSchema.parse(makePlan());
  assert.equal(enabledMusicForPlan(enabled)?.enabled, true);
  assert.equal(planUsesBackgroundMusic(enabled), true);

  const disabled = VideoPlanSchema.parse(withoutBackgroundMusic());
  assert.equal(enabledMusicForPlan(disabled), null);
  assert.equal(planUsesBackgroundMusic(disabled), false);
});

test('VideoPlan rejects obsolete scene arrays and other unknown top-level fields', () => {
  assert.equal(VideoPlanSchema.safeParse({ ...makePlan(), scenes: [] }).success, false);
  assert.equal(VideoPlanSchema.safeParse({ ...makePlan(), unexpected: true }).success, false);
});

test('YouTube intent recognition is conservative and prompt-derived metadata is exact', () => {
  const uploadPrompt = bindYouTubeUploadAuthorization('Create a cat video.', true);
  assert.equal(promptExplicitlyRequestsYouTubeUpload(uploadPrompt), true);
  assert.equal(promptExplicitlyRequestsYouTubeUpload('Create a video for YouTube and upload it.'), false);
  assert.equal(promptExplicitlyRequestsYouTubeUpload('Upload this as a YouTube Short.'), false);
  assert.equal(promptExplicitlyRequestsYouTubeUpload('Upload the video to my YouTube channel.'), false);
  assert.equal(promptExplicitlyRequestsYouTubeUpload('Create a tutorial about how to upload videos to YouTube.'), false);
  assert.equal(promptExplicitlyRequestsYouTubeUpload('Create a cat video. Do not upload the final video to YouTube.'), false);

  assert.throws(() => parseVideoPlanForPrompt(makePlan(), uploadPrompt), VideoPlanPromptMismatchError);
  const withYouTube = makePlan();
  withYouTube.youtubeUpload = {
    requested: true,
    title: 'The Curious Cat and the Red Car',
    description: 'A short AI-generated continuous video.',
    tags: ['cat', 'short-video', 'animal story', 'AI video', 'cinematic'],
    categoryId: '15',
    privacyStatus: 'private',
    madeForKids: false,
  };
  const parsed = parseVideoPlanForPrompt(withYouTube, uploadPrompt);
  assert.equal(parsed.youtubeUpload?.requested, true);
  assert.equal(parsed.youtubeUpload?.categoryId, '15');
  assert.throws(() => parseVideoPlanForPrompt(withYouTube, 'Create a cat video.'), VideoPlanPromptMismatchError);

  for (const invalidMetadata of [
    { ...withYouTube.youtubeUpload, title: 'Bad <title>' },
    { ...withYouTube.youtubeUpload, description: '' },
    { ...withYouTube.youtubeUpload, description: 'Bad <description>' },
    { ...withYouTube.youtubeUpload, description: '😀'.repeat(1_251) },
    { ...withYouTube.youtubeUpload, tags: ['duplicate', 'DUPLICATE', 'three', 'four', 'five'] },
    { ...withYouTube.youtubeUpload, tags: Array.from({ length: 6 }, (_, index) => `${index}-${'x'.repeat(90)}`) },
    { ...withYouTube.youtubeUpload, categoryId: '999' },
  ]) {
    assert.equal(VideoPlanSchema.safeParse({
      ...withYouTube,
      youtubeUpload: invalidMetadata,
    }).success, false);
  }
});
