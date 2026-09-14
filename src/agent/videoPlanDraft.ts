import { z } from 'zod';

import { promptExplicitlyRequestsYouTubeUpload, stripYouTubeUploadAuthorization } from '../authorization.js';
import type { AppConfig } from '../config.js';
import {
  DOCUMENTED_NEGATIVE_PROMPT_SUGGESTION,
  promptExplicitlyDisablesBackgroundMusic,
  resolvePromptMediaPreferences,
} from './mediaPreferences.js';
import {
  MAX_LONG_FOREGROUND_TRANSIENTS,
  MAX_SHORT_FOREGROUND_TRANSIENTS,
  MAX_VIDEO_DURATION_SECONDS,
  MIN_MUST_SYNC_TRANSIENT_SPACING_SECONDS,
  MIN_VIDEO_DURATION_SECONDS,
  VideoCameraMotionSchema,
  VideoPlanSchema,
  YouTubeCategoryIdSchema,
  type TimedFoleyCue,
  type VideoPlan,
} from './videoPlan.js';

const DraftText = z.string().trim().min(1);

/**
 * The creative-only plan shape exposed to the planning model.
 *
 * IDs, exact gap-free windows, duplicated music windows, delivery settings,
 * and trusted publication controls deliberately do not belong here. The host
 * derives those fields when it materializes the persisted schema-v2 plan.
 * Zod's default unknown-key stripping also lets this accept an older full-plan
 * proposal during a rolling deployment without preserving untrusted fields.
 */
const VideoPlanDraftSubjectSchema = z.object({
  name: DraftText.optional(),
  role: z.enum(['primary', 'supporting', 'environmental']).optional(),
  invariantAppearance: DraftText,
  wardrobeOrSurface: DraftText.optional(),
  props: z.array(DraftText).max(12).optional(),
  identityAnchors: z.array(DraftText).max(16).optional(),
});

const VideoPlanDraftContinuitySchema = z.object({
  visualStyle: DraftText.optional(),
  subjects: z.array(VideoPlanDraftSubjectSchema).min(1).max(4),
  environment: z.object({
    location: DraftText,
    backgroundAnchors: z.array(DraftText).max(16).optional(),
    timeOfDay: DraftText.optional(),
    weatherOrAtmosphere: DraftText.optional(),
  }),
  lighting: DraftText.optional(),
  colorPalette: z.array(DraftText).max(10).optional(),
  cameraLanguage: DraftText.optional(),
  supportingAnchors: z.array(DraftText).max(16).optional(),
  negativeConstraints: z.array(DraftText).max(20).optional(),
});

const VideoPlanDraftBeatSchema = z.object({
  /** Relative screen-time emphasis; the host derives every absolute window. */
  durationWeight: z.number().finite().min(0.1).max(10).optional(),
  narrativePurpose: DraftText,
  visualAction: DraftText,
  cameraDirection: DraftText.optional(),
  composition: DraftText.optional(),
});

const VideoPlanDraftFoleyCueSchema = z.object({
  /** One-based reference to timelineBeats; no absolute media timestamp is model-authored. */
  beatNumber: z.number().int().min(1).max(4),
  placement: z.enum(['start', 'early', 'middle', 'late', 'end']),
  sound: DraftText,
  durationSeconds: z.number().finite().positive().max(MAX_VIDEO_DURATION_SECONDS).optional(),
  intensity: z.enum(['subtle', 'medium', 'strong']).optional(),
  spatialPosition: z.enum(['left', 'center', 'right', 'moving']).optional(),
  category: z.enum([
    'creature_vocalization',
    'vehicle',
    'weather',
    'movement',
    'impact',
    'ambience',
    'mechanical',
    'nature',
    'crowd',
  ]).optional(),
  prominence: z.enum(['foreground', 'supporting', 'ambient']).optional(),
  visualAction: DraftText,
  continuous: z.boolean().optional(),
  timingClass: z.enum(['must_sync', 'approximate']).optional(),
});

