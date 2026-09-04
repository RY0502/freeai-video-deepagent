import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOCUMENTED_ASPECT_RATIO_SUGGESTIONS,
  DOCUMENTED_CAMERA_MOTION_SUGGESTIONS,
  DOCUMENTED_FEATURED_INSTRUMENT_SUGGESTIONS,
  DOCUMENTED_MUSIC_GENRE_SUGGESTIONS,
  DOCUMENTED_VIDEO_STYLE_SUGGESTIONS,
  promptExplicitlyDisablesBackgroundMusic,
  resolvePromptMediaPreferences,
  resolveVideoDimensionsForAspectRatio,
} from '../src/agent/mediaPreferences.js';

const defaults = {
  video: {
    style: 'cinematic' as const,
    aspectRatio: '16:9' as const,
    fps: 24,
  },
};

test('exports the visual controls documented by Agnes and music prompt choices', () => {
  assert.deepEqual(DOCUMENTED_VIDEO_STYLE_SUGGESTIONS, [
    'cinematic',
    'animation',
    'realistic',
    'artistic',
    'vintage',
    'anime',
    'film-noir',
    'documentary',
    'commercial',
    'music-video',
  ]);
  assert.deepEqual(DOCUMENTED_ASPECT_RATIO_SUGGESTIONS, [
    '21:9',
    '16:9',
    '4:3',
    '1:1',
    '3:4',
    '9:16',
  ]);
  assert.deepEqual(DOCUMENTED_CAMERA_MOTION_SUGGESTIONS, [
    'static',
    'slow pan left',
    'slow pan right',
    'slow tilt up',
    'slow tilt down',
    'slow zoom in',
    'slow zoom out',
    'slow orbit around',
    'handheld shaky',
    'dolly forward',
    'crane up',
  ]);
  assert.deepEqual(DOCUMENTED_MUSIC_GENRE_SUGGESTIONS, [
    'pop',
    'rock',
    'jazz',
    'electronic',
    'hip-hop',
    'rnb',
    'classical',
    'country',
    'reggae',
    'metal',
    'ambient',
    'lo-fi',
    'latin',
    'afrobeat',
  ]);
  assert.deepEqual(DOCUMENTED_FEATURED_INSTRUMENT_SUGGESTIONS, [
    'piano',
    'acoustic guitar',
    'electric guitar',
    'saxophone',
    'violin',
    'synth',
    '808s',
    'flute',
    'harp',
    'drums',
  ]);
});

test('uses configured video defaults and leaves unspecified music to the agent', () => {
  assert.deepEqual(
    resolvePromptMediaPreferences('Create a video of two dinosaurs fighting in a jungle.', defaults),
    {
      video: {
        style: 'cinematic',
        aspectRatio: '16:9',
        width: 1280,
        height: 704,
        fps: 24,
        styleSource: 'default',
        aspectRatioSource: 'default',
        cameraMotionSource: 'agent',
        negativePromptSource: 'agent',
      },
      backgroundMusic: {
        enabled: true,
        source: 'default',
      },
      cleanupAfterSuccess: false,
    },
  );
});

test('resolves explicit video and music preferences together', () => {
  const resolved = resolvePromptMediaPreferences(
    'Make it photorealistic in 16 by 9, with rock background music at 128 BPM, '
      + 'an electric-guitar-led soundtrack, and delete local artifacts after successful generation.',
    defaults,
  );

  assert.deepEqual(resolved, {
    video: {
      style: 'realistic',
      aspectRatio: '16:9',
      width: 1280,
      height: 704,
      fps: 24,
      styleSource: 'prompt',
      aspectRatioSource: 'prompt',
      cameraMotionSource: 'agent',
      negativePromptSource: 'agent',
    },
    backgroundMusic: {
      enabled: true,
      source: 'default',
    },
    music: {
      genre: 'rock',
      tempoBpm: 128,
      featuredInstrument: 'electric guitar',
    },
    cleanupAfterSuccess: true,
  });
});

