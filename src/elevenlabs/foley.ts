const ELEVENLABS_SOUND_EFFECT_PROMPT_LIMIT = 450;
const ELEVENLABS_MINIMUM_SOUND_EFFECT_SECONDS = 0.5;
const ELEVENLABS_MAXIMUM_SOUND_EFFECT_SECONDS = 30;

export type FoleySoundCategory =
  | "creature_vocalization"
  | "vehicle"
  | "weather"
  | "movement"
  | "impact"
  | "ambience"
  | "mechanical"
  | "nature"
  | "crowd";

export type FoleySoundProminence = "foreground" | "supporting" | "ambient";
export type FoleySoundIntensity = "subtle" | "medium" | "strong";
export type FoleySoundSpatialPosition = "left" | "center" | "right" | "moving";
export type FoleySoundTimingClass = "must_sync" | "approximate";

/**
 * Structural subset of a planned Foley cue. Keeping this provider-facing type
 * independent avoids coupling the ElevenLabs client to the agent schema.
 */
export interface FoleySoundCue {
  atSeconds: number;
  durationSeconds: number;
  sound: string;
  visualAction: string;
  category: FoleySoundCategory;
  prominence: FoleySoundProminence;
  intensity: FoleySoundIntensity;
  spatialPosition: FoleySoundSpatialPosition;
  continuous: boolean;
  timingClass: FoleySoundTimingClass;
}

export interface ResolvedFoleySoundEffectRequest {
  text: string;
  promptInfluence: number;
  /** Length requested from ElevenLabs so transient attacks retain a natural tail. */
  providerDurationSeconds: number;
  /** Length retained in the local final-video timeline. */
  audibleDurationSeconds: number;
  loop: boolean;
  spatialPosition: FoleySoundSpatialPosition;
  continuous: boolean;
  fadeInSeconds: number;
  fadeOutSeconds: number;
}

function compact(value: string, maximumCharacters: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximumCharacters) return normalized;
  return `${normalized.slice(0, Math.max(0, maximumCharacters - 1)).trimEnd()}…`;
}

/**
 * Reconciled cues can contain both an observed acoustic description and the
 * original planned effect. Preserve both sides instead of truncating away the
 * planned anchor when the observed description is detailed.
 */
function compactSound(value: string, maximumCharacters: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximumCharacters) return normalized;

  const marker = /;\s*planned effect:\s*/i.exec(normalized);
  if (!marker?.index) return compact(normalized, maximumCharacters);

  const label = "; planned effect: ";
  const observed = normalized.slice(0, marker.index).trim();
  const planned = normalized.slice(marker.index + marker[0].length).trim();
  const contentBudget = maximumCharacters - label.length;
  if (contentBudget < 24 || !observed || !planned) return compact(normalized, maximumCharacters);

  const observedBudget = Math.max(16, Math.floor(contentBudget * 0.62));
  const plannedBudget = Math.max(8, contentBudget - observedBudget);
  return `${compact(observed, observedBudget)}${label}${compact(planned, plannedBudget)}`;
}

function categoryGrounding(category: FoleySoundCategory): string {
  switch (category) {
    case "creature_vocalization":
      return "Match species, scale, breath and mouth action; animal vocalization only.";
    case "vehicle":
      return "Match vehicle, speed, engine/tyres and road; no unstated horn.";
    case "weather":
      return "Match weather strength, surfaces and distance; no added storm events.";
    case "movement":
      return "Match source, speed, clothing and surface; no false impact.";
    case "impact":
      return "Match contact materials, scale and force; no unstated break/debris.";
    case "ambience":
      return "Match only stated environment and distance; no foreground events.";
    case "mechanical":
      return "Match mechanism, material, size and speed; no alarm/extra cycle.";
    case "nature":
      return "Match source, scale, habitat and distance; no unrelated animals.";
    case "crowd":
      return "Match crowd size, distance and nonverbal reaction; no announcer or words.";
  }
}

function isolationExclusion(category: FoleySoundCategory): string {
  switch (category) {
    case "creature_vocalization":
      return "No music, human speech, singing or unrelated ambience.";
    case "crowd":
      return "No music, announcer, narration, intelligible words or unrelated ambience.";
    default:
      return "No music, speech, singing or unrelated ambience.";
  }
}

function perspective(cue: FoleySoundCue): string {
  const distance = cue.prominence === "foreground"
    ? "Foreground"
    : cue.prominence === "supporting"
      ? "Supporting"
      : "Ambient";
  return `${distance}, ${cue.intensity}`;
}