const VideoPlanDraftMusicSchema = z.object({
  /** The host honors only an explicit music denial in the original prompt. */
  enabled: z.boolean().optional(),
  prompt: DraftText.optional(),
  negativePrompt: DraftText.optional(),
  genre: DraftText.optional(),
  featuredInstrument: DraftText.optional(),
  mood: DraftText.optional(),
  tempoBpm: z.number().int().min(30).max(300).optional(),
  syncStrategy: DraftText.optional(),
  beatDirections: z.array(DraftText).max(4).optional(),
});

const VideoPlanDraftYouTubeSchema = z.object({
  title: DraftText.optional(),
  description: DraftText.optional(),
  tags: z.array(DraftText).max(12).optional(),
  categoryId: YouTubeCategoryIdSchema.optional(),
});

export const VideoPlanDraftSchema = z.object({
  concept: DraftText,
  creativeScript: DraftText,
  totalDurationSeconds: z.number().int()
    .min(MIN_VIDEO_DURATION_SECONDS)
    .max(MAX_VIDEO_DURATION_SECONDS)
    .optional(),
  continuityBible: VideoPlanDraftContinuitySchema,
  visualPrompt: DraftText,
  cameraMotion: VideoCameraMotionSchema.optional(),
  cameraDirection: DraftText.optional(),
  negativePrompt: DraftText.optional(),
  timelineBeats: z.array(VideoPlanDraftBeatSchema).min(2).max(4),
  foleyCues: z.array(VideoPlanDraftFoleyCueSchema).max(6).optional(),
  music: VideoPlanDraftMusicSchema.optional(),
  youtubeUpload: VideoPlanDraftYouTubeSchema.optional(),
});

/** Small transport envelope suitable for a structured planning tool. */
export const VideoPlanDraftInputSchema = z.object({
  plan: VideoPlanDraftSchema,
}).strict();

export type VideoPlanDraft = z.infer<typeof VideoPlanDraftSchema>;
export type VideoPlanDraftInput = z.infer<typeof VideoPlanDraftInputSchema>;

export interface MaterializeVideoPlanDraftOptions {
  originalPrompt: string;
  config: Pick<
    AppConfig,
    | 'VIDEO_STYLE'
    | 'VIDEO_ASPECT_RATIO'
    | 'VIDEO_FPS'
    | 'YOUTUBE_DEFAULT_PRIVACY'
    | 'YOUTUBE_DEFAULT_MADE_FOR_KIDS'
  >;
}

export class VideoPlanDraftTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoPlanDraftTransportError';
  }
}

/** Reject stringified/truncated tool arguments with a compact diagnostic. */
export function parseVideoPlanDraft(input: unknown): VideoPlanDraft {
  if (typeof input === 'string') {
    throw new VideoPlanDraftTransportError(
      'The plan argument must be a JSON object, not a string. Send the object directly once.',
    );
  }

  const parsed = VideoPlanDraftSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 6).map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'plan';
      return `${path}: ${issue.message}`;
    });
    throw new VideoPlanDraftTransportError(
      `The creative video draft is invalid: ${issues.join('; ')}`,
    );
  }
  return parsed.data;
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function compactWhitespace(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function detail(value: string | undefined, fallback: string): string {
  const chosen = compactWhitespace(value) || compactWhitespace(fallback);
  return chosen.length >= 12 ? chosen : `${chosen}: ${fallback}`;
}

function longText(value: string | undefined, fallback: string, minimum: number): string {
  let result = compactWhitespace(value);
  const addition = compactWhitespace(fallback);
  if (!result) result = addition;
  while (result.length < minimum) result = `${result} ${addition}`.trim();
  return result;
}

function uniqueText(values: readonly (string | undefined)[], maximum: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const input of values) {
    const value = compactWhitespace(input);
    const key = value.toLocaleLowerCase('en-US');
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length === maximum) break;
  }
  return result;
}