test('extracts only documented, explicitly requested camera motion controls', () => {
  const cameraMotions = [
    'static',
    'slow pan left',
    'slow pan right',
    'slow tilt up',
    'slow tilt down',
    'slow zoom in',
    'slow zoom out',
    'slow orbit around',
    'handheld shaky',
    'dolly forward',
    'crane up',
  ] as const;

  for (const cameraMotion of cameraMotions) {
    const resolved = resolvePromptMediaPreferences(
      `Create a short forest video; camera motion: ${cameraMotion}.`,
      defaults,
    );
    assert.equal(resolved.video.cameraMotion, cameraMotion);
    assert.equal(resolved.video.cameraMotionSource, 'prompt');
    assert.equal(resolved.video.negativePromptSource, 'agent');
  }

  const agentSelected = resolvePromptMediaPreferences(
    'Create a short forest video in which a bird slowly moves left.',
    defaults,
  );
  assert.equal(agentSelected.video.cameraMotion, undefined);
  assert.equal(agentSelected.video.cameraMotionSource, 'agent');
  assert.equal(agentSelected.video.negativePrompt, undefined);
  assert.equal(agentSelected.video.negativePromptSource, 'agent');
});

test('extracts conservative labeled negative-prompt guidance without treating narrative avoidance as a control', () => {
  const explicit = resolvePromptMediaPreferences(
    'Create a video of a fox. Camera motion: crane up. '
      + 'Negative prompt: no text, no duplicate fox, no extra limbs.',
    defaults,
  );
  assert.equal(explicit.video.cameraMotion, 'crane up');
  assert.equal(explicit.video.cameraMotionSource, 'prompt');
  assert.equal(explicit.video.negativePrompt, 'no text, no duplicate fox, no extra limbs');
  assert.equal(explicit.video.negativePromptSource, 'prompt');

  const avoidLabel = resolvePromptMediaPreferences(
    'Create a coastal-road clip; avoid: visible logos, captions, malformed wheels.',
    defaults,
  );
  assert.equal(avoidLabel.video.negativePrompt, 'visible logos, captions, malformed wheels');
  assert.equal(avoidLabel.video.negativePromptSource, 'prompt');

  const semicolonList = resolvePromptMediaPreferences(
    'Create a studio clip. Negative prompt: no text; no logo; no extra limbs.',
    defaults,
  );
  assert.equal(semicolonList.video.negativePrompt, 'no text; no logo; no extra limbs');

  const repeatedLabels = resolvePromptMediaPreferences(
    'Create a studio clip. Negative prompt: no text. Negative constraints: no logo. Avoid: extra limbs.',
    defaults,
  );
  assert.equal(repeatedLabels.video.negativePrompt, 'no text; no logo; extra limbs');

  const narrative = resolvePromptMediaPreferences(
    'A driver avoids a fallen branch while the camera watches from the roadside.',
    defaults,
  );
  assert.equal(narrative.video.negativePrompt, undefined);
  assert.equal(narrative.video.negativePromptSource, 'agent');
  assert.equal(narrative.video.cameraMotion, undefined);

  for (const prompt of [
    'A crane up on the ridge lifts a steel beam into place.',
    'Dolly forward the cart while a fixed roadside camera observes.',
  ]) {
    assert.equal(resolvePromptMediaPreferences(prompt, defaults).video.cameraMotion, undefined, prompt);
  }
});

test('recognizes supported style aliases without changing the provider values', () => {
  const examples = [
    ['a photorealistic fox in snow', 'realistic'],
    ['an animated video about a fox', 'animation'],
    ['an artistic visual style for a fox', 'artistic'],
    ['make the video look retro', 'vintage'],
    ['an anime fox running', 'anime'],
    ['a film-like video of a fox', 'cinematic'],
    ['visual style: animation', 'animation'],
    ['a realistic dinosaur crossing a river in a short video', 'realistic'],
    ['use the film noir preset', 'film-noir'],
    ['documentary style', 'documentary'],
    ['commercial video preset', 'commercial'],
    ['visual style: music video', 'music-video'],
  ] as const;

  for (const [prompt, expectedStyle] of examples) {
    const resolved = resolvePromptMediaPreferences(prompt, defaults);
    assert.equal(resolved.video.style, expectedStyle, prompt);
    assert.equal(resolved.video.styleSource, 'prompt', prompt);
  }
});

