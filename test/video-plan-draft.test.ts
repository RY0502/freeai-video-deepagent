import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DynamicStructuredTool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { z } from 'zod';

import {
  VideoPlanDraftInputSchema,
  VideoPlanDraftTransportError,
  materializeVideoPlanDraft,
  parseVideoPlanDraft,
} from '../src/agent/videoPlanDraft.js';
import { VideoPlanSchema, validateNewVideoPlanAudioChoreography } from '../src/agent/videoPlan.js';
import { bindYouTubeUploadAuthorization } from '../src/authorization.js';
import { loadConfig } from '../src/config.js';
import type { AgnesVideoClient } from '../src/agnes/index.js';
import type { ElevenLabsClient } from '../src/elevenlabs/index.js';
import type { FreeAiMusicClient } from '../src/freeai/index.js';
import { VideoRunStateStore } from '../src/state/videoRunState.js';
import {
  VIDEO_TOOL_NAMES,
  agnesVideoPrompt,
  createVideoAgentTools,
  sanitizeAgnesVideoPrompt,
} from '../src/tools/videoAgentTools.js';

function chickenDraft(): unknown {
  return {
    concept: 'A proud little chicken crosses a quiet road twice for a comic payoff.',
    creativeScript:
      'A small chicken checks both directions, puffs out its chest, and marches across a quiet country road. '
      + 'After reaching safety it says “Wait”, walks back with complete seriousness, says “Forgot something”, and clucks after the punchline.',
    totalDurationSeconds: 12,
    continuityBible: {
      visualStyle: 'Warm expressive animation with cinematic staging and restrained comic exaggeration.',
      subjects: [{
        name: 'little-chicken',
        role: 'primary',
        invariantAppearance: 'A small golden chicken with a red comb, round eyes, and short orange legs.',
        identityAnchors: ['golden feathers', 'red comb', 'round eyes'],
      }],
      environment: {
        location: 'A quiet two-lane country road bordered by grass and a wooden fence.',
        backgroundAnchors: ['wooden fence', 'green roadside grass'],
        timeOfDay: 'Warm late afternoon',
      },
      colorPalette: ['warm gold', 'grass green', 'asphalt gray'],
    },
    visualPrompt:
      'Animate one continuous wide shot in which the same little chicken checks the road, crosses proudly, pauses, '
      + 'then returns to its original spot as one car passes safely in the distant background.',
    cameraMotion: 'slow pan right',
    cameraDirection: 'Track the chicken laterally without cutting or reversing established screen direction.',
    timelineBeats: [
      {
        durationWeight: 2,
        narrativePurpose: 'Establish the cautious check and confident decision to cross.',
        visualAction: 'The chicken looks left and right, then puffs out its chest beside the empty road.',
      },
      {
        durationWeight: 3,
        narrativePurpose: 'Develop the proud outward crossing and safe arrival.',
        visualAction: 'The chicken marches across and reaches the far verge while a distant car remains safely behind.',
      },
      {
        durationWeight: 2,
        narrativePurpose: 'Deliver the reversal and compact comic payoff.',
        visualAction: 'The chicken says “Wait”, turns, walks back, faces camera at its starting spot, says “Forgot something”, and clucks after the punchline.',
      },
    ],
    foleyCues: [
      {
        beatNumber: 2,
        placement: 'middle',
        sound: 'Soft rhythmic chicken footsteps on the paved road.',
        visualAction: 'The chicken feet make clear alternating contact with the road.',
        category: 'movement',
        timingClass: 'must_sync',
      },
      {
        beatNumber: 3,
        placement: 'end',
        sound: 'One funny natural cluck after the punchline.',
        visualAction: 'The chicken opens its beak and visibly produces one final cluck.',
        category: 'creature_vocalization',
        prominence: 'foreground',
        timingClass: 'must_sync',
      },
    ],
    music: {
      genre: 'light orchestral comedy',
      mood: 'Playful and mock heroic',
      tempoBpm: 94,
      featuredInstrument: 'pizzicato strings',
      beatDirections: ['Begin with suspense.', 'Grow mock heroic.', 'Land the joke lightly.'],
    },
    youtubeUpload: {
      title: 'The Chicken Forgot Something',
      description: 'A very serious road crossing takes an unexpected turn.',
      tags: ['funny chicken', 'animated comedy', 'country road', 'short film', 'visual storytelling'],
      categoryId: '23',
    },
  };
}

