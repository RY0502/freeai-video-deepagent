import { z } from 'zod';
import { promptExplicitlyRequestsYouTubeUpload } from '../authorization.js';
import { promptExplicitlyDisablesBackgroundMusic } from './mediaPreferences.js';

export { promptExplicitlyRequestsYouTubeUpload } from '../authorization.js';

/** Agnes Video 2.5 Flash accepts one continuous 4-12 second render. */
export const MIN_VIDEO_DURATION_SECONDS = 4 as const;
export const MAX_VIDEO_DURATION_SECONDS = 12 as const;
export const MAX_TIMELINE_BEATS = 8 as const;
export const MIN_MUST_SYNC_TRANSIENT_SPACING_SECONDS = 1.5 as const;
export const MAX_SHORT_FOREGROUND_TRANSIENTS = 3 as const;
export const MAX_LONG_FOREGROUND_TRANSIENTS = 4 as const;
export const SUPPORTED_VIDEO_DURATIONS_SECONDS = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

const NonEmptyText = z.string().trim().min(1);
const DetailedText = z.string().trim().min(12);
const TimelineTime = z.number().finite().nonnegative().max(MAX_VIDEO_DURATION_SECONDS).multipleOf(0.01);

/** Style vocabulary is prompt guidance; Agnes has no separate style field. */
export const VideoVisualStyleSchema = z.enum([
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

/** Camera vocabulary is composed into the ordinary Agnes prompt. */
export const VideoCameraMotionSchema = z.enum([
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

export const ContinuitySubjectSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/i),
  role: z.enum(['primary', 'supporting', 'environmental']),
  invariantAppearance: DetailedText,
  wardrobeOrSurface: NonEmptyText,
  props: z.array(NonEmptyText).max(12),
  identityAnchors: z.array(NonEmptyText).min(3).max(16),
}).strict();

export const ContinuityBibleSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/i),
  visualStyle: DetailedText,
  subjects: z.array(ContinuitySubjectSchema).min(1).max(8),
  environment: z.object({
    location: DetailedText,
    backgroundAnchors: z.array(NonEmptyText).min(2).max(16),
    timeOfDay: NonEmptyText,
    weatherOrAtmosphere: NonEmptyText,
  }).strict(),
  lighting: DetailedText,
  colorPalette: z.array(NonEmptyText).min(3).max(10),
  cameraLanguage: DetailedText,
  supportingAnchors: z.array(NonEmptyText).min(2).max(16),
  negativeConstraints: z.array(NonEmptyText).min(3).max(20),
}).strict();

const BeatIdSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/i);

/** A gap-free portion of the one continuous generated video. */
export const TimelineBeatSchema = z.object({
  beatId: BeatIdSchema,
  startSeconds: TimelineTime,
  endSeconds: TimelineTime,
  narrativePurpose: DetailedText,
  /** Includes canonical timestamped visual actions for every cue caused in this window. */
  visualAction: z.string().trim().min(40),
  cameraDirection: DetailedText,
  composition: DetailedText,
}).strict();

const FoleyCategorySchema = z.enum([
  'creature_vocalization',
  'vehicle',
  'weather',
  'movement',
  'impact',
  'ambience',
  'mechanical',
  'nature',
  'crowd',
]);
const FoleyProminenceSchema = z.enum(['foreground', 'supporting', 'ambient']);
const FoleyTimingClassSchema = z.enum(['must_sync', 'approximate']);
const CueIdSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/i);

/** Global, final-video-relative audiovisual cue. */
export const FoleyCueSchema = z.object({
  atSeconds: TimelineTime.lt(MAX_VIDEO_DURATION_SECONDS),
  sound: NonEmptyText,
  durationSeconds: z.number().finite().positive().max(MAX_VIDEO_DURATION_SECONDS).multipleOf(0.01),
  intensity: z.enum(['subtle', 'medium', 'strong']),
  spatialPosition: z.enum(['left', 'center', 'right', 'moving']),
  category: FoleyCategorySchema,
  prominence: FoleyProminenceSchema,
  visualAction: DetailedText,
  continuous: z.boolean(),
  cueId: CueIdSchema,
  timingClass: FoleyTimingClassSchema,
}).strict();

export const TimedFoleyCueSchema = FoleyCueSchema;

export const MusicBeatSchema = z.object({
  beatId: BeatIdSchema,
  startSeconds: TimelineTime,
  endSeconds: TimelineTime,
  direction: DetailedText,
}).strict();