function requiredList(
  values: readonly (string | undefined)[] | undefined,
  fallbacks: readonly string[],
  minimum: number,
  maximum: number,
): string[] {
  const result = uniqueText([...(values ?? []), ...fallbacks], maximum);
  return result.slice(0, Math.max(minimum, Math.min(maximum, result.length)));
}

function slug(value: string, fallback: string): string {
  const normalized = value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
    .replace(/-+$/g, '');
  const selected = normalized.length >= 2 ? normalized : fallback;
  return /^[a-z0-9]/.test(selected) ? selected : `id-${selected}`;
}

function uniqueId(base: string, seen: Set<string>): string {
  let candidate = base.slice(0, 63);
  let suffix = 2;
  while (seen.has(candidate)) {
    const ending = `-${suffix}`;
    candidate = `${base.slice(0, 63 - ending.length)}${ending}`;
    suffix += 1;
  }
  seen.add(candidate);
  return candidate;
}

function explicitDurationSeconds(prompt: string): number | undefined {
  let selected: number | undefined;
  for (const match of prompt.matchAll(/\b(\d{1,2})(?:[ -]?second|\s*s(?:ec)?)s?\b/gi)) {
    const duration = Number(match[1]);
    if (Number.isInteger(duration)
      && duration >= MIN_VIDEO_DURATION_SECONDS
      && duration <= MAX_VIDEO_DURATION_SECONDS) selected = duration;
  }
  return selected;
}

function resolvedDuration(draft: VideoPlanDraft, originalPrompt: string): number {
  const explicit = explicitDurationSeconds(stripYouTubeUploadAuthorization(originalPrompt));
  if (explicit !== undefined) return explicit;
  return clamp(draft.totalDurationSeconds ?? 10, 10, MAX_VIDEO_DURATION_SECONDS);
}

function buildTimeline(draft: VideoPlanDraft, duration: number): VideoPlan['timelineBeats'] {
  const count = draft.timelineBeats.length;
  const weights = draft.timelineBeats.map((beat) => beat.durationWeight ?? 1);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;

  return draft.timelineBeats.map((beat, index) => {
    const isLast = index === count - 1;
    const allocated = duration * (weights[index] ?? 1) / weightTotal;
    const endSeconds = isLast ? duration : roundHundredths(cursor + allocated);
    const startSeconds = cursor;
    cursor = endSeconds;
    return {
      beatId: `beat-${String(index + 1).padStart(2, '0')}`,
      startSeconds,
      endSeconds,
      narrativePurpose: detail(
        beat.narrativePurpose,
        `Advance the continuous story during visual beat ${index + 1}.`,
      ),
      visualAction: longText(
        beat.visualAction,
        `The established subjects continue one clear visible action without a cut during beat ${index + 1}.`,
        40,
      ),
      cameraDirection: detail(
        beat.cameraDirection ?? draft.cameraDirection,
        'Maintain the established continuous camera direction and screen geography.',
      ),
      composition: detail(
        beat.composition,
        'Keep the main subject legible while preserving the established background anchors.',
      ),
    };
  });
}

function inferFoleyCategory(
  cue: VideoPlanDraft['foleyCues'] extends (infer T)[] | undefined ? T : never,
): TimedFoleyCue['category'] {
  if (cue.category) return cue.category;
  const context = `${cue.sound} ${cue.visualAction}`.toLocaleLowerCase('en-US');
  if (/\b(?:roar|growl|bark|meow|mew|hiss|cluck|animal|creature|dinosaur)\b/.test(context)) return 'creature_vocalization';
  if (/\b(?:car|truck|vehicle|engine|motor|tire|tyre)\b/.test(context)) return 'vehicle';
  if (/\b(?:rain|storm|thunder|drizzle)\b/.test(context)) return 'weather';
  if (/\b(?:hit|impact|strike|crack|collision|slam)\b/.test(context)) return 'impact';
  if (/\b(?:crowd|applause|cheer|stadium)\b/.test(context)) return 'crowd';
  if (/\b(?:robot|machine|gear|servo|mechanical|factory)\b/.test(context)) return 'mechanical';
  if (/\b(?:wind|ocean|wave|bird|forest|leaf|leaves)\b/.test(context)) return 'nature';
  if (/\b(?:step|foot|walk|run|cloth|wing|movement)\b/.test(context)) return 'movement';
  return 'ambience';
}