test('planner-facing schema stays substantially smaller than the persisted plan schema', () => {
  const schemaBytes = (name: string, schema: z.ZodTypeAny): number => {
    const tool = new DynamicStructuredTool({
      name,
      description: 'Schema-size regression fixture.',
      schema,
      func: async () => '',
    });
    return Buffer.byteLength(JSON.stringify(convertToOpenAITool(tool)));
  };
  const fullBytes = schemaBytes('full_video_plan', z.object({ plan: VideoPlanSchema }).strict());
  const draftBytes = schemaBytes('creative_video_draft', VideoPlanDraftInputSchema);
  const draftJson = JSON.stringify(convertToOpenAITool(new DynamicStructuredTool({
    name: 'creative_video_draft_fields',
    description: 'Schema-field regression fixture.',
    schema: VideoPlanDraftInputSchema,
    func: async () => '',
  })));

  assert.ok(draftBytes < fullBytes * 0.7, `${draftBytes} should be much smaller than ${fullBytes}`);
  for (const hostDerivedField of ['startSeconds', 'endSeconds', 'beatId', 'cueId', 'delivery']) {
    assert.equal(draftJson.includes(`\"${hostDerivedField}\"`), false);
  }
});

test('materializer converts a compact creative draft into a strict trusted schema-v2 plan', () => {
  const originalPrompt = bindYouTubeUploadAuthorization(
    'Create a funny 12-second animated video of a chicken crossing a road. Upload it to YouTube.',
    true,
  );
  const config = loadConfig({
    VIDEO_ASPECT_RATIO: '9:16',
    VIDEO_FPS: '30',
    YOUTUBE_DEFAULT_PRIVACY: 'unlisted',
    YOUTUBE_DEFAULT_MADE_FOR_KIDS: 'false',
  });
  const plan = materializeVideoPlanDraft(chickenDraft(), { originalPrompt, config });

  assert.equal(VideoPlanSchema.safeParse(plan).success, true);
  assert.doesNotThrow(() => validateNewVideoPlanAudioChoreography(plan));
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.totalDurationSeconds, 12);
  assert.equal(plan.delivery.visualStyle, 'animation');
  assert.equal(plan.delivery.aspectRatio, '9:16');
  assert.equal(plan.delivery.width, 720);
  assert.equal(plan.delivery.height, 1280);
  assert.equal(plan.delivery.fps, 30);

  assert.deepEqual(plan.timelineBeats.map((beat) => beat.beatId), ['beat-01', 'beat-02', 'beat-03']);
  assert.equal(plan.timelineBeats[0]?.startSeconds, 0);
  assert.equal(plan.timelineBeats.at(-1)?.endSeconds, 12);
  for (let index = 1; index < plan.timelineBeats.length; index += 1) {
    assert.equal(plan.timelineBeats[index]?.startSeconds, plan.timelineBeats[index - 1]?.endSeconds);
  }
  for (const cue of plan.foleyCues) {
    const beat = plan.timelineBeats.find((candidate) =>
      cue.atSeconds >= candidate.startSeconds && cue.atSeconds < candidate.endSeconds,
    );
    assert.ok(beat);
    assert.match(beat.visualAction, new RegExp(`\\[${cue.atSeconds.toFixed(2)}s\\]`));
  }
  assert.deepEqual(plan.foleyCues.map((cue) => cue.cueId), ['cue-01', 'cue-02']);
  assert.equal(plan.music.enabled, true);
  if (plan.music.enabled) {
    assert.deepEqual(
      plan.music.beats.map(({ beatId, startSeconds, endSeconds }) => ({ beatId, startSeconds, endSeconds })),
      plan.timelineBeats.map(({ beatId, startSeconds, endSeconds }) => ({ beatId, startSeconds, endSeconds })),
    );
  }
  assert.equal(plan.youtubeUpload?.privacyStatus, 'unlisted');
  assert.equal(plan.youtubeUpload?.madeForKids, false);
  assert.equal(plan.youtubeUpload?.title, 'The Chicken Forgot Something');
});