/** Build a physically grounded, isolation-focused prompt within ElevenLabs' 450-character limit. */
export function buildFoleySoundEffectPrompt(cue: FoleySoundCue): string {
  const eventDirection = cue.continuous
    ? "One seamless stable texture; no extra foreground events."
    : "Single immediate event with natural decay; no repeats.";
  const directives = [
    categoryGrounding(cue.category),
    eventDirection,
    `${perspective(cue)}.`,
    "Dry mono source; pan in post.",
    isolationExclusion(cue.category),
  ].join(" ");
  const fixedPrefix = `Naturalistic isolated ${cue.category.replaceAll("_", " ")} Foley.`;
  const fixedCharacters = `${fixedPrefix} Sound: . Visible cause: . ${directives}`.length;
  const descriptionBudget = Math.max(
    48,
    ELEVENLABS_SOUND_EFFECT_PROMPT_LIMIT - fixedCharacters,
  );
  const normalizedSoundLength = cue.sound.replace(/\s+/g, " ").trim().length;
  const normalizedVisualLength = cue.visualAction.replace(/\s+/g, " ").trim().length;
  const desiredSoundBudget = Math.min(120, normalizedSoundLength);
  const desiredVisualBudget = Math.min(78, normalizedVisualLength);
  let soundBudget = desiredSoundBudget;
  let visualBudget = desiredVisualBudget;
  if (soundBudget + visualBudget > descriptionBudget) {
    // Acoustic detail is the provider's primary instruction, while enough of
    // the visible cause is retained to disambiguate the physical source.
    visualBudget = Math.min(desiredVisualBudget, Math.max(42, Math.floor(descriptionBudget * 0.38)));
    soundBudget = Math.max(16, descriptionBudget - visualBudget);
    if (soundBudget > desiredSoundBudget) {
      visualBudget = Math.min(desiredVisualBudget, descriptionBudget - desiredSoundBudget);
      soundBudget = desiredSoundBudget;
    }
  }
  const sound = compactSound(cue.sound, soundBudget);
  const visualAction = compact(cue.visualAction, visualBudget);
  return `${fixedPrefix} Sound: ${sound}. Visible cause: ${visualAction}. ${directives}`;
}

/** Important one-shots follow the grounded prompt more literally; ambience retains modest variation. */
export function foleyPromptInfluence(cue: FoleySoundCue): number {
  if (cue.continuous || cue.prominence === "ambient") return 0.65;
  if (cue.timingClass === "must_sync") return 0.85;
  if (cue.prominence === "foreground") return 0.8;
  return 0.75;
}

/**
 * Provider renders are deliberately longer than very short planned events.
 * ElevenLabs can otherwise place the useful attack after a 0.2-0.3s local cut.
 */
export function foleyProviderDurationSeconds(cue: FoleySoundCue): number {
  const requested = cue.continuous
    ? cue.durationSeconds
    : Math.max(0.8, cue.durationSeconds + 0.35);
  return Math.min(
    ELEVENLABS_MAXIMUM_SOUND_EFFECT_SECONDS,
    Math.max(ELEVENLABS_MINIMUM_SOUND_EFFECT_SECONDS, Number(requested.toFixed(2))),
  );
}

/** Preserve at least a short natural decay without extending beyond the video timeline. */
export function foleyAudibleDurationSeconds(
  cue: FoleySoundCue,
  timelineDurationSeconds: number,
): number {
  const remaining = timelineDurationSeconds - cue.atSeconds;
  if (!Number.isFinite(remaining) || remaining <= 0) return cue.durationSeconds;
  const requested = cue.continuous
    ? cue.durationSeconds
    : Math.max(0.65, cue.durationSeconds);
  return Number(Math.min(requested, remaining).toFixed(2));
}

export function resolveFoleySoundEffectRequest(
  cue: FoleySoundCue,
  timelineDurationSeconds: number,
): ResolvedFoleySoundEffectRequest {
  const audibleDurationSeconds = foleyAudibleDurationSeconds(cue, timelineDurationSeconds);
  const fadeInSeconds = cue.continuous
    ? Math.min(0.08, audibleDurationSeconds / 4)
    : 0;
  const fadeOutSeconds = Math.min(
    cue.continuous ? 0.08 : 0.06,
    audibleDurationSeconds / 4,
  );
  return {
    text: buildFoleySoundEffectPrompt(cue),
    promptInfluence: foleyPromptInfluence(cue),
    providerDurationSeconds: foleyProviderDurationSeconds(cue),
    audibleDurationSeconds,
    loop: cue.continuous,
    spatialPosition: cue.spatialPosition,
    continuous: cue.continuous,
    fadeInSeconds: Number(fadeInSeconds.toFixed(3)),
    fadeOutSeconds: Number(fadeOutSeconds.toFixed(3)),
  };
}