function stripCanonicalTimestamp(value: string): string {
  return value.replace(/^\s*\[\d+(?:\.\d+)?\s*s\]\s*/i, '').trim();
}

function buildFoleyCues(
  draft: VideoPlanDraft,
  duration: number,
  timeline: VideoPlan['timelineBeats'],
): VideoPlan['foleyCues'] {
  const placementFraction = {
    start: 0.08,
    early: 0.25,
    middle: 0.5,
    late: 0.75,
    end: 0.92,
  } as const;
  const source = (draft.foleyCues ?? []).map((cue, sourceIndex) => {
    const beatIndex = clamp(cue.beatNumber - 1, 0, timeline.length - 1);
    const beat = timeline[beatIndex];
    const atSeconds = beat
      ? roundHundredths(beat.startSeconds
        + (beat.endSeconds - beat.startSeconds) * placementFraction[cue.placement])
      : 0;
    return { cue, atSeconds, sourceIndex };
  }).sort((left, right) => left.atSeconds - right.atSeconds || left.sourceIndex - right.sourceIndex)
    .slice(0, 6);
  const result: VideoPlan['foleyCues'] = [];
  const mustSyncBeatIds = new Set<string>();
  let previousMustSyncAt: number | undefined;
  let foregroundTransientCount = 0;
  const foregroundBudget = duration <= 8
    ? MAX_SHORT_FOREGROUND_TRANSIENTS
    : MAX_LONG_FOREGROUND_TRANSIENTS;

  for (const positioned of source) {
    const { cue } = positioned;
    const continuous = cue.continuous ?? false;
    const unclampedAt = positioned.atSeconds;
    const cueBeatIndex = Math.trunc(clamp(cue.beatNumber - 1, 0, timeline.length - 1));
    const atSeconds = continuous
      ? timeline[cueBeatIndex]?.startSeconds ?? 0
      : clamp(unclampedAt, 0.2, roundHundredths(duration - 0.2));
    const containingBeat = timeline.find((beat) =>
      atSeconds >= beat.startSeconds && atSeconds < beat.endSeconds,
    ) ?? timeline[timeline.length - 1];
    if (!containingBeat) continue;

    let timingClass = cue.timingClass ?? (continuous ? 'approximate' : 'must_sync');
    if (timingClass === 'must_sync' && !continuous) {
      const tooClose = previousMustSyncAt !== undefined
        && atSeconds - previousMustSyncAt < MIN_MUST_SYNC_TRANSIENT_SPACING_SECONDS;
      if (mustSyncBeatIds.has(containingBeat.beatId) || tooClose) timingClass = 'approximate';
      else {
        mustSyncBeatIds.add(containingBeat.beatId);
        previousMustSyncAt = atSeconds;
      }
    }

    let prominence = cue.prominence ?? (continuous ? 'ambient' : 'foreground');
    if (!continuous && prominence === 'foreground') {
      foregroundTransientCount += 1;
      if (foregroundTransientCount > foregroundBudget) prominence = 'supporting';
    }
    const availableDuration = roundHundredths(duration - atSeconds);
    const desiredDuration = roundHundredths(cue.durationSeconds ?? (continuous ? availableDuration : 0.5));
    const durationSeconds = clamp(desiredDuration, 0.01, availableDuration);
    const visualAction = detail(
      stripCanonicalTimestamp(cue.visualAction),
      'The visible subject clearly causes this sound on screen.',
    );

    result.push({
      cueId: `cue-${String(result.length + 1).padStart(2, '0')}`,
      atSeconds,
      sound: compactWhitespace(cue.sound),
      durationSeconds,
      intensity: cue.intensity ?? 'medium',
      spatialPosition: cue.spatialPosition ?? 'center',
      category: inferFoleyCategory(cue),
      prominence,
      visualAction,
      continuous,
      timingClass,
    });
  }

  for (const cue of result) {
    const containingBeat = timeline.find((beat) =>
      cue.atSeconds >= beat.startSeconds && cue.atSeconds < beat.endSeconds,
    );
    if (!containingBeat) continue;
    const canonical = `[${cue.atSeconds.toFixed(2)}s] ${cue.visualAction}`;
    if (!containingBeat.visualAction.includes(canonical)) {
      containingBeat.visualAction = `${containingBeat.visualAction} ${canonical}`;
    }
  }
  return result;
}