const MusicPromptFields = {
  prompt: z.string().trim().min(40),
  negativePrompt: z.string().trim().min(10),
  genre: NonEmptyText,
  featuredInstrument: NonEmptyText.optional(),
  mood: NonEmptyText,
  role: z.literal('background'),
  tempoBpm: z.number().int().min(30).max(300),
  syncStrategy: DetailedText,
};

export const EnabledMusicPromptSchema = z.object({
  enabled: z.literal(true),
  ...MusicPromptFields,
  durationSeconds: z.number().int().min(MIN_VIDEO_DURATION_SECONDS).max(MAX_VIDEO_DURATION_SECONDS),
  beats: z.array(MusicBeatSchema).min(2).max(MAX_TIMELINE_BEATS),
}).strict();

export const MusicPromptSchema = EnabledMusicPromptSchema;
export const TimedMusicBeatSchema = MusicBeatSchema;

export const DisabledMusicPromptSchema = z.object({
  enabled: z.literal(false),
  reason: DetailedText,
}).strict();

export const YouTubeCategoryIdSchema = z.enum([
  '1',  // Film & Animation
  '2',  // Autos & Vehicles
  '10', // Music
  '15', // Pets & Animals
  '17', // Sports
  '19', // Travel & Events
  '20', // Gaming
  '22', // People & Blogs
  '23', // Comedy
  '24', // Entertainment
  '25', // News & Politics
  '26', // Howto & Style
  '27', // Education
  '28', // Science & Technology
  '29', // Nonprofits & Activism
]);

function youtubeTagCharacters(tags: readonly string[]): number {
  return Array.from(tags
    .map((tag) => tag.includes(' ') ? `"${tag}"` : tag)
    .join(',')).length;
}

const YouTubeTitleSchema = z.string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/[<>]/.test(value), 'YouTube titles cannot contain < or >.');

const YouTubeDescriptionSchema = z.string()
  .trim()
  .min(1)
  .refine((value) => !/[<>]/.test(value), 'YouTube descriptions cannot contain < or >.')
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 5_000,
    'YouTube descriptions must be at most 5000 UTF-8 bytes.',
  );

const YouTubeTagsSchema = z.array(z.string().trim().min(1).max(100))
  .min(5)
  .max(12)
  .superRefine((tags, context) => {
    if (youtubeTagCharacters(tags) > 500) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'YouTube tags must fit the aggregate 500-character limit.',
      });
    }
    const normalized = tags.map((tag) => tag.toLocaleLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'YouTube tags must be unique.',
      });
    }
  });

export const YouTubeUploadRequestSchema = z.object({
  requested: z.literal(true),
  title: YouTubeTitleSchema,
  description: YouTubeDescriptionSchema,
  tags: YouTubeTagsSchema,
  categoryId: YouTubeCategoryIdSchema,
  privacyStatus: z.enum(['private', 'unlisted', 'public']),
  madeForKids: z.boolean(),
}).strict();