test('materializer derives duration, delivery, music denial, and stable IDs instead of trusting model controls', () => {
  const input = chickenDraft() as Record<string, unknown>;
  delete input.totalDurationSeconds;
  const proposedYoutube = input.youtubeUpload as Record<string, unknown>;
  proposedYoutube.privacyStatus = 'public';
  proposedYoutube.madeForKids = true;
  input.delivery = { visualStyle: 'anime', aspectRatio: '1:1', width: 1, height: 1, fps: 60 };
  input.schemaVersion = 999;

  const originalPrompt = 'Make this cinematic 16:9 video with no background music.';
  const first = materializeVideoPlanDraft(input, { originalPrompt, config: loadConfig({}) });
  const second = materializeVideoPlanDraft(input, { originalPrompt, config: loadConfig({}) });

  assert.equal(first.totalDurationSeconds, 10);
  assert.equal(first.delivery.visualStyle, 'cinematic');
  assert.equal(first.delivery.aspectRatio, '16:9');
  assert.equal(first.music.enabled, false);
  assert.equal(first.youtubeUpload, undefined);
  assert.deepEqual(first, second);
});

test('draft transport requires a direct object and reports only compact validation issues', () => {
  assert.equal(VideoPlanDraftInputSchema.safeParse({ plan: JSON.stringify(chickenDraft()) }).success, false);
  assert.throws(
    () => parseVideoPlanDraft(JSON.stringify(chickenDraft())),
    (error: unknown) => error instanceof VideoPlanDraftTransportError
      && /must be a JSON object, not a string/i.test(error.message)
      && error.message.length < 160,
  );
  assert.throws(
    () => parseVideoPlanDraft({ concept: 'incomplete' }),
    (error: unknown) => error instanceof VideoPlanDraftTransportError
      && /creativeScript/.test(error.message)
      && error.message.length < 700,
  );
});

test('materializer makes dense transient timing safe without discarding the creative cues', () => {
  const input = chickenDraft() as any;
  input.foleyCues = Array.from({ length: 6 }, (_, index) => ({
    beatNumber: 2,
    placement: index % 2 === 0 ? 'middle' : 'late',
    sound: `Visible comic impact number ${index + 1}`,
    visualAction: `The chicken visibly causes comic impact number ${index + 1} on the road.`,
    category: 'impact',
    prominence: 'foreground',
    timingClass: 'must_sync',
  }));
  const plan = materializeVideoPlanDraft(input, {
    originalPrompt: 'Create a 12-second animation with background music.',
    config: loadConfig({}),
  });

  assert.equal(plan.foleyCues.length, 6);
  assert.equal(plan.foleyCues.filter((cue) => cue.timingClass === 'must_sync').length, 1);
  assert.equal(plan.foleyCues.filter((cue) => !cue.continuous && cue.prominence === 'foreground').length, 4);
  assert.doesNotThrow(() => validateNewVideoPlanAudioChoreography(plan));
});

test('materializer keeps untrusted YouTube tag copy within aggregate schema limits', () => {
  const input = chickenDraft() as any;
  input.youtubeUpload.tags = Array.from(
    { length: 12 },
    (_, index) => `${index}-${'long-tag-content-'.repeat(8)}`,
  );
  const plan = materializeVideoPlanDraft(input, {
    originalPrompt: bindYouTubeUploadAuthorization('Create a 12-second animated chicken video.', true),
    config: loadConfig({}),
  });

  assert.ok(plan.youtubeUpload);
  assert.ok(plan.youtubeUpload.tags.length >= 5);
  assert.ok(plan.youtubeUpload.tags.length <= 12);
  assert.equal(VideoPlanSchema.safeParse(plan).success, true);
});