function contextualMusic(originalPrompt: string, concept: string): {
  genre: string;
  mood: string;
  tempoBpm: number;
  featuredInstrument?: string;
} {
  const context = `${stripYouTubeUploadAuthorization(originalPrompt)} ${concept}`.toLocaleLowerCase('en-US');
  if (/\b(?:funny|comedy|comic|silly|punchline)\b/.test(context)) {
    return { genre: 'light cinematic comedy', mood: 'Playful, warm, and gently heroic', tempoBpm: 92, featuredInstrument: 'pizzicato strings' };
  }
  if (/\b(?:fight|battle|action|chase|hero|meteor|thrill)\b/.test(context)) {
    return { genre: 'cinematic orchestral', mood: 'Dramatic, urgent, and heroic', tempoBpm: 108, featuredInstrument: 'strings' };
  }
  if (/\b(?:romance|romantic|love|wedding)\b/.test(context)) {
    return { genre: 'classical', mood: 'Tender, intimate, and romantic', tempoBpm: 72, featuredInstrument: 'piano' };
  }
  if (/\b(?:horror|haunted|scary|terror|ominous)\b/.test(context)) {
    return { genre: 'ambient horror', mood: 'Ominous, restrained, and suspenseful', tempoBpm: 58, featuredInstrument: 'synth' };
  }
  if (/\b(?:rain|forest|calm|soothing|peaceful|sunset|coast)\b/.test(context)) {
    return { genre: 'ambient', mood: 'Soothing, spacious, and reflective', tempoBpm: 64, featuredInstrument: 'piano' };
  }
  return { genre: 'cinematic instrumental', mood: 'Engaging, cohesive, and quietly expressive', tempoBpm: 84 };
}

/** Preserve explicit emotional music direction independently from story tone. */
function explicitMusicMood(originalPrompt: string): string | undefined {
  const prompt = stripYouTubeUploadAuthorization(originalPrompt)
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ');
  const musicClauses = prompt.split(/[.!?;\n]/).filter((clause) =>
    /\b(?:music|soundtrack|score|instrumental)\b/.test(clause),
  );
  const context = musicClauses.join(' ');
  if (!context) return undefined;
  if (/\bdramatic\b/.test(context) && /\bheroic\b/.test(context)) return 'Dramatic and heroic';
  if (/\b(?:heroic|triumphant|victorious)\b/.test(context)) return 'Heroic and triumphant';
  if (/\b(?:horror|scary|eerie|ominous|frightening)\b/.test(context)) return 'Ominous, eerie, and suspenseful';
  if (/\b(?:romantic|tender|intimate)\b/.test(context)) return 'Warm, tender, and romantic';
  if (/\b(?:sad|melancholy|somber|sombre)\b/.test(context)) return 'Sad, restrained, and reflective';
  if (/\b(?:soothing|calm|peaceful|serene)\b/.test(context)) return 'Calm, soothing, and peaceful';
  if (/\b(?:funny|comedic|comic|playful|mischievous)\b/.test(context)) return 'Playful, light, and comedic';
  if (/\b(?:thrilling|tense|suspenseful|urgent)\b/.test(context)) return 'Tense, urgent, and suspenseful';
  if (/\b(?:uplifting|hopeful|joyful)\b/.test(context)) return 'Uplifting, hopeful, and joyful';
  return undefined;
}