const DeliverySchema = z.object({
  visualStyle: VideoVisualStyleSchema,
  aspectRatio: z.enum(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().min(12).max(60),
  container: z.literal('mp4'),
  videoCodec: z.literal('h264'),
  audioCodec: z.literal('aac'),
}).strict();

export const VideoPlanSchema = z.object({
  schemaVersion: z.literal(2),
  concept: DetailedText,
  /** Creative narrative expansion of the user's initial concept. */
  creativeScript: z.string().trim().min(100),
  totalDurationSeconds: z.number().int().min(MIN_VIDEO_DURATION_SECONDS).max(MAX_VIDEO_DURATION_SECONDS),
  continuityBible: ContinuityBibleSchema,
  /** One provider-ready prompt covering the complete render. */
  visualPrompt: z.string().trim().min(120),
  cameraMotion: VideoCameraMotionSchema,
  cameraDirection: DetailedText,
  negativePrompt: z.string().trim().min(20),
  timelineBeats: z.array(TimelineBeatSchema).min(2).max(MAX_TIMELINE_BEATS),
  /**
   * Desired Agnes-native diegetic sounds and the identical ElevenLabs fallback
   * blueprint. Empty deliberately permits a full-length silent fallback stem.
   */
  foleyCues: z.array(FoleyCueSchema).max(20),
  music: z.discriminatedUnion('enabled', [EnabledMusicPromptSchema, DisabledMusicPromptSchema]),
  delivery: DeliverySchema,
  youtubeUpload: YouTubeUploadRequestSchema.optional(),
}).strict().superRefine((plan, context) => {
  const beatIds = new Set<string>();
  let cursor = 0;
  plan.timelineBeats.forEach((beat, index) => {
    if (beatIds.has(beat.beatId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timelineBeats', index, 'beatId'],
        message: `beatId ${beat.beatId} must be unique.`,
      });
    }
    beatIds.add(beat.beatId);
    if (beat.startSeconds !== cursor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timelineBeats', index, 'startSeconds'],
        message: `Beat ${index + 1} must start at ${cursor.toFixed(2)} seconds.`,
      });
    }
    if (beat.endSeconds <= beat.startSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timelineBeats', index, 'endSeconds'],
        message: 'Each beat must have positive duration.',
      });
    }
    cursor = beat.endSeconds;
  });
  if (cursor !== plan.totalDurationSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['timelineBeats'],
      message: `Timeline beats must end exactly at ${plan.totalDurationSeconds.toFixed(2)} seconds.`,
    });
  }

  const cueIds = new Set<string>();
  plan.foleyCues.forEach((cue, cueIndex) => {
    if (cue.atSeconds + cue.durationSeconds > plan.totalDurationSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['foleyCues', cueIndex, 'durationSeconds'],
        message: `Cue must end by ${plan.totalDurationSeconds.toFixed(2)} seconds.`,
      });
    }
    if (cueIds.has(cue.cueId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['foleyCues', cueIndex, 'cueId'],
        message: `cueId ${cue.cueId} must be unique.`,
      });
    }
    cueIds.add(cue.cueId);
    const containingBeatIndex = plan.timelineBeats.findIndex((beat) =>
      cue.atSeconds >= beat.startSeconds && cue.atSeconds < beat.endSeconds,
    );
    const canonical = `[${cue.atSeconds.toFixed(2)}s] ${cue.visualAction}`;
    const containingBeat = plan.timelineBeats[containingBeatIndex];
    if (!containingBeat?.visualAction.includes(canonical)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timelineBeats', Math.max(0, containingBeatIndex), 'visualAction'],
        message: `The containing beat must include the shared timed action exactly as: ${canonical}`,
      });
    }
    if (
      cue.timingClass === 'must_sync'
      && !cue.continuous
      && (cue.atSeconds < 0.2 || cue.atSeconds > plan.totalDurationSeconds - 0.2)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['foleyCues', cueIndex, 'atSeconds'],
        message: 'A must_sync transient needs at least 0.20s of visual context before and after it.',
      });
    }
  });

  if (plan.music.enabled) {
    if (plan.music.durationSeconds !== plan.totalDurationSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['music', 'durationSeconds'],
        message: 'Enabled music duration must equal totalDurationSeconds.',
      });
    }
    if (plan.music.beats.length !== plan.timelineBeats.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['music', 'beats'],
        message: 'Enabled music must contain one window for every creative timeline beat.',
      });
    }
    plan.music.beats.forEach((musicBeat, index) => {
      const visualBeat = plan.timelineBeats[index];
      if (
        !visualBeat
        || musicBeat.beatId !== visualBeat.beatId
        || musicBeat.startSeconds !== visualBeat.startSeconds
        || musicBeat.endSeconds !== visualBeat.endSeconds
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['music', 'beats', index],
          message: `Music window ${index + 1} must exactly match creative timeline beat ${index + 1}.`,
        });
      }
    });
  }
});

export type VideoPlan = z.infer<typeof VideoPlanSchema>;
export type TimelineBeat = z.infer<typeof TimelineBeatSchema>;
export type VideoCameraMotion = z.infer<typeof VideoCameraMotionSchema>;
export type TimedFoleyCue = z.infer<typeof FoleyCueSchema>;
export type EnabledMusicPlan = z.infer<typeof EnabledMusicPromptSchema>;
export type YouTubeUploadRequest = z.infer<typeof YouTubeUploadRequestSchema>;

export function enabledMusicForPlan(plan: VideoPlan): EnabledMusicPlan | null {
  return plan.music.enabled ? plan.music : null;
}

export function planUsesBackgroundMusic(plan: VideoPlan): boolean {
  return enabledMusicForPlan(plan) !== null;
}

export class VideoPlanPromptMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoPlanPromptMismatchError';
  }
}