test('recognizes exact and common aspect-ratio phrases', () => {
  const examples = [
    ['use 16:9', '16:9'],
    ['make a 9/16 clip', '9:16'],
    ['render at 1×1', '1:1'],
    ['use a widescreen video format', '16:9'],
    ['use portrait orientation', '9:16'],
    ['make a square video', '1:1'],
    ['make it vertical', '9:16'],
    ['use 3:4', '3:4'],
    ['film-noir 21 by 9', '21:9'],
    ['use a vertical feed format', '3:4'],
    ['make the video ultrawide', '21:9'],
  ] as const;

  for (const [prompt, expectedRatio] of examples) {
    const resolved = resolvePromptMediaPreferences(prompt, defaults);
    assert.equal(resolved.video.aspectRatio, expectedRatio, prompt);
    assert.equal(resolved.video.aspectRatioSource, 'prompt', prompt);
  }
});

test('normalizes explicit genre and featured-instrument aliases', () => {
  const rnb = resolvePromptMediaPreferences(
    'Use R&B music at a tempo of 90, with a soundtrack featuring sax.',
    defaults,
  );
  assert.deepEqual(rnb.music, {
    genre: 'rnb',
    tempoBpm: 90,
    featuredInstrument: 'saxophone',
  });

  const genericGuitar = resolvePromptMediaPreferences(
    'Genre lo fi. Guitar as the featured instrument.',
    defaults,
  );
  assert.deepEqual(genericGuitar.music, {
    genre: 'lo-fi',
    featuredInstrument: 'guitar',
  });

  assert.deepEqual(
    resolvePromptMediaPreferences('Choose jazz for the music; BPM: 110; instrument piano.', defaults).music,
    { genre: 'jazz', tempoBpm: 110, featuredInstrument: 'piano' },
  );
});

test('preserves compact and free-form explicit music controls', () => {
  assert.deepEqual(
    resolvePromptMediaPreferences(
      'Cinematic, 16:9, pop, 120 BPM, piano',
      defaults,
    ).music,
    { genre: 'pop', tempoBpm: 120, featuredInstrument: 'piano' },
  );
  assert.deepEqual(
    resolvePromptMediaPreferences(
      'Animation 3:4 with blues music at 95 BPM featuring cello',
      defaults,
    ).music,
    { genre: 'blues', tempoBpm: 95, featuredInstrument: 'cello' },
  );
  assert.deepEqual(
    resolvePromptMediaPreferences(
      'Genre hint: drum and bass; tempo-BPM: 174; featured instrument: upright bass.',
      defaults,
    ).music,
    { genre: 'drum and bass', tempoBpm: 174, featuredInstrument: 'upright bass' },
  );
});

test('does not infer media settings from physical objects or visual subjects', () => {
  const resolved = resolvePromptMediaPreferences(
    'Create a portrait of a guitarist sitting on a rock as a clean up look is applied to the room.',
    defaults,
  );

  assert.equal(resolved.video.aspectRatio, '16:9');
  assert.equal(resolved.video.aspectRatioSource, 'default');
  assert.equal(resolved.music, undefined);
  assert.equal(resolved.cleanupAfterSuccess, false);
});

test('disables background music only for unambiguous global Foley-only requests', () => {
  const prompts = [
    'Create the cricket video with no background music.',
    'Use the bat hit and crowd roar without any soundtrack.',
    "Do not add a musical score; use the natural stadium sounds.",
    'Foley only, with a sharp bat impact and crowd roar.',
    'Use only sound effects audio.',
    'Create the video with no background sound, and keep the Foley.',
  ];

  for (const prompt of prompts) {
    assert.equal(promptExplicitlyDisablesBackgroundMusic(prompt), true, prompt);
    assert.deepEqual(resolvePromptMediaPreferences(prompt, defaults).backgroundMusic, {
      enabled: false,
      source: 'prompt',
    }, prompt);
  }
});

test('keeps music enabled for narrative, object, targeted, or scene-scoped wording', () => {
  const prompts = [
    'Show an on-screen sign that reads: no music.',
    'A character says, no background music.',
    'Show a vintage music box beside the batsman.',
    'Use no music-video style; make the visuals cinematic.',
    'No background traffic sound; retain the score.',
    'In scene 1, no music while the batsman prepares.',
    'No music until the crowd begins to roar, then bring in the score.',
    'No background music for the first 2 seconds.',
    'At the beginning, use Foley only, then begin the soundtrack.',
    'Create a completely silent video with no audio.',
  ];

  for (const prompt of prompts) {
    assert.equal(promptExplicitlyDisablesBackgroundMusic(prompt), false, prompt);
    assert.deepEqual(resolvePromptMediaPreferences(prompt, defaults).backgroundMusic, {
      enabled: true,
      source: 'default',
    }, prompt);
  }
});