function cleanMetadata(value: string): string {
  return compactWhitespace(value).replace(/[<>]/g, '');
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let result = value;
  while (new TextEncoder().encode(result).byteLength > maximumBytes) result = result.slice(0, -1);
  return result.trim();
}

function inferredYouTubeCategory(context: string): z.infer<typeof YouTubeCategoryIdSchema> {
  const lower = context.toLocaleLowerCase('en-US');
  if (/\b(?:funny|comedy|comic|punchline|joke)\b/.test(lower)) return '23';
  if (/\b(?:animal|chicken|dog|cat|dinosaur|bird)\b/.test(lower)) return '15';
  if (/\b(?:car|truck|vehicle|motorcycle)\b/.test(lower)) return '2';
  if (/\b(?:sport|cricket|football|batsman|athlete)\b/.test(lower)) return '17';
  if (/\b(?:travel|coast|beach|destination)\b/.test(lower)) return '19';
  if (/\b(?:robot|factory|science|technology|space)\b/.test(lower)) return '28';
  return '24';
}

function youtubeTags(draft: VideoPlanDraft, visualStyle: string): string[] {
  const stopWords = new Set([
    'about', 'after', 'again', 'along', 'create', 'from', 'into', 'little', 'their', 'there',
    'these', 'they', 'this', 'through', 'video', 'where', 'while', 'with', 'without', 'would',
  ]);
  const keywords = `${draft.concept} ${draft.creativeScript}`
    .toLocaleLowerCase('en-US')
    .match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [];
  const inferred = keywords.filter((word) => !stopWords.has(word)).slice(0, 8);
  const candidates = [
    ...(draft.youtubeUpload?.tags ?? []),
    ...inferred,
    visualStyle,
    'short film',
    'visual storytelling',
    'cinematic story',
    'creative short',
  ];
  const tags: string[] = [];
  const normalized = new Set<string>();
  for (const candidate of candidates) {
    const tag = cleanMetadata(candidate).slice(0, 100).trim();
    const fingerprint = tag.toLocaleLowerCase('en-US');
    if (!tag || normalized.has(fingerprint)) continue;
    const proposed = [...tags, tag];
    const aggregateCharacters = Array.from(proposed
      .map((value) => value.includes(' ') ? `"${value}"` : value)
      .join(',')).length;
    if (aggregateCharacters > 500) continue;
    normalized.add(fingerprint);
    tags.push(tag);
    if (tags.length === 12) break;
  }
  return tags;
}

/**
 * Deterministically turn a compact director draft into the strict persisted
 * VideoPlan schema. This is the trust boundary between model creativity and
 * provider/runtime controls.
 */
