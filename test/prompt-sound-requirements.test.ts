import assert from 'node:assert/strict';
import test from 'node:test';

import type { VideoPlan } from '../src/agent/videoPlan.js';
import { promptDerivedSoundRequirements } from '../src/tools/videoAgentTools.js';

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
): boolean {
  const normalizedSound = sound.toLowerCase().replace(/\s+/g, ' ').trim();
  return requirement.pattern.test(normalizedSound)
    && (!requirement.sourcePattern || requirement.sourcePattern.test(normalizedSound))
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

test('lexical lookalikes and anatomical canine teeth do not trigger animal vocals', () => {
  const requirements = promptDerivedSoundRequirements(contextPlan(
    'A tiger bares its canine teeth and growls beside a dogwood tree with rough bark; a category card is visible.',
  ));

  assert.equal(requirements.some(({ label }) => /dog\/canine|cat\/feline/.test(label)), false);
});
