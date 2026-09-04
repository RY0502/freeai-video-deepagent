import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFoleySoundEffectPrompt,
  foleyAudibleDurationSeconds,
  foleyPromptInfluence,
  foleyProviderDurationSeconds,
  resolveFoleySoundEffectRequest,
  type FoleySoundCue,
} from "../src/elevenlabs/index.js";

function cue(overrides: Partial<FoleySoundCue> = {}): FoleySoundCue {
  return {
    atSeconds: 2.5,
    durationSeconds: 0.2,
    sound: "dry cotton sleeve snap and compact fist air movement",
    visualAction: "an adult martial artist drives exactly one straight punch toward camera",
    category: "movement",
    prominence: "foreground",
    intensity: "medium",
    spatialPosition: "left",
    continuous: false,
    timingClass: "must_sync",
    ...overrides,
  };
}

test("builds a bounded, physically grounded and isolation-focused ElevenLabs prompt", () => {
  const prompt = buildFoleySoundEffectPrompt(cue());

  assert.ok(prompt.length <= 450);
  assert.match(prompt, /Naturalistic isolated movement Foley/);
  assert.match(prompt, /adult martial artist drives exactly one straight punch/);
  assert.match(prompt, /dry cotton sleeve snap/);
  assert.match(prompt, /Match source, speed, clothing and surface/);
  assert.match(prompt, /Single immediate event with natural decay; no repeats/);
  assert.match(prompt, /Dry mono source; pan in post/);
  assert.match(prompt, /No music, speech, singing or unrelated ambience/);
});

test("allows the intended nonverbal voice while excluding speech for creature and crowd cues", () => {
  const creature = buildFoleySoundEffectPrompt(cue({
    category: "creature_vocalization",
    sound: "deep Tyrannosaurus roar with chest resonance and wet breath",
    visualAction: "the Tyrannosaurus opens its jaws and visibly roars",
  }));
  assert.match(creature, /animal vocalization only/);
  assert.match(creature, /No music, human speech, singing or unrelated ambience/);
  assert.doesNotMatch(creature, /No music\/voices/);

  const crowd = buildFoleySoundEffectPrompt(cue({
    category: "crowd",
    sound: "large stadium crowd erupts into one excited nonverbal roar",
    visualAction: "spectators stand and celebrate the ball clearing the boundary",
  }));
  assert.match(crowd, /nonverbal reaction/);
  assert.match(crowd, /No music, announcer, narration, intelligible words/);
  assert.doesNotMatch(crowd, /No music\/voices/);
});

test("retains observed acoustic grounding and the planned anchor under the prompt limit", () => {
  const observed = "close dry leather glove snap with a short airy wrist swish";
  const planned = "single martial arts punch movement";
  const prompt = buildFoleySoundEffectPrompt(cue({
    sound: `${observed}, tightly matched to the visible acceleration and exact material texture; planned effect: ${planned} with a restrained natural tail`,
    visualAction: "an adult martial artist rotates through a deliberately long visually observed movement description before extending one fist toward camera",
  }));

  assert.ok(prompt.length <= 450);
  assert.match(prompt, /close dry leather glove snap/);
  assert.match(prompt, /planned effect:/);
  assert.match(prompt, /single martial arts/);
  assert.match(prompt, /Match source, speed, clothing and surface/);
  assert.match(prompt, /No music, speech, singing or unrelated ambience/);
});

test("uses cue-aware prompt adherence and preserves natural one-shot tails", () => {
  const important = cue();
  assert.equal(foleyPromptInfluence(important), 0.85);
  assert.equal(foleyProviderDurationSeconds(important), 0.8);
  assert.equal(foleyAudibleDurationSeconds(important, 10), 0.65);

  const ambient = cue({
    atSeconds: 0,
    durationSeconds: 9,
    sound: "gentle ocean water",
    visualAction: "gentle ocean water remains visible throughout",
    category: "ambience",
    prominence: "ambient",
    spatialPosition: "moving",
    continuous: true,
    timingClass: "approximate",
  });
  assert.equal(foleyPromptInfluence(ambient), 0.65);
  assert.equal(foleyProviderDurationSeconds(ambient), 9);
  assert.equal(foleyAudibleDurationSeconds(ambient, 9), 9);
});

test("resolves provider and local-mix settings without overrunning the final timeline", () => {
  const resolved = resolveFoleySoundEffectRequest(cue({
    atSeconds: 9.7,
    durationSeconds: 0.2,
    spatialPosition: "right",
  }), 10);

  assert.equal(resolved.providerDurationSeconds, 0.8);
  assert.equal(resolved.audibleDurationSeconds, 0.3);
  assert.equal(resolved.promptInfluence, 0.85);
  assert.equal(resolved.spatialPosition, "right");
  assert.equal(resolved.fadeInSeconds, 0);
  assert.equal(resolved.fadeOutSeconds, 0.06);
  assert.equal(resolved.loop, false);
});
