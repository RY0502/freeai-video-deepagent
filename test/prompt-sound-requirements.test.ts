import assert from 'node:assert/strict';
import test from 'node:test';

import type { VideoPlan } from '../src/agent/videoPlan.js';
import {
  promptDerivedSoundRequirements,
  sanitizeAgnesVideoPrompt,
} from '../src/tools/videoAgentTools.js';

test('removes publication and post-completion cleanup instructions from the Agnes prompt', () => {
  const sanitized = sanitizeAgnesVideoPrompt([
    'Create a continuous cinematic shot of a cyclist crossing a bridge.',
    'Upload the finished video to YouTube after completion.',
    'Publish the finished video to you tube.',
    'Perform cleanup after successful completion by deleting temporary files.',
    'Keep the camera low and steady.',
  ].join('\n'));

  assert.match(sanitized, /cyclist crossing a bridge/);
  assert.match(sanitized, /camera low and steady/);
  assert.doesNotMatch(sanitized, /youtube|upload|cleanup|temporary files/i);
});

test('removes editorial score directions from Agnes while retaining their joined visual action', () => {
  const sanitized = sanitizeAgnesVideoPrompt([
    'The chicken checks the quiet road.',
    'Dramatic heroic music plays as the chicken walks proudly toward the far side.',
    'Generate synchronized natural clucks.',
    'Do not generate background music, score, songs, or lyrics.',
  ].join(' '));

  assert.doesNotMatch(sanitized, /dramatic heroic music plays/i);
  assert.match(sanitized, /chicken walks proudly toward the far side/i);
  assert.match(sanitized, /Do not generate background music, score, songs, or lyrics/i);
});

function contextPlan(context: string): VideoPlan {
  return {
    concept: context,
    creativeScript: context,
    visualPrompt: context,
  } as unknown as VideoPlan;
}

function requirementMatchesCue(
  requirement: ReturnType<typeof promptDerivedSoundRequirements>[number],
  sound: string,
  prominence: 'foreground' | 'supporting' | 'ambient' = 'foreground',
  visualAction = '',
): boolean {
  const normalizedSound = sound.toLowerCase().replace(/\s+/g, ' ').trim();
  const audibleCause = `${sound} ${visualAction}`.toLowerCase().replace(/\s+/g, ' ').trim();
  return requirement.pattern.test(normalizedSound)
    && (!requirement.sourcePattern || requirement.sourcePattern.test(audibleCause))
    && (!requirement.foreground || prominence === 'foreground');
}

test('explicit visible dog and cat vocal actions require separate foreground vocal cues', () => {
  const requirements = promptDerivedSoundRequirements(contextPlan(
    'A visible dog barks and growls at a visible cat; the cat hisses, then meows.',
  ));
  const canine = requirements.find(({ label }) => /dog\/canine/.test(label));
  const feline = requirements.find(({ label }) => /cat\/feline/.test(label));

  assert.ok(canine);
  assert.ok(feline);
  assert.equal(requirementMatchesCue(canine, 'A close, natural bark from the visible dog.'), true);
  assert.equal(requirementMatchesCue(feline, 'A short defensive hiss from the visible cat.'), true);

  // A generic effect cannot ambiguously satisfy both animals, and a quiet
  // supporting vocalization cannot satisfy a requested foreground action.
  assert.equal(requirementMatchesCue(canine, 'A low animal growl.'), false);
  assert.equal(requirementMatchesCue(canine, 'A cat growl.'), false);
  assert.equal(requirementMatchesCue(feline, 'A dog growl.'), false);
  assert.equal(requirementMatchesCue(feline, 'A clear cat meow.', 'supporting'), false);
});

test('animal presence alone does not invent a vocal-cue requirement', () => {
  const requirements = promptDerivedSoundRequirements(contextPlan(
    'A silent dog and a quiet cat rest in sunlight without making a sound.',
  ));

  assert.equal(requirements.some(({ label }) => /dog\/canine|cat\/feline/.test(label)), false);
});

test('cat-only and dog-only vocal intent are not attributed to the other animal', () => {
  const catOnly = promptDerivedSoundRequirements(contextPlan(
    'A dog watches quietly while a visible cat meows near the window.',
  ));
  assert.equal(catOnly.some(({ label }) => /cat\/feline/.test(label)), true);
  assert.equal(catOnly.some(({ label }) => /dog\/canine/.test(label)), false);

  const dogOnly = promptDerivedSoundRequirements(contextPlan(
    'A cat watches quietly while a visible canine barks near the gate.',
  ));
  assert.equal(dogOnly.some(({ label }) => /dog\/canine/.test(label)), true);
  assert.equal(dogOnly.some(({ label }) => /cat\/feline/.test(label)), false);
});

test('an explicit chicken cluck remains a required foreground vocal cue', () => {
  const requirements = promptDerivedSoundRequirements(contextPlan(
    'The chicken looks into camera and produces one funny cluck after the punchline.',
  ));
  const chicken = requirements.find(({ label }) => /chicken cluck/.test(label));

  assert.ok(chicken);
  assert.equal(requirementMatchesCue(
    chicken,
    'One funny natural cluck.',
    'foreground',
    'The visible chicken opens its beak and clucks after the punchline.',
  ), true);
  assert.equal(requirementMatchesCue(chicken, 'A distant bird call.', 'supporting'), false);
});

test('lexical lookalikes and anatomical canine teeth do not trigger animal vocals', () => {
  const requirements = promptDerivedSoundRequirements(contextPlan(
    'A tiger bares its canine teeth and growls beside a dogwood tree with rough bark; a category card is visible.',
  ));

  assert.equal(requirements.some(({ label }) => /dog\/canine|cat\/feline/.test(label)), false);
});

test('a brief background car pass is not misclassified as full-length foreground road audio', () => {
  const requirements = promptDerivedSoundRequirements(contextPlan(
    'A chicken crosses back toward its starting point while a car passes safely in the background.',
  ));

  // A distant supporting vehicle may be inaudible and must not complicate the
  // foreground cue sheet unless the director deliberately chooses it.
  assert.equal(requirements.some(({ label }) => /vehicle pass-by/.test(label)), false);
  assert.equal(requirements.some(({ label }) => /continuous engine/.test(label)), false);

  const backgroundDrive = promptDerivedSoundRequirements(contextPlan(
    'The chicken walks seriously while a car drives through the distant background.',
  ));
  assert.equal(backgroundDrive.some(({ label }) => /continuous engine/.test(label)), false);

  const driving = promptDerivedSoundRequirements(contextPlan(
    'A car drives continuously along a coastal road for the complete shot; distant mountains remain in the background.',
  ));
  const continuous = driving.find(({ label }) => /continuous engine/.test(label));
  assert.ok(continuous);
  assert.equal(continuous.continuous, true);
  assert.equal(continuous.foreground, true);
});