test('the production validator stores a compact draft as a strict plan without echoing it back', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-director-draft-tool-'));
  const originalPrompt = [
    'Create a funny 12-second animated video of a cute little chicken standing beside a quiet country road.',
    'The chicken looks left, looks right, confidently puffs out its chest, and begins crossing the road.',
    'Add dramatic heroic music as the chicken walks proudly toward the other side.',
    'The chicken reaches the other side, stops, looks around, and suddenly notices something.',
    'It looks back across the road.',
    'The chicken says, “Wait…”',
    'It immediately turns around and confidently walks back across the road in the opposite direction.',
    'A car passes safely in the background while the chicken keeps walking completely seriously.',
    'End with the chicken reaching its original spot, looking at the camera and saying, “Forgot something.”',
    'Add a funny chicken cluck immediately after the punchline.',
  ].join(' ');
  const runDirectory = path.join(root, 'run');
  const stateStore = new VideoRunStateStore(runDirectory);

  try {
    const bundle = createVideoAgentTools({
      originalPrompt,
      runDirectory,
      config: loadConfig({}),
      stateStore,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
    });
    const validator = bundle.tools.find(({ name }) => name === VIDEO_TOOL_NAMES.validatePlan);
    assert.ok(validator);

    const result = JSON.parse(String(await validator.invoke({ plan: chickenDraft() } as never))) as {
      status?: string;
      valid?: boolean;
      timelineBeatCount?: number;
      plan?: unknown;
    };
    assert.equal(result.status, 'stored');
    assert.equal(result.valid, true);
    assert.equal(result.timelineBeatCount, 3);
    assert.equal(result.plan, undefined);

    const stored = await stateStore.loadPlan(originalPrompt);
    assert.ok(stored);
    assert.equal(stored.schemaVersion, 2);
    assert.equal(stored.totalDurationSeconds, 12);
    assert.equal(stored.delivery.visualStyle, 'animation');
    assert.equal(stored.foleyCues.some(({ sound }) => /cluck/i.test(sound)), true);
    assert.equal(stored.foleyCues.some(({ continuous, category }) =>
      continuous && category === 'vehicle'), false);
    assert.equal(stored.music.enabled, true);
    if (stored.music.enabled) assert.equal(stored.music.genre, 'dramatic heroic');
    if (stored.music.enabled) assert.equal(stored.music.mood, 'Dramatic and heroic');
    if (stored.music.enabled) assert.match(stored.music.prompt, /dramatic heroic/i);
    if (stored.music.enabled) assert.doesNotMatch(stored.music.prompt, /orchestral comedy|playful/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the production validator repairs the real NVIDIA draft that preserved but omitted the requested cluck cue', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-director-real-nvidia-draft-'));
  const originalPrompt = [
    'Create a funny 12-second animated video of a cute little chicken standing beside a quiet country road.',
    'The chicken looks left, looks right, confidently puffs out its chest, and begins crossing the road.',
    'Add dramatic heroic music as the chicken walks proudly toward the other side.',
    'The chicken reaches the other side, stops, looks around, and suddenly notices something.',
    'It looks back across the road. The chicken says, “Wait…”',
    'It immediately turns around and confidently walks back across the road in the opposite direction.',
    'A car passes safely in the background while the chicken keeps walking completely seriously.',
    'End with the chicken reaching its original spot, looking at the camera and saying, “Forgot something.”',
    'Add a funny chicken cluck immediately after the punchline.',
  ].join(' ');
  const input = chickenDraft() as any;
  input.visualPrompt = [
    'A cute little chicken checks a quiet country road and crosses it proudly.',
    'Dramatic heroic music plays as the chicken walks toward the other side.',
    'It says “Wait”, returns while a car passes safely in the background, says “Forgot something”, then clucks.',
  ].join(' ');
  input.timelineBeats = [
    {
      durationWeight: 1,
      narrativePurpose: 'Establish the chicken and its confident preparation.',
      visualAction: 'The chicken looks left and right, puffs out its chest, and starts crossing.',
    },
    {
      durationWeight: 1,
      narrativePurpose: 'Show the first proud crossing and discovery.',
      visualAction: 'The chicken walks across, reaches the far side, notices something, and says “Wait”.',
    },
    {
      durationWeight: 1,
      narrativePurpose: 'Show the serious return and safe background car.',
      visualAction: 'The chicken walks back while a car passes safely in the distant background.',
    },
    {
      durationWeight: 1,
      narrativePurpose: 'Deliver the spoken punchline and final cluck.',
      visualAction: 'The chicken reaches its original spot, says “Forgot something”, then gives one funny cluck.',
    },
  ];
  input.foleyCues = [
    {
      beatNumber: 1,
      placement: 'start',
      sound: 'chicken looking left and right',
      visualAction: 'chicken head turns left then right',
      continuous: false,
      timingClass: 'must_sync',
    },
    {
      beatNumber: 1,
      placement: 'early',
      sound: 'chest puff',
      visualAction: 'chicken inflates its chest feathers',
      continuous: false,
      timingClass: 'must_sync',
    },
    {
      beatNumber: 2,
      placement: 'middle',
      sound: 'chicken walking on gravel',
      visualAction: 'chicken walking across the road',
      continuous: true,
      timingClass: 'approximate',
    },
    {
      beatNumber: 2,
      placement: 'end',
      sound: 'car passing by',
      visualAction: 'car drives past in the background',
      continuous: true,
      timingClass: 'approximate',
    },
    {
      beatNumber: 3,
      placement: 'end',
      sound: 'chicken walking on gravel',
      visualAction: 'chicken walking back across the road',
      continuous: true,
      timingClass: 'approximate',
    },
    {
      beatNumber: 4,
      placement: 'end',
      sound: "chicken saying 'Forgot something'",
      visualAction: 'chicken looks at camera and speaks',
      continuous: false,
      timingClass: 'must_sync',
    },
  ];
  const runDirectory = path.join(root, 'run');
  const stateStore = new VideoRunStateStore(runDirectory);
  const events: Array<Record<string, unknown>> = [];

  try {
    const bundle = createVideoAgentTools({
      originalPrompt,
      runDirectory,
      config: loadConfig({}),
      stateStore,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    const validator = bundle.tools.find(({ name }) => name === VIDEO_TOOL_NAMES.validatePlan);
    assert.ok(validator);

    const result = JSON.parse(String(await validator.invoke({ plan: input } as never))) as {
      status?: string;
      valid?: boolean;
    };
    assert.equal(result.status, 'stored');
    assert.equal(result.valid, true);

    const stored = await stateStore.loadPlan(originalPrompt);
    assert.ok(stored);
    assert.equal(stored.foleyCues.some(({ sound, prominence }) =>
      /cluck/i.test(sound) && prominence === 'foreground'), true);
    assert.equal(stored.foleyCues.some(({ sound }) =>
      /looking left and right|chest puff/i.test(sound)), false);
    const dialogue = stored.foleyCues.find(({ sound }) => /Forgot something/i.test(sound));
    const cluck = stored.foleyCues.find(({ sound }) => /cluck/i.test(sound));
    assert.ok(dialogue);
    assert.ok(cluck);
    assert.ok(dialogue.atSeconds < cluck.atSeconds);
    assert.doesNotMatch(sanitizeAgnesVideoPrompt(stored.visualPrompt), /dramatic heroic music plays/i);

    const normalization = events.find(({ event }) => event === 'video_plan_normalized');
    assert.ok(normalization);
    assert.deepEqual(normalization.addedFoleyCues, ['a foreground chicken cluck or crow']);
    assert.deepEqual(normalization.removedFoleyCues, [
      'chicken looking left and right',
      'chest puff',
    ]);
    assert.equal(events.some(({ event }) => event === 'video_plan_rejected'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the production validator accepts a structurally valid draft with a sound coverage warning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-director-explicit-sound-'));
  const originalPrompt = [
    'Create a funny 12-second animated video of a cute little chicken crossing a quiet country road.',
    'Add a funny chicken cluck immediately after the punchline.',
  ].join(' ');
  const input = chickenDraft() as any;
  input.creativeScript = 'A proud bird crosses the road, returns, and gives the camera a comic look.';
  input.visualPrompt = 'Show one small golden bird crossing and returning in a continuous animated shot.';
  input.timelineBeats = input.timelineBeats.map((beat: Record<string, unknown>) => ({
    ...beat,
    visualAction: String(beat.visualAction).replace(/chicken|clucks?/gi, 'bird'),
  }));
  input.foleyCues = input.foleyCues.filter((cue: { sound: string }) => !/cluck/i.test(cue.sound));
  input.concept = 'A proud little bird crosses a quiet road twice for a comic payoff.';
  const runDirectory = path.join(root, 'run');
  const stateStore = new VideoRunStateStore(runDirectory);
  const events: Array<Record<string, unknown>> = [];

  try {
    const bundle = createVideoAgentTools({
      originalPrompt,
      runDirectory,
      config: loadConfig({}),
      stateStore,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    const validator = bundle.tools.find(({ name }) => name === VIDEO_TOOL_NAMES.validatePlan);
    assert.ok(validator);

    const result = JSON.parse(String(await validator.invoke({ plan: input } as never))) as {
      status?: string;
      valid?: boolean;
    };
    assert.equal(result.status, 'stored');
    assert.equal(result.valid, true);

    const warning = events.find(({ event }) => event === 'video_plan_coverage_warning');
    assert.ok(warning);
    assert.deepEqual(warning.missingSounds, ['a foreground chicken cluck or crow']);
    assert.deepEqual(warning.missingDialogue, []);
    assert.equal(warning.originalPromptForwardedToAgnes, true);
    assert.equal(events.some(({ event }) => event === 'video_plan_rejected'), false);

    const stored = await stateStore.loadPlan(originalPrompt);
    assert.ok(stored);
    const providerPrompt = agnesVideoPrompt(stored, originalPrompt);
    assert.match(providerPrompt, /funny chicken cluck immediately after the punchline/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the production validator accepts a structurally valid draft with dialogue coverage warnings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-director-explicit-dialogue-'));
  const originalPrompt = [
    'Create a funny 12-second animated chicken video.',
    'The chicken says, “Wait…” before crossing back.',
    'End with it looking at the camera and saying, “Forgot something.”',
  ].join(' ');
  const input = chickenDraft() as any;
  input.creativeScript = 'The chicken crosses the road, returns, and silently looks into camera.';
  input.visualPrompt = 'Show the same chicken crossing and returning in one continuous animated shot.';
  input.timelineBeats = input.timelineBeats.map((beat: Record<string, unknown>) => ({
    ...beat,
    visualAction: String(beat.visualAction)
      .replace(/says?\s+[“"]Wait[^”"]*[”"]/gi, 'pauses')
      .replace(/says?\s+[“"]Forgot something[^”"]*[”"]/gi, 'looks into camera'),
  }));
  input.foleyCues = input.foleyCues.map((cue: Record<string, unknown>) => ({
    ...cue,
    visualAction: String(cue.visualAction)
      .replace(/says?\s+[“"]Wait[^”"]*[”"]/gi, 'pauses')
      .replace(/says?\s+[“"]Forgot something[^”"]*[”"]/gi, 'looks into camera'),
  }));
  const runDirectory = path.join(root, 'run');
  const stateStore = new VideoRunStateStore(runDirectory);
  const events: Array<Record<string, unknown>> = [];

  try {
    const bundle = createVideoAgentTools({
      originalPrompt,
      runDirectory,
      config: loadConfig({}),
      stateStore,
      agnes: {} as AgnesVideoClient,
      elevenLabs: {} as ElevenLabsClient,
      freeAiMusic: {} as FreeAiMusicClient,
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    const validator = bundle.tools.find(({ name }) => name === VIDEO_TOOL_NAMES.validatePlan);
    assert.ok(validator);

    const result = JSON.parse(String(await validator.invoke({ plan: input } as never))) as {
      status?: string;
      valid?: boolean;
    };
    assert.equal(result.status, 'stored');
    assert.equal(result.valid, true);

    const warning = events.find(({ event }) => event === 'video_plan_coverage_warning');
    assert.ok(warning);
    assert.deepEqual(warning.missingDialogue, ['Wait…', 'Forgot something.']);
    assert.equal(warning.originalPromptForwardedToAgnes, true);
    assert.equal(events.some(({ event }) => event === 'video_plan_rejected'), false);

    const stored = await stateStore.loadPlan(originalPrompt);
    assert.ok(stored);
    const providerPrompt = agnesVideoPrompt(stored, originalPrompt);
    assert.match(providerPrompt, /says, “Wait…” before crossing back/i);
    assert.match(providerPrompt, /saying, “Forgot something\.”/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