export function materializeVideoPlanDraft(
  input: unknown,
  options: MaterializeVideoPlanDraftOptions,
): VideoPlan {
  const draft = parseVideoPlanDraft(input);
  const userPrompt = stripYouTubeUploadAuthorization(options.originalPrompt);
  const preferences = resolvePromptMediaPreferences(options.originalPrompt, {
    video: {
      style: options.config.VIDEO_STYLE,
      aspectRatio: options.config.VIDEO_ASPECT_RATIO,
      fps: options.config.VIDEO_FPS,
    },
  });
  const duration = resolvedDuration(draft, options.originalPrompt);
  const concept = detail(draft.concept, `A coherent short video based on: ${userPrompt}`);
  const creativeScript = longText(
    draft.creativeScript,
    `The story develops the same ${concept} concept through a clear setup, visible progression, and readable final payoff in one continuous shot.`,
    100,
  );
  const cameraMotion = preferences.video.cameraMotion ?? draft.cameraMotion ?? 'slow pan right';
  const cameraDirection = detail(
    draft.cameraDirection,
    `Use ${cameraMotion} in one continuous shot while keeping screen direction stable.`,
  );

  const subjectIds = new Set<string>();
  const subjects = draft.continuityBible.subjects.map((subject, index) => {
    const name = compactWhitespace(subject.name) || `subject-${index + 1}`;
    const id = uniqueId(slug(name, `subject-${index + 1}`), subjectIds);
    return {
      id,
      role: subject.role ?? (index === 0 ? 'primary' : 'supporting'),
      invariantAppearance: detail(
        subject.invariantAppearance,
        `${name} keeps the same recognizable appearance throughout the continuous shot.`,
      ),
      wardrobeOrSurface: compactWhitespace(subject.wardrobeOrSurface)
        || 'The same unchanging wardrobe, colors, textures, and surface details.',
      props: uniqueText(subject.props ?? [], 12),
      identityAnchors: requiredList(
        subject.identityAnchors,
        [`${name} keeps one consistent silhouette`, `${name} keeps the same colors`, `${name} keeps the same proportions`],
        3,
        16,
      ),
    };
  });

  const environment = draft.continuityBible.environment;
  const continuityBible: VideoPlan['continuityBible'] = {
    id: slug(`${concept}-continuity`, 'video-continuity'),
    visualStyle: detail(
      draft.continuityBible.visualStyle,
      `${preferences.video.style} imagery with stable geometry and coherent motion.`,
    ),
    subjects,
    environment: {
      location: detail(environment.location, 'The single established setting from the creative script.'),
      backgroundAnchors: requiredList(
        environment.backgroundAnchors,
        ['the same stable background geometry', 'the same horizon and spatial layout'],
        2,
        16,
      ),
      timeOfDay: compactWhitespace(environment.timeOfDay) || 'Consistent time of day throughout',
      weatherOrAtmosphere: compactWhitespace(environment.weatherOrAtmosphere)
        || 'Consistent atmosphere throughout the continuous shot',
    },
    lighting: detail(
      draft.continuityBible.lighting,
      'Keep one stable light direction, exposure, and shadow treatment throughout.',
    ),
    colorPalette: requiredList(
      draft.continuityBible.colorPalette,
      ['stable primary subject colors', 'coherent environment tones', 'consistent accent colors'],
      3,
      10,
    ),
    cameraLanguage: detail(draft.continuityBible.cameraLanguage, cameraDirection),
    supportingAnchors: requiredList(
      draft.continuityBible.supportingAnchors,
      ['preserve the established screen direction', 'preserve the established spatial relationships'],
      2,
      16,
    ),
    negativeConstraints: requiredList(
      draft.continuityBible.negativeConstraints,
      [
        'no identity drift',
        'no duplicate subjects',
        'no visible text or watermark',
        'no human presenter, spokesperson, or talking head popping into frame',
        'no product feature presentation, commercial advertisement, or promotional pitch',
      ],
      3,
      20,
    ),
  };

  const timelineBeats = buildTimeline(draft, duration);
  const foleyCues = buildFoleyCues(draft, duration, timelineBeats);
  const nativeAudioDirection = foleyCues.length > 0
    ? `Generate synchronized native diegetic audio for these visible causes: ${foleyCues.map((cue) =>
        `around ${cue.atSeconds.toFixed(2)} seconds, ${cue.sound}`).join('; ')}.`
    : 'Generate natural native ambience and subtle sounds for the visible subjects, actions, and environment.';
  const visualPrompt = longText(
    draft.visualPrompt,
    `Render one continuous ${preferences.video.style} shot of ${concept}. Follow the complete script and timing while preserving every continuity anchor. ${nativeAudioDirection}`,
    120,
  );
  const explicitNegative = preferences.video.negativePrompt;
  const negativePrompt = longText(
    uniqueText([
      explicitNegative,
      draft.negativePrompt,
      DOCUMENTED_NEGATIVE_PROMPT_SUGGESTION,
      ...continuityBible.negativeConstraints,
    ], 20).join(', '),
    DOCUMENTED_NEGATIVE_PROMPT_SUGGESTION,
    20,
  );

  const musicDefaults = contextualMusic(userPrompt, concept);
  const userMusicGenre = preferences.music?.genre;
  const userMusicMood = explicitMusicMood(options.originalPrompt);
  const resolvedMusicGenre = compactWhitespace(userMusicGenre ?? draft.music?.genre ?? musicDefaults.genre);
  const resolvedMusicMood = userMusicMood
    ?? (compactWhitespace(draft.music?.mood) || musicDefaults.mood);
  const explicitMusicCharacter = Boolean(userMusicGenre || userMusicMood);
  const musicDisabled = promptExplicitlyDisablesBackgroundMusic(options.originalPrompt);
  const music: VideoPlan['music'] = musicDisabled
    ? {
        enabled: false,
        reason: 'The original user prompt explicitly requested a final video without background music.',
      }
    : {
        enabled: true,
        prompt: longText(
          explicitMusicCharacter ? undefined : draft.music?.prompt,
          `Create a quiet ${resolvedMusicGenre} instrumental background bed with a ${resolvedMusicMood} mood. Keep it sparse beneath all native diegetic sound.`,
          40,
        ),
        negativePrompt: detail(
          draft.music?.negativePrompt,
          'No vocals, Foley, creature sounds, dialogue, loud transients, distortion, or double-time rhythm.',
        ),
        durationSeconds: duration,
        genre: resolvedMusicGenre,
        ...(compactWhitespace(preferences.music?.featuredInstrument ?? draft.music?.featuredInstrument ?? musicDefaults.featuredInstrument)
          ? { featuredInstrument: compactWhitespace(preferences.music?.featuredInstrument ?? draft.music?.featuredInstrument ?? musicDefaults.featuredInstrument) }
          : {}),
        mood: resolvedMusicMood,
        role: 'background',
        tempoBpm: preferences.music?.tempoBpm ?? draft.music?.tempoBpm ?? musicDefaults.tempoBpm,
        syncStrategy: detail(
          draft.music?.syncStrategy,
          'Follow the visual arc quietly without masking dialogue, ambience, or diegetic accents.',
        ),
        beats: timelineBeats.map((beat, index) => ({
          beatId: beat.beatId,
          startSeconds: beat.startSeconds,
          endSeconds: beat.endSeconds,
          direction: detail(
            draft.music?.beatDirections?.[index],
            `Support visual beat ${index + 1} quietly while leaving every foreground sound clear.`,
          ),
        })),
      };

  const uploadRequested = promptExplicitlyRequestsYouTubeUpload(options.originalPrompt);
  const youtubeSource = draft.youtubeUpload;
  const title = cleanMetadata(youtubeSource?.title ?? concept).slice(0, 100);
  const description = utf8Prefix(cleanMetadata(
    youtubeSource?.description
      ?? `${concept} ${creativeScript}`,
  ), 5_000);

  const candidate: VideoPlan = {
    schemaVersion: 2,
    concept,
    creativeScript,
    totalDurationSeconds: duration,
    continuityBible,
    visualPrompt,
    cameraMotion,
    cameraDirection,
    negativePrompt,
    timelineBeats,
    foleyCues,
    music,
    delivery: {
      visualStyle: preferences.video.style,
      aspectRatio: preferences.video.aspectRatio,
      width: preferences.video.width,
      height: preferences.video.height,
      fps: preferences.video.fps,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
    },
    ...(uploadRequested ? {
      youtubeUpload: {
        requested: true,
        title: title || 'Short Cinematic Story',
        description: description || 'A short cinematic visual story.',
        tags: youtubeTags(draft, preferences.video.style),
        categoryId: youtubeSource?.categoryId ?? inferredYouTubeCategory(`${concept} ${creativeScript}`),
        privacyStatus: options.config.YOUTUBE_DEFAULT_PRIVACY,
        madeForKids: options.config.YOUTUBE_DEFAULT_MADE_FOR_KIDS,
      },
    } : {}),
  };

  return VideoPlanSchema.parse(candidate);
}