test('does not mistake explicitly audio-qualified cinematic wording for video style', () => {
  const nonCinematicDefaults = {
    video: { ...defaults.video, style: 'anime' as const },
  };
  for (const prompt of [
    'Create a forest video with cinematic music and piano in the cabin.',
    'Use cinematic orchestral music.',
    'Add a cinematic action score.',
  ]) {
    const resolved = resolvePromptMediaPreferences(prompt, nonCinematicDefaults);
    assert.equal(resolved.video.style, 'anime', prompt);
    assert.equal(resolved.video.styleSource, 'default', prompt);
  }
});

test('ignores narrative BPM, physical objects, and non-explicit music values', () => {
  assert.equal(
    resolvePromptMediaPreferences('A runner has a 400 BPM heart rate beside a piano.', defaults).music,
    undefined,
  );
  assert.equal(
    resolvePromptMediaPreferences('A runner has a 120 BPM heart rate beside a piano.', defaults).music,
    undefined,
  );
  assert.equal(
    resolvePromptMediaPreferences('A medical monitor reads 72 BPM while rain falls.', defaults).music,
    undefined,
  );
  assert.equal(
    resolvePromptMediaPreferences('A country road passes a metal bridge.', defaults).music,
    undefined,
  );
});

test('does not treat scale or grid dimensions as output aspect ratios', () => {
  const landscapeDefaults = {
    video: { ...defaults.video, aspectRatio: '16:9' as const },
  };
  for (const prompt of [
    'A 1:1 scale model on a table.',
    'Show a 9x16 grid of ceramic tiles.',
    'A character watches a 4:5 photograph on a wall.',
  ]) {
    const resolved = resolvePromptMediaPreferences(prompt, landscapeDefaults);
    assert.equal(resolved.video.aspectRatio, '16:9', prompt);
    assert.equal(resolved.video.aspectRatioSource, 'default', prompt);
  }
});

test('requires post-success cleanup intent and lets denial or keep language win', () => {
  const positives = [
    'Clean up after successful generation.',
    'Once the video is successfully generated, remove all local artifacts.',
    'Delete temporary files after successful completion.',
    'Clean up generated assets when generation succeeds.',
    'Create a video, then delete local artifacts after successful generation.',
    'Create a video and then clean up local artifacts after success.',
    'Create a video and after successful generation, clean up local artifacts.',
  ];
  for (const prompt of positives) {
    assert.equal(resolvePromptMediaPreferences(prompt, defaults).cleanupAfterSuccess, true, prompt);
  }

  const denials = [
    'Delete artifacts after success, but keep all local artifacts.',
    "Don't delete temporary files after successful generation.",
    'Do not perform cleanup after successful generation.',
    'Do not automatically clean up after successful generation.',
    'No cleanup after successful generation.',
    'Clean up artifacts after success, but preserve the intermediates.',
    'Generate successfully without cleanup.',
    'Create a robot that cleans up after successful generation.',
    'Create a video with on-screen text: delete temporary files after successful completion.',
    'Show a developer saying, delete local artifacts after successful generation.',
    'Tell a story about a policy to remove generated assets after successful completion.',
  ];
  for (const prompt of denials) {
    assert.equal(resolvePromptMediaPreferences(prompt, defaults).cleanupAfterSuccess, false, prompt);
  }
});

test('maps every Agnes aspect ratio to its fixed documented output dimensions', () => {
  assert.deepEqual(
    resolveVideoDimensionsForAspectRatio('21:9'),
    { width: 1680, height: 720 },
  );
  assert.deepEqual(
    resolveVideoDimensionsForAspectRatio({ aspectRatio: '16:9' }),
    { width: 1280, height: 704 },
  );
  assert.deepEqual(
    resolveVideoDimensionsForAspectRatio('4:3'),
    { width: 960, height: 720 },
  );
  assert.deepEqual(
    resolveVideoDimensionsForAspectRatio('1:1'),
    { width: 720, height: 720 },
  );
  assert.deepEqual(
    resolveVideoDimensionsForAspectRatio('3:4'),
    { width: 720, height: 960 },
  );
  assert.deepEqual(
    resolveVideoDimensionsForAspectRatio('9:16'),
    { width: 720, height: 1280 },
  );
});