export class VideoPlanAudioChoreographyError extends VideoPlanPromptMismatchError {
  constructor(message: string) {
    super(message);
    this.name = 'VideoPlanAudioChoreographyError';
  }
}

/**
 * Enforces the current sparse sound-direction policy for newly proposed plans.
 *
 * Deliberately do not attach this policy to VideoPlanSchema: that schema also
 * parses retained schema-v2 plans, whose immutable cue sheets may predate the
 * stricter Agnes choreography guidance. Plan-validation entry points should
 * call this function only after establishing that no locked plan is being
 * reused.
 */
export function validateNewVideoPlanAudioChoreography(plan: VideoPlan): VideoPlan {
  const issues: string[] = [];
  const mustSyncTransients = plan.foleyCues
    .filter((cue) => !cue.continuous && cue.timingClass === 'must_sync')
    .sort((left, right) => left.atSeconds - right.atSeconds);

  for (const beat of plan.timelineBeats) {
    const cuesInBeat = mustSyncTransients.filter((cue) =>
      cue.atSeconds >= beat.startSeconds && cue.atSeconds < beat.endSeconds,
    );
    if (cuesInBeat.length > 1) {
      issues.push(
        `timeline beat ${beat.beatId} contains ${cuesInBeat.length} non-continuous must_sync cues `
          + `(${cuesInBeat.map(({ cueId }) => cueId).join(', ')}); at most one is allowed per beat`,
      );
    }
  }

  for (let index = 1; index < mustSyncTransients.length; index += 1) {
    const previous = mustSyncTransients[index - 1];
    const current = mustSyncTransients[index];
    if (!previous || !current) continue;
    const spacing = current.atSeconds - previous.atSeconds;
    if (spacing < MIN_MUST_SYNC_TRANSIENT_SPACING_SECONDS) {
      issues.push(
        `must_sync cues ${previous.cueId} and ${current.cueId} are ${spacing.toFixed(2)} seconds apart; `
          + `they require at least ${MIN_MUST_SYNC_TRANSIENT_SPACING_SECONDS.toFixed(2)} seconds`,
      );
    }
  }

  const foregroundTransients = plan.foleyCues.filter((cue) =>
    !cue.continuous && cue.prominence === 'foreground',
  );
  const foregroundBudget = plan.totalDurationSeconds <= 8
    ? MAX_SHORT_FOREGROUND_TRANSIENTS
    : MAX_LONG_FOREGROUND_TRANSIENTS;
  if (foregroundTransients.length > foregroundBudget) {
    issues.push(
      `${plan.totalDurationSeconds}-second plans allow at most ${foregroundBudget} foreground transients; `
        + `received ${foregroundTransients.length}`,
    );
  }

  if (issues.length > 0) {
    throw new VideoPlanAudioChoreographyError(
      `The proposed diegetic sound choreography is too dense for Agnes: ${issues.join('; ')}. `
        + 'Use fewer, wider, sequential sound actions and validate the revised plan again.',
    );
  }
  return plan;
}

export function parseVideoPlan(input: unknown): VideoPlan {
  return VideoPlanSchema.parse(input);
}

/** Validates both structure and trusted prompt-derived intent. */
export function parseVideoPlanForPrompt(input: unknown, originalPrompt: string): VideoPlan {
  const plan = parseVideoPlan(input);
  const promptRequestsUpload = promptExplicitlyRequestsYouTubeUpload(originalPrompt);
  const planRequestsUpload = plan.youtubeUpload?.requested === true;

  if (promptRequestsUpload !== planRequestsUpload) {
    throw new VideoPlanPromptMismatchError(
      promptRequestsUpload
        ? 'The original prompt explicitly requests a YouTube upload, so youtubeUpload metadata is required in the plan.'
        : 'youtubeUpload metadata is forbidden because the original prompt does not explicitly request a YouTube upload.',
    );
  }
  const promptDisablesMusic = promptExplicitlyDisablesBackgroundMusic(originalPrompt);
  const planDisablesMusic = !plan.music.enabled;
  if (promptDisablesMusic !== planDisablesMusic) {
    throw new VideoPlanPromptMismatchError(
      promptDisablesMusic
        ? 'The original prompt explicitly disables background music, so the plan must use music.enabled=false and retain Foley.'
        : 'The plan cannot disable background music because the original prompt did not explicitly request Foley-only output.',
    );
  }
  return plan;
}
