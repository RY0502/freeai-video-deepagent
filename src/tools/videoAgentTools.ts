import { createHash, randomBytes } from "node:crypto";
import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import {
  AGNES_VIDEO_MODEL,
  AgnesError,
  isAgnesProviderCapacityRejection,
  type AgnesTaskStatus,
  type AgnesVideoClient,
  type AgnesVideoTask,
} from "../agnes/index.js";
import {
  ASPECT_RATIO_SUGGESTIONS,
  CAMERA_MOTION_SUGGESTIONS,
  DOCUMENTED_NEGATIVE_PROMPT_SUGGESTION,
  FEATURED_INSTRUMENT_SUGGESTIONS,
  MUSIC_GENRE_SUGGESTIONS,
  VIDEO_STYLE_SUGGESTIONS,
  resolvePromptMediaPreferences,
  type ResolvedPromptMediaPreferences,
} from "../agent/mediaPreferences.js";
import { recoverableVideoPlanRejection } from "../agent/planTool.js";
import {
  VideoPlanSchema,
  enabledMusicForPlan,
  parseVideoPlanForPrompt,
  planUsesBackgroundMusic,
  validateNewVideoPlanAudioChoreography,
  type TimedFoleyCue,
  type VideoPlan,
} from "../agent/videoPlan.js";
import type { AppConfig } from "../config.js";
import {
  finalVideoArtifactPaths,
  isLegacyFinalVideoFileName,
  isPromptFinalVideoFileName,
  isPromptFinalVideoPartialFileName,
} from "../final-video.js";
import {
  ElevenLabsError,
  resolveFoleySoundEffectRequest,
  type ElevenLabsClient,
} from "../elevenlabs/index.js";
import {
  DEFAULT_FREE_AI_MUSIC_MAX_RETRIES,
  FREE_AI_MUSIC_MODEL,
  FreeAiMusicError,
  type FreeAiMusicAttempt,
  type FreeAiMusicClient,
  type FreeAiMusicResult,
} from "../freeai/index.js";
import {
  AUDIO_MIX_REVISION,
  BACKGROUND_MUSIC_MIX,
  DEFAULT_MEDIA_PROCESS_TIMEOUT_MS,
  FOLEY_CUE_MAX_NORMALIZATION_GAIN_DB,
  FOLEY_CUE_MIN_USABLE_PEAK_DBFS,
  FOLEY_CUE_TARGET_MEAN_DBFS,
  SOURCE_AUDIO_INSPECTION_REVISION,
  SourceAudioInspectionDocumentSchema,
  assembleVideo,
  inspectSourceAudio,
  loadReusableSourceAudioInspection,
  renderFoleyStem,
  validateExistingAudio,
  validateExistingVideo,
  type ExistingAudioValidationInput,
  type ExistingVideoValidationInput,
  type InspectSourceAudioInput,
  type SourceAudioInspectionDocument,
  type VideoAssemblyResult,
} from "../media/index.js";
import {
  VideoRunStateStore,
  videoCheckpointKeys,
  type ArtifactCheckpoint,
  type PersistedProviderJob,
  type VideoCheckpointKey,
} from "../state/videoRunState.js";
import { ensureDirectory, sha256File, writeJsonAtomic } from "../utils/files.js";
import {
  FOLEY_RECONCILIATION_MODEL,
  FOLEY_RECONCILIATION_REVISION,
  createFoleyVisionClientFromEnv,
  loadReusableFoleyReconciliation,
  plannedFoleyCueDigest,
  reconcileFoleyPlanToRenderedVideo,
  type FoleyReconciliationDocument,
  type FoleyVisionClient,
} from "../vision/index.js";
import { YouTubeUploadError, type YouTubeUploader } from "../youtube/index.js";

const EmptyInputSchema = z.object({}).strict();
const ValidatePlanInputSchema = z.object({ plan: VideoPlanSchema }).strict();

export const VIDEO_TOOL_NAMES = {
  status: "get_video_run_status",
  validatePlan: "validate_video_plan",
  generateVideo: "generate_video",
  generateMusic: "generate_music_track",
  generateFoley: "generate_foley_track",
  assembleVideo: "assemble_final_video",
  youtubeUpload: "upload_final_video_to_youtube",
} as const;

/** Increment only when the deterministic text sent to Agnes changes. */
export const AGNES_PROMPT_REVISION = 2 as const;

export const FOLEY_PROMINENCE_GAIN: Readonly<Record<TimedFoleyCue["prominence"], number>> =
  Object.freeze({ foreground: 1, supporting: 0.55, ambient: 0.4 });
export const FOLEY_INTENSITY_GAIN: Readonly<Record<TimedFoleyCue["intensity"], number>> =
  Object.freeze({ strong: 1, medium: 0.9, subtle: 0.7 });

export interface CreateVideoAgentToolsOptions {
  originalPrompt: string;
  runDirectory: string;
  config: AppConfig;
  stateStore: VideoRunStateStore;
  agnes: AgnesVideoClient;
  elevenLabs: ElevenLabsClient;
  freeAiMusic: FreeAiMusicClient;
  /** Defaults lazily to the rotating env-backed free-tier vision orchestrator. */
  foleyVision?: FoleyVisionClient;
  youtube?: {
    uploader: YouTubeUploader;
    authorizationToken: string;
  };
  /** Test seam for FFprobe validation; production always uses validateExistingAudio. */
  validateMusicArtifact?: (input: ExistingAudioValidationInput) => Promise<unknown>;
  /** Test seam for the deterministic FFprobe/FFmpeg source-audio inspection. */
  inspectSourceAudioArtifact?: (
    input: InspectSourceAudioInput,
  ) => Promise<SourceAudioInspectionDocument>;
  now?: () => Date;
  onEvent?: (event: VideoAgentEvent) => void;
}

export interface VideoPromptControls {
  cameraMotion: VideoPlan["cameraMotion"];
  negativePrompt: string;
  negativeBible: string[];
}

export interface ResolvedGenerationConfiguration {
  video: {
    provider: "agnes";
    model: typeof AGNES_VIDEO_MODEL;
    durationSeconds: number;
    visualStyle: VideoPlan["delivery"]["visualStyle"];
    aspectRatio: VideoPlan["delivery"]["aspectRatio"];
    width: number;
    height: number;
    fps: number;
    cameraMotion: VideoPlan["cameraMotion"];
    negativePrompt: string;
  };
  foley: {
    provider: "elevenlabs";
    model: "eleven_text_to_sound_v2";
    role: "fallback";
    trigger: "missing_or_unusable_agnes_audio";
    sourceAudioInspectionRevision: number;
    durationSeconds: number;
    cueCount: number;
    placement: "local_ffmpeg_sample_timeline";
    audioMixRevision: number;
    foleyReconciliationRevision: number;
    cueTargetMeanDbfs: number;
    cueMaxNormalizationGainDb: number;
    cueMinUsablePeakDbfs: number;
    prominenceGain: Readonly<Record<TimedFoleyCue["prominence"], number>>;
    intensityGain: Readonly<Record<TimedFoleyCue["intensity"], number>>;
  };
  music:
    | { enabled: false }
    | {
        enabled: true;
        provider: "free.ai";
        model: typeof FREE_AI_MUSIC_MODEL;
        durationSeconds: number;
        providerDurationSeconds: number;
        genre: string;
        mood: string;
        tempoBpm: number;
        featuredInstrument?: string;
        role: "background";
      };
  assembly: {
    container: "mp4";
    videoCodec: "h264";
    audioCodec: "aac";
    musicVolume: number;
    foleyVolume: number;
    audioMixRevision: number;
    backgroundMusicMix: typeof BACKGROUND_MUSIC_MIX;
  };
  youtube?: {
    requested: true;
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
    privacyStatus: "private" | "unlisted" | "public";
    madeForKids: boolean;
    containsSyntheticMedia: boolean;
    notifySubscribers: false;
  };
  cleanupAfterSuccess: boolean;
}

export type VideoAgentEvent =
  | { event: "generation_configuration"; phase: "prompt_resolved" | "plan_locked" | "plan_reused"; configuration: Record<string, unknown> }
  | { event: "video_submission_started"; model: typeof AGNES_VIDEO_MODEL; attemptNumber: number; resubmission: boolean; durationSeconds: number; aspectRatio: string; requestTimeoutMs: number; pollIntervalMs: number; pollWindowMs: number; controls: VideoPromptControls }
  | { event: "video_key_attempt"; keyLabel: string }
  | { event: "video_task_submitted"; videoId: string; taskId: string; status: AgnesTaskStatus; progress: number; keyLabel: string }
  | { event: "video_poll_result"; videoId: string; pollNumber: number; status: AgnesTaskStatus; progress: number; elapsedMs: number; downloadReady?: boolean }
  | { event: "video_poll_error"; videoId: string; pollNumber: number; reason: string; elapsedMs: number }
  | { event: "video_poll_window_exhausted"; videoId: string; status: AgnesTaskStatus; progress: number; pollCount: number; pollWindowMs: number; awaitingOutputUrl?: boolean }
  | { event: "video_poll_interrupted"; videoId: string; reason: string }
  | { event: "video_downloaded"; path: string; model: typeof AGNES_VIDEO_MODEL; source: "provider" | "local_reuse" }
  | { event: "video_generation_failed"; reason: string; retrySafe: boolean; source: "provider" | "snapshot" }
  | { event: "source_audio_inspection_started"; sourceVideoSha256: string; inspectionRevision: number }
  | { event: "source_audio_inspection_completed"; path: string; source: "generated" | "local_reuse"; usable: boolean; reason: string; hasAudioStream: boolean; activeDurationSeconds: number; peakVolumeDbfs: number | null; meanVolumeDbfs: number | null }
  | { event: "source_audio_inspection_failed"; reason: string; retrySafe: true }
  | { event: "foreground_audio_selected"; mode: "agnes_native" | "elevenlabs_foley"; source: "generated" | "local_reuse"; reason: string }
  | { event: "foley_vision_started"; cueCount: number; sourceVideoSha256: string; reconciliationRevision: number }
  | { event: "foley_vision_pass"; phase: "coarse_started" | "coarse_completed" | "fine_started" | "fine_completed"; cueCount: number; provider?: string; model?: string }
  | { event: "foley_vision_decision"; cueId: string; decision: "keep" | "retime" | "omit"; plannedAtSeconds: number; resolvedAtSeconds: number | null; confidence: number; matchesPlannedCause: boolean; reason: string }
  | { event: "foley_vision_completed"; path: string; source: "generated" | "local_reuse"; retainedCueCount: number; omittedCueCount: number; retimedCueCount: number; providers: string[] }
  | { event: "foley_vision_failed"; reason: string; retrySafe: true }
  | { event: "music_generation_started"; model: typeof FREE_AI_MUSIC_MODEL; durationSeconds: number; providerDurationSeconds: number; requestTimeoutMs: number; maxRetries: number }
  | { event: "music_download_resumed"; model: typeof FREE_AI_MUSIC_MODEL; checkpointAttempt: number }
  | { event: "music_key_attempt"; model: typeof FREE_AI_MUSIC_MODEL; keyLabel: string; attemptNumber: number; maxAttempts: number }
  | { event: "music_download_attempt"; model: typeof FREE_AI_MUSIC_MODEL; attemptNumber: number; maxAttempts: number }
  | { event: "music_downloaded"; path: string; model: typeof FREE_AI_MUSIC_MODEL; source: "provider" | "local_reuse" }
  | { event: "music_generation_failed"; reason: string; retrySafe: boolean; source: "provider" | "local" | "snapshot" }
  | { event: "music_omitted"; reason: string; source: "provider" | "local" | "snapshot"; foleyOnly: true }
  | { event: "foley_generation_started"; cueCount: number; durationSeconds: number; placement: "local_ffmpeg_sample_timeline" }
  | { event: "foley_key_attempt"; cueId: string; keyLabel: string }
  | { event: "foley_mix_rebuild"; previousRevision: number | null; audioMixRevision: number; cueAssetsRetained: true }
  | { event: "foley_completed"; path: string; cueCount: number; generatedCueCount: number; reusedCueCount: number; source: "generated" | "local_rebuild" | "local_reuse" }
  | { event: "assembly_started"; attempt: number; path: string; durationSeconds: number; processTimeoutMs: number; foregroundAudioMode: "agnes_native" | "elevenlabs_foley"; backgroundMusicIncluded: boolean; musicVolume: number; foleyVolume: number; backgroundMusicMix: typeof BACKGROUND_MUSIC_MIX }
  | { event: "assembly_completed"; attempt: number; path: string; elapsedMs: number }
  | { event: "assembly_failed"; attempt: number; reason: string; elapsedMs: number; processTimeoutMs: number; retrySafe: true; retainedInputs: true }
  | { event: "youtube_upload_started"; title: string; categoryId: string; tagCount: number; privacyStatus: "private" | "unlisted" | "public"; madeForKids: boolean; containsSyntheticMedia: boolean }
  | { event: "youtube_upload_completed"; videoId: string; url: string; privacyStatus: "private" | "unlisted" | "public" }
  | { event: "youtube_upload_failed"; reason: string; retrySafe: boolean; ambiguousOutcome: boolean }
  | { event: "artifact_cleanup"; requested: boolean; performed: boolean; retention: CleanupValidatedRunArtifactsResult["retention"]; reason: string };

export interface VideoToolBundle {
  tools: DynamicStructuredTool[];
  names: typeof VIDEO_TOOL_NAMES;
  youtubeUploadAuthorized: boolean;
  currentInvocationPending(): string | null;
  currentInvocationFailure(): string | null;
}

interface DownloadedMusicArtifact {
  filePath: string;
  url: string;
  downloadAttempts: number;
  providerDurationSeconds: number;
  externalId?: string;
  keyLabel?: string;
  generationAttempts?: number;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function emitEvent(
  observer: CreateVideoAgentToolsOptions["onEvent"],
  event: VideoAgentEvent,
): void {
  try {
    observer?.(event);
  } catch {
    // Observability must never alter provider or state behavior.
  }
}

/**
 * Migrate only the known historical misclassification. A real ambiguous POST
 * remains blocked unless it has a durable Agnes receipt to poll.
 */
function isLegacyRetryableCapacityCheckpoint(
  checkpoint: ArtifactCheckpoint | null | undefined,
): checkpoint is ArtifactCheckpoint {
  return checkpoint?.status === "unknown"
    && checkpoint.provider === "agnes"
    && checkpoint.providerJob === undefined
    && checkpoint.externalId === undefined
    && checkpoint.url === undefined
    && checkpoint.details?.submissionIntent === "prepared"
    && isAgnesProviderCapacityRejection(checkpoint.error ?? "");
}

export function resolvePromptPreferencesForConfig(
  originalPrompt: string,
  config: AppConfig,
): ResolvedPromptMediaPreferences {
  return resolvePromptMediaPreferences(originalPrompt, {
    video: {
      style: config.VIDEO_STYLE,
      aspectRatio: config.VIDEO_ASPECT_RATIO,
      fps: config.VIDEO_FPS,
    },
  });
}

export function resolveGenerationConfiguration(
  plan: VideoPlan,
  originalPrompt: string,
  config: AppConfig,
): ResolvedGenerationConfiguration {
  const preferences = resolvePromptPreferencesForConfig(originalPrompt, config);
  const music = enabledMusicForPlan(plan);
  return {
    video: {
      provider: "agnes",
      model: AGNES_VIDEO_MODEL,
      durationSeconds: plan.totalDurationSeconds,
      visualStyle: plan.delivery.visualStyle,
      aspectRatio: plan.delivery.aspectRatio,
      width: plan.delivery.width,
      height: plan.delivery.height,
      fps: plan.delivery.fps,
      cameraMotion: plan.cameraMotion,
      negativePrompt: plan.negativePrompt,
    },
    foley: {
      provider: "elevenlabs",
      model: "eleven_text_to_sound_v2",
      role: "fallback",
      trigger: "missing_or_unusable_agnes_audio",
      sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      durationSeconds: plan.totalDurationSeconds,
      cueCount: plan.foleyCues.length,
      placement: "local_ffmpeg_sample_timeline",
      audioMixRevision: AUDIO_MIX_REVISION,
      foleyReconciliationRevision: FOLEY_RECONCILIATION_REVISION,
      cueTargetMeanDbfs: FOLEY_CUE_TARGET_MEAN_DBFS,
      cueMaxNormalizationGainDb: FOLEY_CUE_MAX_NORMALIZATION_GAIN_DB,
      cueMinUsablePeakDbfs: FOLEY_CUE_MIN_USABLE_PEAK_DBFS,
      prominenceGain: FOLEY_PROMINENCE_GAIN,
      intensityGain: FOLEY_INTENSITY_GAIN,
    },
    music: music
      ? {
          enabled: true,
          provider: "free.ai",
          model: FREE_AI_MUSIC_MODEL,
          durationSeconds: plan.totalDurationSeconds,
          providerDurationSeconds: freeAiMusicDurationSeconds(plan),
          genre: music.genre,
          mood: music.mood,
          tempoBpm: music.tempoBpm,
          ...(music.featuredInstrument ? { featuredInstrument: music.featuredInstrument } : {}),
          role: "background",
        }
      : { enabled: false },
    assembly: {
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      musicVolume: config.VIDEO_MUSIC_VOLUME,
      foleyVolume: config.VIDEO_FOLEY_VOLUME,
      audioMixRevision: AUDIO_MIX_REVISION,
      backgroundMusicMix: BACKGROUND_MUSIC_MIX,
    },
    ...(plan.youtubeUpload ? {
      youtube: {
        requested: true as const,
        title: plan.youtubeUpload.title,
        description: plan.youtubeUpload.description,
        tags: [...plan.youtubeUpload.tags],
        categoryId: plan.youtubeUpload.categoryId,
        privacyStatus: config.YOUTUBE_DEFAULT_PRIVACY,
        madeForKids: config.YOUTUBE_DEFAULT_MADE_FOR_KIDS,
        containsSyntheticMedia: config.YOUTUBE_DEFAULT_CONTAINS_SYNTHETIC_MEDIA,
        notifySubscribers: false as const,
      },
    } : {}),
    cleanupAfterSuccess: preferences.cleanupAfterSuccess,
  };
}

function publicPromptPreferences(preferences: ResolvedPromptMediaPreferences): Record<string, unknown> {
  return {
    video: preferences.video,
    duration: {
      providerRangeSeconds: [4, 12],
      defaultTargetSeconds: [10, 12],
      shorterDurationRequiresExplicitPrompt: true,
    },
    backgroundMusic: preferences.backgroundMusic,
    ...(preferences.music ? { music: preferences.music } : {}),
    cleanupAfterSuccess: preferences.cleanupAfterSuccess,
    availableOptions: {
      styles: VIDEO_STYLE_SUGGESTIONS,
      aspectRatios: ASPECT_RATIO_SUGGESTIONS,
      cameraMotions: CAMERA_MOTION_SUGGESTIONS,
      defaultNegativePrompt: DOCUMENTED_NEGATIVE_PROMPT_SUGGESTION,
      musicGenres: MUSIC_GENRE_SUGGESTIONS,
      featuredInstruments: FEATURED_INSTRUMENT_SUGGESTIONS,
      tempoBpmRange: [30, 300],
    },
  };
}

class VideoPlanConfigurationMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoPlanConfigurationMismatchError";
  }
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

interface PromptDerivedSoundRequirement {
  label: string;
  pattern: RegExp;
  sourcePattern?: RegExp;
  foreground?: boolean;
  continuous?: boolean;
}

/** Required semantic Foley layers inferred from common prompt actions. */
export function promptDerivedSoundRequirements(plan: VideoPlan): PromptDerivedSoundRequirement[] {
  const context = normalized(`${plan.concept} ${plan.creativeScript} ${plan.visualPrompt}`);
  const requirements: PromptDerivedSoundRequirement[] = [];
  if (
    /\b(?:dinosaur|dinosaurs|dino|theropod|tyrannosaur|raptor|triceratops)\b/.test(context)
    && /\b(?:fight|fighting|attack|lunge|roar|growl)\b/.test(context)
  ) requirements.push({ label: "a foreground dinosaur roar/growl", pattern: /\b(?:roar|growl|bellow|snarl)\b/, foreground: true });
  if (
    /\b(?:dogs?|pupp(?:y|ies)|canines?(?!\s+(?:tooth|teeth)\b))\b/.test(context)
    && /\b(?:bark(?:s|ed|ing)?|growl(?:s|ed|ing)?|snarl(?:s|ed|ing)?)\b/.test(context)
  ) {
    requirements.push({
      label: "a foreground dog/canine bark, growl, or snarl",
      pattern: /\b(?:bark(?:s|ed|ing)?|growl(?:s|ed|ing)?|snarl(?:s|ed|ing)?|woofs?)\b/,
      sourcePattern: /\b(?:dogs?|pupp(?:y|ies)|canines?(?!\s+(?:tooth|teeth)\b))\b/,
      foreground: true,
    });
  }
  if (
    /\b(?:cats?|felines?|kittens?)\b/.test(context)
    && /\b(?:m(?:eow|iaow)(?:s|ed|ing)?|mew(?:s|ed|ing)?|hiss(?:es|ed|ing)?|growl(?:s|ed|ing)?)\b/.test(context)
  ) {
    requirements.push({
      label: "a foreground cat/feline meow, hiss, or growl",
      pattern: /\b(?:m(?:eow|iaow)(?:s|ed|ing)?|mew(?:s|ed|ing)?|hiss(?:es|ed|ing)?|growl(?:s|ed|ing)?)\b/,
      sourcePattern: /\b(?:cats?|felines?|kittens?)\b/,
      foreground: true,
    });
  }
  if (
    /\b(?:car|vehicle|truck|motorcycle|driving|road)\b/.test(context)
    && /\b(?:drive|drives|driving|cruise|cruises|moving|road)\b/.test(context)
  ) requirements.push({ label: "continuous engine/tire road sound", pattern: /\b(?:engine|motor|tire|tyre|road noise)\b/, foreground: true, continuous: true });
  if (/\b(?:rain|raining|rainfall|downpour|drizzle|storm)\b/.test(context)) {
    requirements.push({ label: "continuous rain sound", pattern: /\b(?:rain|rainfall|downpour|drizzle)\b/, continuous: true });
  }
  if (/\b(?:coast|coastal|ocean|sea|shore|beach)\b/.test(context)) {
    requirements.push({ label: "continuous coastal surf/wind ambience", pattern: /\b(?:ocean|surf|wave|coastal wind)\b/, continuous: true });
  }
  if (
    /\b(?:batsman|batter|cricket)\b/.test(context)
    && /\b(?:hit|hits|strikes|shot|ball)\b/.test(context)
  ) requirements.push({ label: "a synchronized bat-ball impact", pattern: /\b(?:bat.{0,20}(?:hit|impact|contact)|ball.{0,20}(?:hit|impact|contact)|crack of the bat)\b/, foreground: true });
  if (/\bcrowd\b/.test(context) && /\b(?:roar|cheer|cheering|erupts|applause)\b/.test(context)) {
    requirements.push({ label: "the crowd roar/cheer", pattern: /\b(?:crowd|cheer|applause|stadium roar)\b/, foreground: true });
  }
  return requirements;
}

function cueMeetsRequirement(cue: TimedFoleyCue, requirement: PromptDerivedSoundRequirement): boolean {
  const sound = normalized(cue.sound);
  return requirement.pattern.test(sound)
    && (!requirement.sourcePattern || requirement.sourcePattern.test(sound))
    && (!requirement.foreground || cue.prominence === "foreground")
    && (!requirement.continuous || cue.continuous);
}

function assertPlanMatchesPromptPreferences(
  plan: VideoPlan,
  preferences: ResolvedPromptMediaPreferences,
  config: AppConfig,
): void {
  const mismatch: string[] = [];
  if (plan.delivery.visualStyle !== preferences.video.style) {
    mismatch.push(`delivery.visualStyle must be ${preferences.video.style}`);
  }
  if (plan.delivery.aspectRatio !== preferences.video.aspectRatio) {
    mismatch.push(`delivery.aspectRatio must be ${preferences.video.aspectRatio}`);
  }
  if (plan.delivery.width !== preferences.video.width || plan.delivery.height !== preferences.video.height) {
    mismatch.push(`delivery dimensions must be ${preferences.video.width}x${preferences.video.height}`);
  }
  if (plan.delivery.fps !== preferences.video.fps) mismatch.push(`delivery.fps must be ${preferences.video.fps}`);
  if (preferences.video.cameraMotion && plan.cameraMotion !== preferences.video.cameraMotion) {
    mismatch.push(`cameraMotion must be ${preferences.video.cameraMotion}`);
  }
  if (
    preferences.video.negativePrompt
    && !normalized(plan.negativePrompt).includes(normalized(preferences.video.negativePrompt))
  ) mismatch.push("negativePrompt must preserve the user's explicit negative constraints");
  if (plan.music.enabled !== preferences.backgroundMusic.enabled) {
    mismatch.push(preferences.backgroundMusic.enabled
      ? "music must be enabled unless the user explicitly disables background music"
      : "music must be disabled because the user explicitly requested no background music");
  }
  if (plan.music.enabled && preferences.music) {
    if (preferences.music.genre && normalized(plan.music.genre) !== normalized(preferences.music.genre)) {
      mismatch.push(`music.genre must be ${preferences.music.genre}`);
    }
    if (preferences.music.tempoBpm && plan.music.tempoBpm !== preferences.music.tempoBpm) {
      mismatch.push(`music.tempoBpm must be ${preferences.music.tempoBpm}`);
    }
    if (
      preferences.music.featuredInstrument
      && normalized(plan.music.featuredInstrument ?? "") !== normalized(preferences.music.featuredInstrument)
    ) mismatch.push(`music.featuredInstrument must be ${preferences.music.featuredInstrument}`);
  }
  if (plan.youtubeUpload) {
    if (plan.youtubeUpload.privacyStatus !== config.YOUTUBE_DEFAULT_PRIVACY) {
      mismatch.push(`youtubeUpload.privacyStatus must be the trusted configured value ${config.YOUTUBE_DEFAULT_PRIVACY}`);
    }
    if (plan.youtubeUpload.madeForKids !== config.YOUTUBE_DEFAULT_MADE_FOR_KIDS) {
      mismatch.push(`youtubeUpload.madeForKids must be the trusted configured value ${config.YOUTUBE_DEFAULT_MADE_FOR_KIDS}`);
    }
  }
  const missingSounds = promptDerivedSoundRequirements(plan)
    .filter((requirement) => !plan.foleyCues.some((cue) => cueMeetsRequirement(cue, requirement)))
    .map(({ label }) => label);
  if (missingSounds.length) mismatch.push(`foleyCues must include ${missingSounds.join(", ")}`);
  if (mismatch.length) throw new VideoPlanConfigurationMismatchError(mismatch.join("; "));
}

export async function completedArtifactIsValid(
  checkpoint: ArtifactCheckpoint | null | undefined,
): Promise<boolean> {
  if (checkpoint?.status !== "completed" || !checkpoint.path || !checkpoint.sha256) return false;
  try {
    const information = await stat(checkpoint.path);
    return information.isFile() && information.size > 0
      && await sha256File(checkpoint.path) === checkpoint.sha256;
  } catch {
    return false;
  }
}

export function foleyMixRevisionIsCurrent(
  checkpoint: ArtifactCheckpoint | null | undefined,
): boolean {
  return checkpoint?.provider === "elevenlabs+local"
    && checkpoint.model === "eleven_text_to_sound_v2+ffmpeg"
    && checkpoint.details?.audioMixRevision === AUDIO_MIX_REVISION
    && checkpoint.details?.sourceAudioInspectionRevision === SOURCE_AUDIO_INSPECTION_REVISION
    && typeof checkpoint.details?.sourceAudioAnalysisSha256 === "string"
    && /^[a-f0-9]{64}$/.test(checkpoint.details.sourceAudioAnalysisSha256)
    && checkpoint.details?.foleyReconciliationRevision === FOLEY_RECONCILIATION_REVISION
    && typeof checkpoint.details?.foleyReconciliationSha256 === "string"
    && /^[a-f0-9]{64}$/.test(checkpoint.details.foleyReconciliationSha256)
    && typeof checkpoint.details?.sourceVideoSha256 === "string"
    && /^[a-f0-9]{64}$/.test(checkpoint.details.sourceVideoSha256);
}

export interface FoleyArtifactDependencies {
  sourceVideoSha256: string;
  sourceAudioAnalysisSha256: string;
  reconciliationSha256: string;
}

/** Only a stem rendered with the current per-cue loudness recipe is reusable. */
export async function completedFoleyArtifactIsValid(
  checkpoint: ArtifactCheckpoint | null | undefined,
  expectedDependencies?: string | FoleyArtifactDependencies,
): Promise<boolean> {
  const expectedReconciliationSha256 = typeof expectedDependencies === "string"
    ? expectedDependencies
    : expectedDependencies?.reconciliationSha256;
  return foleyMixRevisionIsCurrent(checkpoint)
    && (
      expectedReconciliationSha256 === undefined
      || checkpoint?.details?.foleyReconciliationSha256 === expectedReconciliationSha256
    )
    && (
      !expectedDependencies
      || typeof expectedDependencies === "string"
      || (
        checkpoint?.details?.sourceVideoSha256 === expectedDependencies.sourceVideoSha256
        && checkpoint.details?.sourceAudioAnalysisSha256
          === expectedDependencies.sourceAudioAnalysisSha256
      )
    )
    && await completedArtifactIsValid(checkpoint);
}

export const SOURCE_AUDIO_ANALYSIS_MODEL = "ffprobe+ffmpeg-source-audio" as const;
export const AGNES_NATIVE_AUDIO_MODEL = "agnes-video-2.5-flash-native-audio" as const;

export function nativeSourceAudioSelectionIsCurrent(
  checkpoint: ArtifactCheckpoint | null | undefined,
  expected?: {
    sourceVideoSha256: string;
    sourceAudioAnalysisSha256: string;
  },
): boolean {
  return checkpoint?.status === "skipped"
    && checkpoint.provider === "agnes"
    && checkpoint.model === AGNES_NATIVE_AUDIO_MODEL
    && checkpoint.details?.nativeSourceAudioSelected === true
    && checkpoint.details?.foregroundAudioMode === "agnes_native"
    && checkpoint.details?.sourceAudioInspectionRevision === SOURCE_AUDIO_INSPECTION_REVISION
    && typeof checkpoint.details?.sourceVideoSha256 === "string"
    && /^[a-f0-9]{64}$/.test(checkpoint.details.sourceVideoSha256)
    && typeof checkpoint.details?.sourceAudioAnalysisSha256 === "string"
    && /^[a-f0-9]{64}$/.test(checkpoint.details.sourceAudioAnalysisSha256)
    && (!expected || (
      checkpoint.details.sourceVideoSha256 === expected.sourceVideoSha256
      && checkpoint.details.sourceAudioAnalysisSha256 === expected.sourceAudioAnalysisSha256
    ));
}

/** Only the active music provider/model may satisfy a music dependency. */
export async function completedFreeAiMusicArtifactIsValid(
  checkpoint: ArtifactCheckpoint | null | undefined,
): Promise<boolean> {
  return checkpoint?.provider === "free.ai"
    && checkpoint.model === FREE_AI_MUSIC_MODEL
    && await completedArtifactIsValid(checkpoint);
}

/** A terminal best-effort music omission is assembly-ready without a file. */
export function optionalMusicWasOmitted(
  checkpoint: ArtifactCheckpoint | null | undefined,
): boolean {
  return checkpoint?.status === "skipped"
    && checkpoint.details?.optionalArtifactOmitted === true;
}

export function finalAudioMixRevisionIsCurrent(
  checkpoint: ArtifactCheckpoint | null | undefined,
  config: AppConfig,
): boolean {
  const musicDependencyStatus = checkpoint?.details?.musicDependencyStatus;
  const musicSha256 = checkpoint?.details?.musicSha256;
  const musicReceiptIsCurrent = musicDependencyStatus === "included"
    ? typeof musicSha256 === "string"
      && /^[a-f0-9]{64}$/.test(musicSha256)
      && checkpoint?.details?.backgroundMusicIncluded === true
      && checkpoint.details?.backgroundMusicRequested === true
      && checkpoint.details?.foleyOnlyFallback === false
    : (musicDependencyStatus === "skipped" || musicDependencyStatus === "disabled")
      && (musicSha256 === null || musicSha256 === undefined)
      && checkpoint?.details?.backgroundMusicIncluded === false
      && checkpoint.details?.backgroundMusicRequested === (musicDependencyStatus === "skipped")
      && checkpoint.details?.foleyOnlyFallback === (musicDependencyStatus === "skipped");
  const foregroundAudioMode = checkpoint?.details?.foregroundAudioMode;
  const foregroundReceiptIsCurrent = foregroundAudioMode === "agnes_native"
    ? checkpoint?.details?.foleySha256 === null
      && checkpoint.details?.foleyReconciliationRevision === null
      && checkpoint.details?.foleyReconciliationSha256 === null
    : foregroundAudioMode === "elevenlabs_foley"
      && typeof checkpoint?.details?.foleySha256 === "string"
      && /^[a-f0-9]{64}$/.test(checkpoint.details.foleySha256)
      && checkpoint.details?.foleyReconciliationRevision === FOLEY_RECONCILIATION_REVISION
      && typeof checkpoint.details?.foleyReconciliationSha256 === "string"
      && /^[a-f0-9]{64}$/.test(checkpoint.details.foleyReconciliationSha256);
  return checkpoint?.provider === "local"
    && checkpoint.model === "ffmpeg-static"
    && checkpoint.details?.audioMixRevision === AUDIO_MIX_REVISION
    && checkpoint.details?.sourceAudioInspectionRevision === SOURCE_AUDIO_INSPECTION_REVISION
    && typeof checkpoint.details?.sourceAudioAnalysisSha256 === "string"
    && /^[a-f0-9]{64}$/.test(checkpoint.details.sourceAudioAnalysisSha256)
    && typeof checkpoint.details?.sourceVideoSha256 === "string"
    && /^[a-f0-9]{64}$/.test(checkpoint.details.sourceVideoSha256)
    && foregroundReceiptIsCurrent
    && checkpoint.details?.musicVolume === config.VIDEO_MUSIC_VOLUME
    && checkpoint.details?.foleyVolume === config.VIDEO_FOLEY_VOLUME
    && musicReceiptIsCurrent;
}

export type FinalMusicDependencyStatus = "included" | "skipped" | "disabled";

export type ForegroundArtifactDependencies =
  | {
      foregroundAudioMode: "agnes_native";
      sourceVideoSha256: string;
      sourceAudioAnalysisSha256: string;
      foleySha256: null;
      reconciliationSha256: null;
    }
  | {
      foregroundAudioMode: "elevenlabs_foley";
      sourceVideoSha256: string;
      sourceAudioAnalysisSha256: string;
      foleySha256: string;
      reconciliationSha256: string;
    };

export type FinalArtifactDependencies = ForegroundArtifactDependencies & {
  musicDependencyStatus: FinalMusicDependencyStatus;
  musicSha256: string | null;
};

function finalDependencyDetails(
  dependencies: FinalArtifactDependencies,
): Record<string, unknown> {
  return {
    sourceVideoSha256: dependencies.sourceVideoSha256,
    sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
    sourceAudioAnalysisSha256: dependencies.sourceAudioAnalysisSha256,
    foregroundAudioMode: dependencies.foregroundAudioMode,
    foleySha256: dependencies.foleySha256,
    foleyReconciliationRevision: dependencies.foregroundAudioMode === "elevenlabs_foley"
      ? FOLEY_RECONCILIATION_REVISION
      : null,
    foleyReconciliationSha256: dependencies.reconciliationSha256,
    musicDependencyStatus: dependencies.musicDependencyStatus,
    musicSha256: dependencies.musicSha256,
  };
}

export function finalArtifactDependenciesMatch(
  checkpoint: ArtifactCheckpoint,
  expected: FinalArtifactDependencies,
): boolean {
  return checkpoint.details?.sourceVideoSha256 === expected.sourceVideoSha256
    && checkpoint.details?.sourceAudioInspectionRevision === SOURCE_AUDIO_INSPECTION_REVISION
    && checkpoint.details?.sourceAudioAnalysisSha256 === expected.sourceAudioAnalysisSha256
    && checkpoint.details?.foregroundAudioMode === expected.foregroundAudioMode
    && checkpoint.details?.foleySha256 === expected.foleySha256
    && checkpoint.details?.foleyReconciliationRevision === (
      expected.foregroundAudioMode === "elevenlabs_foley"
        ? FOLEY_RECONCILIATION_REVISION
        : null
    )
    && checkpoint.details?.foleyReconciliationSha256 === expected.reconciliationSha256
    && checkpoint.details?.musicDependencyStatus === expected.musicDependencyStatus
    && checkpoint.details?.musicSha256 === expected.musicSha256;
}

function checkpointProgress(checkpoint: ArtifactCheckpoint): number {
  const value = checkpoint.details?.progress;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function videoSnapshotEvent(
  checkpoint: ArtifactCheckpoint | null | undefined,
): Promise<VideoAgentEvent | null> {
  if (!checkpoint) return null;
  if (await completedArtifactIsValid(checkpoint)) {
    return {
      event: "video_downloaded",
      path: checkpoint.path as string,
      model: AGNES_VIDEO_MODEL,
      source: "local_reuse",
    };
  }
  if (checkpoint.status === "queued" || checkpoint.status === "in_progress") {
    if (!checkpoint.providerJob) return null;
    const providerStatus = checkpoint.providerStatus;
    const status: AgnesTaskStatus = providerStatus === "queued"
      || providerStatus === "in_progress"
      || providerStatus === "completed"
      || providerStatus === "failed"
      ? providerStatus
      : checkpoint.status;
    return {
      event: "video_poll_result",
      videoId: checkpoint.providerJob.videoId,
      pollNumber: 0,
      status,
      progress: checkpointProgress(checkpoint),
      elapsedMs: 0,
      ...(status === "completed" ? { downloadReady: Boolean(checkpoint.url) } : {}),
    };
  }
  if (checkpoint.status === "failed" || checkpoint.status === "unknown") {
    return {
      event: "video_generation_failed",
      reason: checkpoint.error ?? "Video generation did not complete.",
      retrySafe: checkpoint.retrySafe === true,
      source: "snapshot",
    };
  }
  return null;
}

export async function musicSnapshotEvent(
  checkpoint: ArtifactCheckpoint | null | undefined,
): Promise<VideoAgentEvent | null> {
  if (!checkpoint) return null;
  if (await completedFreeAiMusicArtifactIsValid(checkpoint)) {
    return {
      event: "music_downloaded",
      path: checkpoint.path as string,
      model: FREE_AI_MUSIC_MODEL,
      source: "local_reuse",
    };
  }
  if (optionalMusicWasOmitted(checkpoint)) {
    return {
      event: "music_omitted",
      reason: checkpoint.error ?? "Background music was unavailable after its bounded attempt cycle.",
      source: "snapshot",
      foleyOnly: true,
    };
  }
  if (checkpoint.status === "failed" || checkpoint.status === "unknown") {
    return {
      event: "music_generation_failed",
      reason: checkpoint.error ?? "Music generation did not complete.",
      retrySafe: checkpoint.retrySafe === true,
      source: "snapshot",
    };
  }
  return null;
}

interface CurrentSourceAudioBinding {
  video: ArtifactCheckpoint;
  analysis: ArtifactCheckpoint;
  document: SourceAudioInspectionDocument;
}

async function resolveCurrentSourceAudioBinding(
  stateStore: VideoRunStateStore,
  originalPrompt: string,
  plan: VideoPlan,
): Promise<CurrentSourceAudioBinding | null> {
  const [video, analysis] = await Promise.all([
    stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.sourceVideo),
    stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.sourceAudioAnalysis),
  ]);
  if (
    !video?.sha256
    || !analysis?.path
    || !analysis.sha256
    || !await completedArtifactIsValid(video)
    || !await completedArtifactIsValid(analysis)
    || analysis.provider !== "local"
    || analysis.model !== SOURCE_AUDIO_ANALYSIS_MODEL
    || analysis.details?.inspectionRevision !== SOURCE_AUDIO_INSPECTION_REVISION
    || analysis.details?.sourceVideoSha256 !== video.sha256
  ) return null;

  const document = await loadReusableSourceAudioInspection({
    filePath: analysis.path,
    expectedFileSha256: analysis.sha256,
    sourceVideoSha256: video.sha256,
    durationSeconds: plan.totalDurationSeconds,
  });
  return document ? { video, analysis, document } : null;
}

interface CurrentNativeAudioBinding extends CurrentSourceAudioBinding {
  mode: "agnes_native";
  selection: ArtifactCheckpoint;
  dependencies: Extract<ForegroundArtifactDependencies, { foregroundAudioMode: "agnes_native" }>;
}

interface CurrentFoleyBinding extends CurrentSourceAudioBinding {
  mode: "elevenlabs_foley";
  foleyAnalysis: ArtifactCheckpoint;
  foley: ArtifactCheckpoint;
  dependencies: Extract<ForegroundArtifactDependencies, { foregroundAudioMode: "elevenlabs_foley" }>;
}

type CurrentForegroundAudioBinding = CurrentNativeAudioBinding | CurrentFoleyBinding;

export async function resolveCurrentForegroundAudioBinding(
  stateStore: VideoRunStateStore,
  originalPrompt: string,
  plan: VideoPlan,
): Promise<CurrentForegroundAudioBinding | null> {
  const source = await resolveCurrentSourceAudioBinding(stateStore, originalPrompt, plan);
  if (!source?.analysis.sha256 || !source.video.sha256) return null;
  const selection = await stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.foley);
  if (source.document.usable) {
    const expected = {
      sourceVideoSha256: source.video.sha256,
      sourceAudioAnalysisSha256: source.analysis.sha256,
    };
    if (!nativeSourceAudioSelectionIsCurrent(selection, expected)) return null;
    return {
      ...source,
      mode: "agnes_native",
      selection: selection as ArtifactCheckpoint,
      dependencies: {
        foregroundAudioMode: "agnes_native",
        ...expected,
        foleySha256: null,
        reconciliationSha256: null,
      },
    };
  }

  const foleyAnalysis = await stateStore.loadCheckpoint(
    originalPrompt,
    videoCheckpointKeys.foleyAnalysis,
  );
  if (
    !foleyAnalysis?.path
    || !foleyAnalysis.sha256
    || !selection?.sha256
    || !await completedArtifactIsValid(foleyAnalysis)
    || foleyAnalysis.provider !== "vision-orchestrator+ffmpeg"
    || foleyAnalysis.model !== FOLEY_RECONCILIATION_MODEL
    || foleyAnalysis.details?.reconciliationRevision !== FOLEY_RECONCILIATION_REVISION
    || foleyAnalysis.details?.sourceVideoSha256 !== source.video.sha256
    || foleyAnalysis.details?.plannedCueDigest !== plannedFoleyCueDigest(plan)
  ) return null;

  const document = await loadReusableFoleyReconciliation({
    filePath: foleyAnalysis.path,
    expectedFileSha256: foleyAnalysis.sha256,
    sourceVideoSha256: source.video.sha256,
    plannedCueDigest: plannedFoleyCueDigest(plan),
  });
  if (!document) return null;
  const dependencies: CurrentFoleyBinding["dependencies"] = {
    foregroundAudioMode: "elevenlabs_foley",
    sourceVideoSha256: source.video.sha256,
    sourceAudioAnalysisSha256: source.analysis.sha256,
    reconciliationSha256: foleyAnalysis.sha256,
    foleySha256: selection.sha256,
  };
  if (!await completedFoleyArtifactIsValid(selection, dependencies)) return null;
  return {
    ...source,
    mode: "elevenlabs_foley",
    foleyAnalysis,
    foley: selection,
    dependencies,
  };
}

async function resolveCurrentFinalDependencies(
  stateStore: VideoRunStateStore,
  originalPrompt: string,
  plan: VideoPlan,
): Promise<FinalArtifactDependencies | null> {
  const foregroundBinding = await resolveCurrentForegroundAudioBinding(
    stateStore,
    originalPrompt,
    plan,
  );
  if (!foregroundBinding) return null;
  if (!planUsesBackgroundMusic(plan)) {
    return {
      ...foregroundBinding.dependencies,
      musicDependencyStatus: "disabled",
      musicSha256: null,
    };
  }
  const music = await stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.music);
  if (music?.sha256 && await completedFreeAiMusicArtifactIsValid(music)) {
    return {
      ...foregroundBinding.dependencies,
      musicDependencyStatus: "included",
      musicSha256: music.sha256,
    };
  }
  if (optionalMusicWasOmitted(music)) {
    return {
      ...foregroundBinding.dependencies,
      musicDependencyStatus: "skipped",
      musicSha256: null,
    };
  }
  return null;
}

export async function validateCompletedFinalVideoCheckpoint(
  checkpoint: ArtifactCheckpoint,
  config: AppConfig,
  plan: VideoPlan | null,
  originalPrompt: string,
  expectedDependencies?: FinalArtifactDependencies,
): Promise<boolean> {
  if (!plan || !await completedArtifactIsValid(checkpoint) || !checkpoint.path) return false;
  const resolved = resolveGenerationConfiguration(plan, originalPrompt, config);
  if (!finalAudioMixRevisionIsCurrent(checkpoint, config)) return false;
  if (expectedDependencies && !finalArtifactDependenciesMatch(checkpoint, expectedDependencies)) return false;
  try {
    await validateExistingVideo({
      outputPath: checkpoint.path,
      width: resolved.video.width,
      height: resolved.video.height,
      fps: resolved.video.fps,
      expectedDurationSeconds: plan.totalDurationSeconds,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a final against the exact retained source/analysis/Foley/music inputs.
 * After explicit cleanup, all intermediate receipts are absent by design, so the
 * complete dependency receipt embedded in the final checkpoint remains authoritative.
 */
export async function validateCompletedFinalVideoForState(
  checkpoint: ArtifactCheckpoint,
  stateStore: VideoRunStateStore,
  config: AppConfig,
  plan: VideoPlan | null,
  originalPrompt: string,
): Promise<boolean> {
  if (!plan) return false;
  const dependencies = await resolveCurrentFinalDependencies(stateStore, originalPrompt, plan);
  if (dependencies) {
    return await validateCompletedFinalVideoCheckpoint(
      checkpoint,
      config,
      plan,
      originalPrompt,
      dependencies,
    );
  }

  const [video, sourceAudioAnalysis, foleyAnalysis, foley, music] = await Promise.all([
    stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.sourceVideo),
    stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.sourceAudioAnalysis),
    stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.foleyAnalysis),
    stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.foley),
    stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.music),
  ]);
  const explicitlyCompacted = !video && !sourceAudioAnalysis && !foleyAnalysis && !foley && !music;
  return explicitlyCompacted
    && await validateCompletedFinalVideoCheckpoint(checkpoint, config, plan, originalPrompt);
}

async function completedFinalVideo(
  stateStore: VideoRunStateStore,
  originalPrompt: string,
  config: AppConfig,
): Promise<ArtifactCheckpoint | null> {
  const checkpoint = await stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.assembly);
  const plan = await stateStore.loadPlan(originalPrompt);
  return checkpoint && await validateCompletedFinalVideoForState(
    checkpoint,
    stateStore,
    config,
    plan,
    originalPrompt,
  )
    ? checkpoint
    : null;
}

export async function removeIntermediateMedia(runDirectory: string): Promise<void> {
  const resolvedRunDirectory = path.resolve(runDirectory);
  for (const child of ["video", "audio", "analysis"] as const) {
    const target = path.resolve(resolvedRunDirectory, child);
    if (path.dirname(target) !== resolvedRunDirectory) {
      throw new Error(`Refusing to remove media outside the run directory: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
}

function validateRetainedFinalNamespace(
  runDirectory: string,
  retainedFinalPath: string,
  originalPrompt?: string,
): { resolvedRunDirectory: string; retained: string } {
  const resolvedRunDirectory = path.resolve(runDirectory);
  const retained = path.resolve(retainedFinalPath);
  const retainedName = path.basename(retained);
  if (
    path.dirname(retained) !== resolvedRunDirectory
    || (
      !isLegacyFinalVideoFileName(retainedName)
      && !(originalPrompt && isPromptFinalVideoFileName(retainedName, originalPrompt))
    )
  ) throw new Error(`Retained final video is outside the run artifact namespace: ${retained}`);
  return { resolvedRunDirectory, retained };
}

export async function removeSupersededFinalArtifacts(
  runDirectory: string,
  retainedFinalPath: string,
  originalPrompt?: string,
): Promise<void> {
  const { resolvedRunDirectory, retained } = validateRetainedFinalNamespace(
    runDirectory,
    retainedFinalPath,
    originalPrompt,
  );
  for (const name of await readdir(resolvedRunDirectory)) {
    const managedArtifact = isLegacyFinalVideoFileName(name)
      || Boolean(originalPrompt && (
        isPromptFinalVideoFileName(name, originalPrompt)
        || isPromptFinalVideoPartialFileName(name, originalPrompt)
      ));
    if (!managedArtifact) continue;
    const target = path.join(resolvedRunDirectory, name);
    if (target !== retained) await rm(target, { force: true });
  }
}

export interface CleanupValidatedRunArtifactsResult {
  requested: boolean;
  performed: boolean;
  retention: "retained" | "removed" | "partial_or_unknown";
  reason: string;
  warning?: string;
}

export async function cleanupValidatedRunArtifacts(options: {
  requested: boolean;
  runDirectory: string;
  retainedFinalPath: string;
  originalPrompt?: string;
  compactReceipts: () => Promise<void>;
}): Promise<CleanupValidatedRunArtifactsResult> {
  if (!options.requested) {
    return {
      requested: false,
      performed: false,
      retention: "retained",
      reason: "Artifacts retained because the prompt did not explicitly authorize cleanup.",
    };
  }
  try {
    validateRetainedFinalNamespace(
      options.runDirectory,
      options.retainedFinalPath,
      options.originalPrompt,
    );
    await options.compactReceipts();
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    return {
      requested: true,
      performed: false,
      retention: "retained",
      reason: `Prompt-authorized cleanup did not start: ${warning}`,
      warning,
    };
  }
  try {
    await removeIntermediateMedia(options.runDirectory);
    await removeSupersededFinalArtifacts(
      options.runDirectory,
      options.retainedFinalPath,
      options.originalPrompt,
    );
    return {
      requested: true,
      performed: true,
      retention: "removed",
      reason: "Explicit prompt-authorized cleanup completed after validated assembly.",
    };
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    return {
      requested: true,
      performed: false,
      retention: "partial_or_unknown",
      reason: `Prompt-authorized cleanup started but did not complete: ${warning}`,
      warning,
    };
  }
}

export interface RecoveredLocalAssembly {
  checkpoint: ArtifactCheckpoint;
  source: "prompt_output" | "staging_output" | "legacy_output";
}

/**
 * Recover only an exact active local assembly attempt. A candidate must match
 * the current dependency receipt and pass the same FFprobe contract as a fresh
 * render; an arbitrary uncheckpointed MP4 is never considered.
 */
export async function recoverInterruptedLocalAssembly(options: {
  stateStore: VideoRunStateStore;
  originalPrompt: string;
  runDirectory: string;
  checkpoint: ArtifactCheckpoint | null | undefined;
  config: AppConfig;
  plan: VideoPlan;
  expectedDependencies: FinalArtifactDependencies;
  validateVideoArtifact?: (input: ExistingVideoValidationInput) => Promise<VideoAssemblyResult>;
}): Promise<RecoveredLocalAssembly | null> {
  const { checkpoint } = options;
  if (!checkpoint || !["in_progress", "unknown"].includes(checkpoint.status)) return null;
  if (checkpoint.provider && checkpoint.provider !== "local") {
    throw new Error(
      `Refusing to recover interrupted assembly owned by unexpected provider ${checkpoint.provider}.`,
    );
  }
  if (
    !finalAudioMixRevisionIsCurrent(checkpoint, options.config)
    || !finalArtifactDependenciesMatch(checkpoint, options.expectedDependencies)
  ) return null;

  const resolved = resolveGenerationConfiguration(options.plan, options.originalPrompt, options.config);
  const { outputPath, partialPath } = finalVideoArtifactPaths(
    options.runDirectory,
    options.originalPrompt,
    checkpoint.attempt,
  );
  const legacyOutputPath = path.join(options.runDirectory, `final-${checkpoint.attempt}.mp4`);
  const candidates = [
    { path: outputPath, source: "prompt_output" as const },
    { path: partialPath, source: "staging_output" as const },
    { path: legacyOutputPath, source: "legacy_output" as const },
  ];
  const validateVideoArtifact = options.validateVideoArtifact
    ?? (async (input: ExistingVideoValidationInput) => await validateExistingVideo(input));

  for (const candidate of candidates) {
    if (!await nonEmptyLocalFile(candidate.path)) continue;
    let result: VideoAssemblyResult;
    try {
      result = await validateVideoArtifact({
        outputPath: candidate.path,
        width: resolved.video.width,
        height: resolved.video.height,
        fps: resolved.video.fps,
        expectedDurationSeconds: options.plan.totalDurationSeconds,
      });
    } catch {
      continue;
    }

    let publishedPath = candidate.path;
    if (candidate.source === "staging_output") {
      // An earlier exact-attempt prompt output was already probed and rejected.
      // Remove only that managed target before atomically publishing the valid stage.
      await rm(outputPath, { force: true });
      await rename(partialPath, outputPath);
      publishedPath = outputPath;
    }
    const completed = await options.stateStore.completeCheckpoint(
      options.originalPrompt,
      videoCheckpointKeys.assembly,
      {
        path: publishedPath,
        sha256: await sha256File(publishedPath),
        durationSeconds: result.durationSeconds,
        provider: "local",
        model: "ffmpeg-static",
        details: {
          ...(checkpoint.details ?? {}),
          ...result,
          outputPath: publishedPath,
          recoveredFromInterruptedAssembly: true,
          recoverySource: candidate.source,
        },
      },
    );
    await options.stateStore.updateStatus(options.originalPrompt, "completed");
    return { checkpoint: completed, source: candidate.source };
  }
  return null;
}

/** Reset only an interrupted local FFmpeg attempt; provider media is untouched. */
export async function resetInterruptedLocalAssembly(options: {
  stateStore: VideoRunStateStore;
  originalPrompt: string;
  runDirectory: string;
  checkpoint: ArtifactCheckpoint | null | undefined;
}): Promise<ArtifactCheckpoint | null> {
  const { checkpoint } = options;
  if (!checkpoint || !["in_progress", "unknown"].includes(checkpoint.status)) {
    return checkpoint ?? null;
  }
  if (checkpoint.provider && checkpoint.provider !== "local") {
    throw new Error(
      `Refusing to reset interrupted assembly owned by unexpected provider ${checkpoint.provider}.`,
    );
  }
  const { outputPath, partialPath } = finalVideoArtifactPaths(
    options.runDirectory,
    options.originalPrompt,
    checkpoint.attempt,
  );
  const legacyOutputPath = path.join(options.runDirectory, `final-${checkpoint.attempt}.mp4`);
  await Promise.all([
    rm(outputPath, { force: true }),
    rm(partialPath, { force: true }),
    rm(legacyOutputPath, { force: true }),
  ]);
  return await options.stateStore.resetCheckpointForRetry(
    options.originalPrompt,
    videoCheckpointKeys.assembly,
    "Resetting an interrupted local FFmpeg assembly; provider media checkpoints remain unchanged.",
    {
      interruptedLocalAssemblyRecovered: true,
      removedPartialOutput: path.basename(partialPath),
      removedPartialOutputs: [
        path.basename(outputPath),
        path.basename(partialPath),
        path.basename(legacyOutputPath),
      ],
    },
    "ffmpeg-static",
  );
}

/** Reset an interrupted Foley mix while preserving hashed per-cue downloads. */
export async function resetInterruptedFoleyAggregation(options: {
  stateStore: VideoRunStateStore;
  originalPrompt: string;
  runDirectory: string;
  checkpoint: ArtifactCheckpoint | null | undefined;
}): Promise<ArtifactCheckpoint | null> {
  const { checkpoint } = options;
  if (!checkpoint || !["in_progress", "unknown"].includes(checkpoint.status)) {
    return checkpoint ?? null;
  }
  if (checkpoint.provider && checkpoint.provider !== "elevenlabs+local") {
    throw new Error(
      `Refusing to reset interrupted Foley aggregation owned by unexpected provider ${checkpoint.provider}.`,
    );
  }
  await rm(path.join(options.runDirectory, "audio", "foley-mix.wav"), { force: true });
  return await options.stateStore.resetCheckpointForRetry(
    options.originalPrompt,
    videoCheckpointKeys.foley,
    checkpoint.status === "unknown"
      ? "Retrying an ElevenLabs cue whose synchronous response was lost; completed hashed cue assets will be reused."
      : "Resetting an interrupted Foley aggregation; completed cue assets will be reused.",
    checkpoint.status === "unknown"
      ? { ambiguousFoleyResponseRetriedOnLaterInvocation: true }
      : { interruptedFoleyAggregationRecovered: true },
    "eleven_text_to_sound_v2+ffmpeg",
  );
}

/**
 * Exact revision-1 prompt retained solely so already accepted Agnes receipts
 * can still be verified and resumed after the native-sound prompt upgrade.
 */
export function legacyAgnesVideoPrompt(plan: VideoPlan): string {
  const bible = plan.continuityBible;
  const subjects = bible.subjects.map((subject) =>
    `${subject.id} (${subject.role}): ${subject.invariantAppearance}; `
      + `surface/wardrobe ${subject.wardrobeOrSurface}; identity anchors ${subject.identityAnchors.join(", ")}`,
  );
  return [
    `Create one continuous ${plan.totalDurationSeconds}-second ${plan.delivery.visualStyle} video, ${plan.delivery.aspectRatio}.`,
    `Creative script: ${plan.creativeScript}`,
    `Provider-ready visual direction: ${plan.visualPrompt}`,
    `Continuity bible ${bible.id}: ${bible.visualStyle}`,
    ...subjects,
    `Location: ${bible.environment.location}. Background anchors: ${bible.environment.backgroundAnchors.join("; ")}.`,
    `Time and atmosphere: ${bible.environment.timeOfDay}; ${bible.environment.weatherOrAtmosphere}.`,
    `Lighting: ${bible.lighting}. Palette: ${bible.colorPalette.join(", ")}.`,
    `Camera motion: ${plan.cameraMotion}. Camera direction: ${plan.cameraDirection}. ${bible.cameraLanguage}`,
    "Follow these broad continuous action windows. In each window, show anticipation, one clear dominant peak, and enough aftermath to read the result; timing is best-effort rather than frame-exact:",
    ...plan.timelineBeats.map((beat) =>
      `${beat.startSeconds.toFixed(2)}-${beat.endSeconds.toFixed(2)}s [${beat.beatId}]: `
        + `${beat.visualAction} Camera: ${beat.cameraDirection}. Composition: ${beat.composition}`,
    ),
    "The bracketed cue times already embedded in those beat directions mark intended visual peaks. Do not add extra actions or repeat the cue list; prioritize simple, sequential, physically readable choreography.",
    `Supporting anchors: ${bible.supportingAnchors.join("; ")}.`,
    `Avoid: ${[plan.negativePrompt, ...bible.negativeConstraints].join("; ")}.`,
    "No cuts to unrelated scenes, no montage, no captions, and no visible text unless explicitly required by the concept.",
  ].join("\n");
}

function agnesNativeSoundDirections(plan: VideoPlan): string[] {
  if (plan.foleyCues.length === 0) {
    return [
      "Native sound plan: no diegetic sound events are requested; keep the soundtrack silent.",
    ];
  }
  return [
    "Generate synchronized natural diegetic production audio with the video.",
    "Native sound plan (timestamps are approximate peaks inside the broad visual windows):",
    ...plan.foleyCues.map((cue) => cue.continuous
      ? `- From ${cue.atSeconds.toFixed(2)}s for ${cue.durationSeconds.toFixed(2)}s: ${cue.sound}. Visible source: ${cue.visualAction}.`
      : `- Near ${cue.atSeconds.toFixed(2)}s: ${cue.sound}, synchronized with this visible cause: ${cue.visualAction}.`),
    "Generate only those visible-source action sounds and restrained natural ambience. Do not generate background music, score, songs, lyrics, narration, dialogue not requested by the user, or unrelated off-screen effects.",
  ];
}

export function agnesVideoPrompt(plan: VideoPlan): string {
  return [
    legacyAgnesVideoPrompt(plan),
    ...agnesNativeSoundDirections(plan),
  ].join("\n");
}

/** Compatibility name retained for callers; the plan now has one continuous render. */
export const continuityPrompt = agnesVideoPrompt;

export function freeAiMusicDurationSeconds(plan: VideoPlan): number {
  return Math.max(10, plan.totalDurationSeconds);
}

export function musicPrompt(plan: VideoPlan): string {
  const music = enabledMusicForPlan(plan);
  if (!music) throw new Error("The locked plan explicitly disables background music.");
  const providerDuration = freeAiMusicDurationSeconds(plan);
  return [
    `Compose ${providerDuration} seconds of sparse instrumental background music with absolutely no vocals or lyrics.`,
    providerDuration === plan.totalDurationSeconds
      ? `Resolve the musical arc cleanly by ${plan.totalDurationSeconds.toFixed(2)} seconds.`
      : `The final edit uses only the first ${plan.totalDurationSeconds.toFixed(2)} seconds; complete the story-facing musical arc by then, and keep any remaining provider tail subdued because it will be trimmed locally.`,
    `Narrative concept to score: ${plan.concept}`,
    `Complete story arc to score emotionally: ${plan.creativeScript}`,
    "Translate that story's subject, action, stakes, atmosphere, and payoff into the harmony, instrumentation, dynamics, and phrase arc. Follow the selected genre and mood below; do not substitute generic stock ambience.",
    "Use the narrative only as emotional scoring context. Do not imitate its literal voices, impacts, vehicles, weather, creatures, or environmental sounds in the music.",
    "Keep it deliberately quiet, low-density, and behind the foreground Foley; no speech, lyrics, creature sounds, engines, weather, impacts, or environmental sound effects.",
    `Treat ${music.tempoBpm} BPM as the perceived primary pulse. Never render it in double-time or imply a faster tempo with rapid subdivisions.`,
    music.tempoBpm <= 80
      ? "Use long sustained phrases with very few note attacks. No busy percussion, rapid arpeggios, ostinatos, rhythmic fills, or fast repeated notes."
      : "Keep rhythmic density restrained. No faster implied pulse, rapid fills, dense ostinatos, or busy percussion.",
    "The timeline windows below describe broad musical texture and phrase shape, not action-by-action hits. Foley owns every transient; do not accent individual Foley timestamps.",
    music.prompt,
    `Genre: ${music.genre}. Mood: ${music.mood}. Tempo: ${music.tempoBpm} BPM.`,
    music.featuredInstrument
      ? `Feature ${music.featuredInstrument}, but leave spectral and dynamic space for the effects.`
      : "Choose a restrained lead instrument appropriate to the concept.",
    `Sync strategy: ${music.syncStrategy}`,
    ...music.beats.map((beat) =>
      `${beat.startSeconds.toFixed(2)}-${beat.endSeconds.toFixed(2)}s [${beat.beatId}]: ${beat.direction}`,
    ),
    `Final rhythm constraint: the audible pulse must remain ${music.tempoBpm} BPM, never double-time. Keep transitions textural and do not add musical hits at Foley events.`,
    `Avoid: ${music.negativePrompt}. The edit-facing phrase must resolve by ${plan.totalDurationSeconds.toFixed(2)} seconds.`,
  ].join("\n");
}

function timedCueRequestHash(cue: TimedFoleyCue, timelineDurationSeconds: number): string {
  const request = resolveFoleySoundEffectRequest(cue, timelineDurationSeconds);
  return createHash("sha256").update(JSON.stringify({
    model: "eleven_text_to_sound_v2",
    ...request,
  })).digest("hex").slice(0, 16);
}

export function timedCueMixVolume(cue: TimedFoleyCue): number {
  return FOLEY_PROMINENCE_GAIN[cue.prominence] * FOLEY_INTENSITY_GAIN[cue.intensity];
}

async function nonEmptyLocalFile(filePath: string): Promise<boolean> {
  try {
    const information = await stat(filePath);
    return information.isFile() && information.size > 0;
  } catch {
    return false;
  }
}

function requestDigest(plan: VideoPlan): string {
  return createHash("sha256").update(JSON.stringify({
    model: AGNES_VIDEO_MODEL,
    prompt: agnesVideoPrompt(plan),
    seconds: String(plan.totalDurationSeconds),
    mode: "text",
    size: "720P",
    aspect_ratio: plan.delivery.aspectRatio,
    n: 1,
  })).digest("hex");
}

function legacyRequestDigest(plan: VideoPlan): string {
  return createHash("sha256").update(JSON.stringify({
    model: AGNES_VIDEO_MODEL,
    prompt: legacyAgnesVideoPrompt(plan),
    seconds: String(plan.totalDurationSeconds),
    mode: "text",
    size: "720P",
    aspect_ratio: plan.delivery.aspectRatio,
    n: 1,
  })).digest("hex");
}

function providerJobFromTask(task: AgnesVideoTask, digest: string): PersistedProviderJob {
  return {
    schemaVersion: 2,
    provider: "agnes",
    id: task.id,
    videoId: task.video_id,
    taskId: task.task_id,
    keyFingerprint: task.keyFingerprint,
    keyLabel: task.keyLabel,
    model: AGNES_VIDEO_MODEL,
    requestDigest: digest,
  };
}

function taskFromCheckpoint(checkpoint: ArtifactCheckpoint): AgnesVideoTask {
  const job = checkpoint.providerJob;
  if (!job) throw new Error("The Agnes checkpoint has no accepted task receipt.");
  const providerStatus = checkpoint.providerStatus;
  const status: AgnesTaskStatus = providerStatus === "completed" || providerStatus === "failed"
    || providerStatus === "in_progress" || providerStatus === "queued"
    ? providerStatus
    : checkpoint.status === "queued"
      ? "queued"
      : "in_progress";
  return {
    id: job.id,
    task_id: job.taskId,
    video_id: job.videoId,
    model: AGNES_VIDEO_MODEL,
    status,
    progress: checkpointProgress(checkpoint),
    keyLabel: job.keyLabel,
    keyFingerprint: job.keyFingerprint,
    ...(checkpoint.url ? { metadata: { url: checkpoint.url } } : {}),
    ...(checkpoint.error ? { error: checkpoint.error } : {}),
  };
}

function taskError(task: AgnesVideoTask): string {
  if (typeof task.error === "string" && task.error.trim()) return task.error.trim();
  if (task.error !== undefined) {
    try {
      return JSON.stringify(task.error);
    } catch {
      // fall through
    }
  }
  return "Agnes reported that the accepted video task failed.";
}

function retryAt(now: Date, milliseconds = 60_000): string {
  return new Date(now.getTime() + milliseconds).toISOString();
}

async function requirePlan(
  stateStore: VideoRunStateStore,
  originalPrompt: string,
): Promise<VideoPlan> {
  const plan = await stateStore.loadPlan(originalPrompt);
  if (!plan) throw new Error(`Call ${VIDEO_TOOL_NAMES.validatePlan} before generating media.`);
  return plan;
}

function safeCheckpointSummary(checkpoint: ArtifactCheckpoint): Record<string, unknown> {
  return {
    status: checkpoint.status,
    attempt: checkpoint.attempt,
    ...(checkpoint.path ? { path: checkpoint.path } : {}),
    ...(checkpoint.externalId ? { externalId: checkpoint.externalId } : {}),
    ...(checkpoint.sha256 ? { sha256: checkpoint.sha256 } : {}),
    ...(checkpoint.durationSeconds ? { durationSeconds: checkpoint.durationSeconds } : {}),
    ...(checkpoint.provider ? { provider: checkpoint.provider } : {}),
    ...(checkpoint.model ? { model: checkpoint.model } : {}),
    ...(checkpoint.providerStatus ? { providerStatus: checkpoint.providerStatus } : {}),
    ...(checkpoint.providerJob ? {
      providerTask: {
        videoId: checkpoint.providerJob.videoId,
        taskId: checkpoint.providerJob.taskId,
        keyLabel: checkpoint.providerJob.keyLabel,
      },
      progress: checkpointProgress(checkpoint),
    } : {}),
    ...(checkpoint.retryAt ? { retryAt: checkpoint.retryAt } : {}),
    ...(checkpoint.retrySafe !== undefined ? { retrySafe: checkpoint.retrySafe } : {}),
    ...(checkpoint.error ? { error: checkpoint.error } : {}),
    ...(typeof checkpoint.details?.usable === "boolean"
      ? { usableSourceAudio: checkpoint.details.usable }
      : {}),
    ...(checkpoint.details?.foregroundAudioMode === "agnes_native"
      || checkpoint.details?.foregroundAudioMode === "elevenlabs_foley"
      ? { foregroundAudioMode: checkpoint.details.foregroundAudioMode }
      : {}),
    updatedAt: checkpoint.updatedAt,
  };
}

async function elevenLabsFailure(
  stateStore: VideoRunStateStore,
  originalPrompt: string,
  key: VideoCheckpointKey,
  error: unknown,
  now: Date,
): Promise<{ response: string; pending?: string; failure?: string }> {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ElevenLabsError) || error.ambiguousOutcome
    || ["network", "download", "provider"].includes(error.kind)) {
    await stateStore.markUnknown(originalPrompt, key, message);
    return {
      response: json({
        status: "unknown",
        reason: message,
        retrySafe: false,
        instruction: "The synchronous provider outcome is ambiguous; automatic resubmission is blocked.",
      }),
      failure: message,
    };
  }
  if (error.kind === "rate_limit") {
    const next = retryAt(now, error.retryAfterMs ?? 60_000);
    await stateStore.deferCheckpoint(originalPrompt, key, message, next);
    return {
      response: json({ status: "pending", reason: message, retryAt: next }),
      pending: message,
    };
  }
  await stateStore.failCheckpoint(originalPrompt, key, message, true);
  return {
    response: json({
      status: "failed",
      reason: message,
      retrySafe: true,
      retryOn: "next_invocation",
      instruction: error.kind === "insufficient_credits"
        ? "All configured ElevenLabs keys were exhausted; add credits or another numbered key."
        : "Correct the ElevenLabs credentials, subscription, or locked request before resuming this run.",
    }),
    failure: message,
  };
}

export function createVideoAgentTools(options: CreateVideoAgentToolsOptions): VideoToolBundle {
  const { originalPrompt, runDirectory, config, stateStore, agnes, elevenLabs, freeAiMusic } = options;
  const now = options.now ?? (() => new Date());
  const validateMusicArtifact = options.validateMusicArtifact ?? validateExistingAudio;
  const inspectSourceAudioArtifact = options.inspectSourceAudioArtifact ?? inspectSourceAudio;
  const foleyVision = options.foleyVision ?? createFoleyVisionClientFromEnv();
  const preferences = resolvePromptPreferencesForConfig(originalPrompt, config);
  const runId = stateStore.runId(originalPrompt);
  const resumeCommand = `npm run dev -- --resume ${runId}`;
  const attempted = new Set<VideoCheckpointKey>();
  let invocationPending: string | null = null;
  let invocationFailure: string | null = null;

  const emitSourceAudioSummary = (
    document: SourceAudioInspectionDocument,
    filePath: string,
    source: "generated" | "local_reuse",
  ): void => {
    emitEvent(options.onEvent, {
      event: "source_audio_inspection_completed",
      path: filePath,
      source,
      usable: document.usable,
      reason: document.reason,
      hasAudioStream: document.audioStream !== null,
      activeDurationSeconds: document.activeDurationSeconds,
      peakVolumeDbfs: document.peakVolumeDbfs,
      meanVolumeDbfs: document.meanVolumeDbfs,
    });
  };

  const ensureSourceAudioInspection = async (
    plan: VideoPlan,
    video: ArtifactCheckpoint,
  ): Promise<{ document: SourceAudioInspectionDocument; sha256: string }> => {
    if (!video.path || !video.sha256) {
      throw new Error("Completed source video is missing its local path or checksum.");
    }
    const key = videoCheckpointKeys.sourceAudioAnalysis;
    const outputPath = path.join(runDirectory, "analysis", "source-audio.json");
    let checkpoint = await stateStore.loadCheckpoint(originalPrompt, key);
    if (
      checkpoint?.status === "completed"
      && checkpoint.path
      && checkpoint.sha256
      && checkpoint.provider === "local"
      && checkpoint.model === SOURCE_AUDIO_ANALYSIS_MODEL
      && checkpoint.details?.inspectionRevision === SOURCE_AUDIO_INSPECTION_REVISION
      && checkpoint.details?.sourceVideoSha256 === video.sha256
    ) {
      const document = await loadReusableSourceAudioInspection({
        filePath: checkpoint.path,
        expectedFileSha256: checkpoint.sha256,
        sourceVideoSha256: video.sha256,
        durationSeconds: plan.totalDurationSeconds,
      });
      if (document) {
        emitSourceAudioSummary(document, checkpoint.path, "local_reuse");
        return { document, sha256: checkpoint.sha256 };
      }
    }

    if (checkpoint && ["in_progress", "queued", "unknown"].includes(checkpoint.status)) {
      checkpoint = await stateStore.resetCheckpointForRetry(
        originalPrompt,
        key,
        "Resetting interrupted local source-audio inspection.",
        { interruptedInspectionRecovered: true },
        SOURCE_AUDIO_ANALYSIS_MODEL,
      );
    }
    if (attempted.has(key)) {
      throw new Error("Source-audio inspection already ran in this invocation.");
    }
    attempted.add(key);
    await stateStore.startCheckpoint(originalPrompt, key, {
      provider: "local",
      model: SOURCE_AUDIO_ANALYSIS_MODEL,
      details: {
        inspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
        sourceVideoSha256: video.sha256,
        durationSeconds: plan.totalDurationSeconds,
      },
    });
    emitEvent(options.onEvent, {
      event: "source_audio_inspection_started",
      sourceVideoSha256: video.sha256,
      inspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
    });
    try {
      const document = SourceAudioInspectionDocumentSchema.parse(
        await inspectSourceAudioArtifact({
          sourceVideoPath: video.path,
          sourceVideoSha256: video.sha256,
          durationSeconds: plan.totalDurationSeconds,
          outputPath,
        }),
      );
      // The production inspector writes this atomically itself. Rewriting the
      // validated value here also makes injected/test inspectors obey the same
      // durable artifact contract.
      await writeJsonAtomic(outputPath, document);
      const fileSha256 = await sha256File(outputPath);
      const completed = await stateStore.completeCheckpoint(originalPrompt, key, {
        path: outputPath,
        sha256: fileSha256,
        durationSeconds: plan.totalDurationSeconds,
        provider: "local",
        model: SOURCE_AUDIO_ANALYSIS_MODEL,
        details: {
          inspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
          sourceVideoSha256: video.sha256,
          usable: document.usable,
          reason: document.reason,
          hasAudioStream: document.audioStream !== null,
          activeDurationSeconds: document.activeDurationSeconds,
          peakVolumeDbfs: document.peakVolumeDbfs,
          meanVolumeDbfs: document.meanVolumeDbfs,
        },
      });
      emitSourceAudioSummary(document, completed.path as string, "generated");
      return { document, sha256: completed.sha256 as string };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await stateStore.failCheckpoint(originalPrompt, key, message, true);
      emitEvent(options.onEvent, {
        event: "source_audio_inspection_failed",
        reason: message,
        retrySafe: true,
      });
      throw error;
    }
  };

  const emitFoleyVisionSummary = (
    document: FoleyReconciliationDocument,
    filePath: string,
    source: "generated" | "local_reuse",
  ): void => {
    for (const decision of document.decisions) {
      emitEvent(options.onEvent, {
        event: "foley_vision_decision",
        cueId: decision.cueId,
        decision: decision.decision,
        plannedAtSeconds: decision.plannedAtSeconds,
        resolvedAtSeconds: decision.resolvedAtSeconds,
        confidence: decision.confidence,
        matchesPlannedCause: decision.matchesPlannedCause,
        reason: decision.reason,
      });
    }
    emitEvent(options.onEvent, {
      event: "foley_vision_completed",
      path: filePath,
      source,
      retainedCueCount: document.activeCues.length,
      omittedCueCount: document.decisions.filter(({ decision }) => decision === "omit").length,
      retimedCueCount: document.decisions.filter(({ decision }) => decision === "retime").length,
      providers: document.providers,
    });
  };

  const ensureFoleyVisionReconciliation = async (
    plan: VideoPlan,
    video: ArtifactCheckpoint,
  ): Promise<{ document: FoleyReconciliationDocument; sha256: string }> => {
    if (!video.path || !video.sha256) {
      throw new Error("Completed source video is missing its local path or checksum.");
    }
    const key = videoCheckpointKeys.foleyAnalysis;
    const plannedCueDigest = plannedFoleyCueDigest(plan);
    const outputPath = path.join(runDirectory, "analysis", "observed-foley-plan.json");
    let checkpoint = await stateStore.loadCheckpoint(originalPrompt, key);
    if (
      checkpoint?.status === "completed"
      && checkpoint.path
      && checkpoint.sha256
      && checkpoint.details?.reconciliationRevision === FOLEY_RECONCILIATION_REVISION
      && checkpoint.details?.sourceVideoSha256 === video.sha256
      && checkpoint.details?.plannedCueDigest === plannedCueDigest
    ) {
      const document = await loadReusableFoleyReconciliation({
        filePath: checkpoint.path,
        expectedFileSha256: checkpoint.sha256,
        sourceVideoSha256: video.sha256,
        plannedCueDigest,
      });
      if (document) {
        emitFoleyVisionSummary(document, checkpoint.path, "local_reuse");
        return { document, sha256: checkpoint.sha256 };
      }
    }

    if (checkpoint && ["in_progress", "queued", "unknown"].includes(checkpoint.status)) {
      checkpoint = await stateStore.resetCheckpointForRetry(
        originalPrompt,
        key,
        "Resetting interrupted local post-render Foley inspection.",
        { interruptedInspectionRecovered: true },
        FOLEY_RECONCILIATION_MODEL,
      );
    }
    if (attempted.has(key)) {
      throw new Error("Post-render Foley inspection already ran in this invocation.");
    }
    attempted.add(key);
    await stateStore.startCheckpoint(originalPrompt, key, {
      provider: "vision-orchestrator+ffmpeg",
      model: FOLEY_RECONCILIATION_MODEL,
      details: {
        reconciliationRevision: FOLEY_RECONCILIATION_REVISION,
        sourceVideoSha256: video.sha256,
        plannedCueDigest,
        plannedCueCount: plan.foleyCues.length,
      },
    });
    emitEvent(options.onEvent, {
      event: "foley_vision_started",
      cueCount: plan.foleyCues.length,
      sourceVideoSha256: video.sha256,
      reconciliationRevision: FOLEY_RECONCILIATION_REVISION,
    });
    try {
      const document = await reconcileFoleyPlanToRenderedVideo({
        plan,
        sourceVideoPath: video.path,
        sourceVideoSha256: video.sha256,
        analysisDirectory: path.join(runDirectory, "analysis"),
        outputPath,
        vision: foleyVision,
        onEvent: (event) => {
          const phase = event.event.replace(/^foley_vision_/, "") as
            | "coarse_started"
            | "coarse_completed"
            | "fine_started"
            | "fine_completed";
          emitEvent(options.onEvent, {
            event: "foley_vision_pass",
            phase,
            cueCount: event.cueCount,
            ...(event.provider ? { provider: event.provider } : {}),
            ...(event.model ? { model: event.model } : {}),
          });
        },
      });
      const fileSha256 = await sha256File(outputPath);
      const completed = await stateStore.completeCheckpoint(originalPrompt, key, {
        path: outputPath,
        sha256: fileSha256,
        provider: "vision-orchestrator+ffmpeg",
        model: FOLEY_RECONCILIATION_MODEL,
        details: {
          reconciliationRevision: FOLEY_RECONCILIATION_REVISION,
          sourceVideoSha256: video.sha256,
          plannedCueDigest,
          plannedCueCount: plan.foleyCues.length,
          retainedCueCount: document.activeCues.length,
          omittedCueCount: document.decisions.filter(({ decision }) => decision === "omit").length,
          retimedCueCount: document.decisions.filter(({ decision }) => decision === "retime").length,
          providers: document.providers,
          visionModels: document.visionModels,
          ...(document.coarseContactSheet ? {
            coarseContactSheetSha256: document.coarseContactSheet.sha256,
          } : {}),
          ...(document.fineContactSheet ? {
            fineContactSheetSha256: document.fineContactSheet.sha256,
          } : {}),
        },
      });
      emitFoleyVisionSummary(document, completed.path as string, "generated");
      return { document, sha256: completed.sha256 as string };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await stateStore.failCheckpoint(originalPrompt, key, message, true);
      emitEvent(options.onEvent, { event: "foley_vision_failed", reason: message, retrySafe: true });
      throw error;
    }
  };

  const stopped = () => invocationPending
    ? json({ status: "pending", reason: invocationPending, instruction: `End this invocation; resume later with: ${resumeCommand}` })
    : invocationFailure
      ? json({ status: "halted", reason: invocationFailure, instruction: "End this invocation and inspect the durable checkpoint." })
      : null;

  const statusTool = new DynamicStructuredTool({
    name: VIDEO_TOOL_NAMES.status,
    description: "Read secret-safe durable run status. On resume, call this first and reuse every completed artifact and accepted Agnes task.",
    schema: EmptyInputSchema,
    func: async () => {
      const manifest = await stateStore.ensureManifest(originalPrompt);
      const plan = await stateStore.loadPlan(originalPrompt);
      const checkpoints = await stateStore.listCheckpoints(originalPrompt);
      return json({
        runId,
        status: manifest.status,
        planStored: Boolean(plan),
        requestedConfiguration: publicPromptPreferences(preferences),
        ...(plan ? { resolvedConfiguration: resolveGenerationConfiguration(plan, originalPrompt, config) } : {}),
        checkpoints: Object.fromEntries(checkpoints.map(({ key, value }) => [key, safeCheckpointSummary(value)])),
      });
    },
  });

  const validatePlanTool = new DynamicStructuredTool({
    name: VIDEO_TOOL_NAMES.validatePlan,
    description: "Validate and durably lock one creative continuous audiovisual plan before generation. Target 10-12 seconds unless the user explicitly requests a shorter 4-9 second result. Correct a rejected plan and call again.",
    schema: ValidatePlanInputSchema,
    func: async ({ plan }) => {
      const existing = await stateStore.loadPlan(originalPrompt);
      if (existing) {
        const configuration = resolveGenerationConfiguration(existing, originalPrompt, config);
        emitEvent(options.onEvent, { event: "generation_configuration", phase: "plan_reused", configuration: configuration as unknown as Record<string, unknown> });
        return json({
          status: "reused",
          changedPlanRejected: JSON.stringify(existing) !== JSON.stringify(plan),
          plan: existing,
          resolvedConfiguration: configuration,
        });
      }
      let validated: VideoPlan;
      try {
        validated = parseVideoPlanForPrompt(plan, originalPrompt);
        validateNewVideoPlanAudioChoreography(validated);
        assertPlanMatchesPromptPreferences(validated, preferences, config);
      } catch (error) {
        const rejection = recoverableVideoPlanRejection(error, VIDEO_TOOL_NAMES.validatePlan);
        if (rejection) return json({ ...rejection, requestedConfiguration: publicPromptPreferences(preferences) });
        if (error instanceof VideoPlanConfigurationMismatchError) {
          return json({
            status: "rejected",
            valid: false,
            recoverable: true,
            code: "VIDEO_PLAN_CONFIGURATION_MISMATCH",
            message: error.message,
            instruction: `Revise the plan and call ${VIDEO_TOOL_NAMES.validatePlan} again.`,
            requestedConfiguration: publicPromptPreferences(preferences),
          });
        }
        throw error;
      }
      const saved = await stateStore.savePlan(originalPrompt, validated);
      const configuration = resolveGenerationConfiguration(saved, originalPrompt, config);
      emitEvent(options.onEvent, { event: "generation_configuration", phase: "plan_locked", configuration: configuration as unknown as Record<string, unknown> });
      return json({
        status: "stored",
        runId,
        planPath: path.join(runDirectory, "plan.json"),
        totalDurationSeconds: saved.totalDurationSeconds,
        timelineBeatCount: saved.timelineBeats.length,
        resolvedConfiguration: configuration,
      });
    },
  });

  const generateVideoTool = new DynamicStructuredTool({
    name: VIDEO_TOOL_NAMES.generateVideo,
    description: "Submit the single locked video to Agnes once, persist its receipt, then poll every configured interval for at most eight minutes. On resume, poll the same video_id; never resubmit an accepted task.",
    schema: EmptyInputSchema,
    func: async () => {
      const final = await completedFinalVideo(stateStore, originalPrompt, config);
      if (final) return json({ status: "final_reused", path: final.path });
      const key = videoCheckpointKeys.sourceVideo;
      let checkpoint = await stateStore.loadCheckpoint(originalPrompt, key);
      if (checkpoint && await completedArtifactIsValid(checkpoint)) {
        emitEvent(options.onEvent, { event: "video_downloaded", path: checkpoint.path as string, model: AGNES_VIDEO_MODEL, source: "local_reuse" });
        return json({ status: "reused", path: checkpoint.path, sha256: checkpoint.sha256 });
      }
      const stop = stopped();
      if (stop) return stop;
      if (attempted.has(key)) {
        return json({ status: "pending", reason: invocationPending ?? invocationFailure ?? "Video processing already ran in this invocation." });
      }
      attempted.add(key);
      const plan = await requirePlan(stateStore, originalPrompt);
      const currentDigest = requestDigest(plan);
      const priorPromptDigest = legacyRequestDigest(plan);
      let digest = currentDigest;
      let promptRevision: 1 | typeof AGNES_PROMPT_REVISION = AGNES_PROMPT_REVISION;
      let task: AgnesVideoTask;

      if (isLegacyRetryableCapacityCheckpoint(checkpoint)) {
        checkpoint = await stateStore.resetCheckpointForRetry(
          originalPrompt,
          key,
          checkpoint.error ?? "Agnes video capacity was unavailable; retrying on this invocation.",
          { legacyCapacityRejectionRecovered: true },
          AGNES_VIDEO_MODEL,
        );
      }

      if (checkpoint?.providerJob) {
        if (checkpoint.providerJob.requestDigest === priorPromptDigest) {
          // The prompt revision changed only after this task was accepted. Keep
          // polling the exact receipt rather than abandoning or duplicating it.
          digest = priorPromptDigest;
          promptRevision = 1;
        } else if (checkpoint.providerJob.requestDigest !== currentDigest) {
          invocationFailure = "The accepted Agnes task does not match the locked video request.";
          return json({ status: "blocked", reason: invocationFailure, retrySafe: false });
        }
        task = taskFromCheckpoint(checkpoint);
        emitEvent(options.onEvent, {
          event: "video_task_submitted",
          videoId: task.video_id,
          taskId: task.task_id,
          status: task.status,
          progress: task.progress,
          keyLabel: task.keyLabel,
        });
      } else if (checkpoint && ["in_progress", "unknown"].includes(checkpoint.status)) {
        const reason = checkpoint.error
          ?? "A previous Agnes POST may have been accepted, but no video_id was received. Automatic resubmission could create a duplicate.";
        if (checkpoint.status !== "unknown") await stateStore.markUnknown(originalPrompt, key, reason);
        invocationFailure = reason;
        return json({ status: "unknown", reason, retrySafe: false, instruction: "Resolve the ambiguous submission manually before retrying." });
      } else if (checkpoint?.status === "failed" && checkpoint.retrySafe === false) {
        invocationFailure = checkpoint.error ?? "The accepted Agnes task failed terminally.";
        const event = await videoSnapshotEvent(checkpoint);
        if (event) emitEvent(options.onEvent, event);
        return json({ status: "blocked", reason: invocationFailure, retrySafe: false });
      } else if (
        checkpoint?.status === "deferred"
        && checkpoint.retryAt
        && Date.parse(checkpoint.retryAt) > now().getTime()
      ) {
        invocationPending = checkpoint.error ?? "Agnes submission is waiting for its retry time.";
        return json({ status: "pending", reason: invocationPending, retryAt: checkpoint.retryAt });
      } else {
        const startedCheckpoint = await stateStore.startCheckpoint(originalPrompt, key, {
          provider: "agnes",
          model: AGNES_VIDEO_MODEL,
          details: {
            submissionIntent: "prepared",
            requestDigest: digest,
            agnesPromptRevision: promptRevision,
            durationSeconds: plan.totalDurationSeconds,
            aspectRatio: plan.delivery.aspectRatio,
          },
        });
        emitEvent(options.onEvent, {
          event: "video_submission_started",
          model: AGNES_VIDEO_MODEL,
          attemptNumber: startedCheckpoint.attempt,
          resubmission: startedCheckpoint.attempt > 1,
          durationSeconds: plan.totalDurationSeconds,
          aspectRatio: plan.delivery.aspectRatio,
          requestTimeoutMs: config.AGNES_REQUEST_TIMEOUT_MS,
          pollIntervalMs: config.AGNES_POLL_INTERVAL_MS,
          pollWindowMs: config.AGNES_POLL_WINDOW_MS,
          controls: {
            cameraMotion: plan.cameraMotion,
            negativePrompt: plan.negativePrompt,
            negativeBible: plan.continuityBible.negativeConstraints,
          },
        });
        try {
          task = await agnes.submitVideo({
            prompt: agnesVideoPrompt(plan),
            seconds: plan.totalDurationSeconds,
            aspectRatio: plan.delivery.aspectRatio,
            onAttempt: ({ keyLabel }) => emitEvent(options.onEvent, { event: "video_key_attempt", keyLabel }),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof AgnesError && error.rotationExhausted
            && ["insufficient_credits", "quota_exhausted", "daily_limit", "rate_limit"].includes(error.kind)) {
            const next = retryAt(now(), error.retryAfterMs ?? 60_000);
            await stateStore.deferCheckpoint(originalPrompt, key, message, next);
            invocationPending = message;
            return json({ status: "pending", reason: message, retryAt: next, allKeysExhausted: true });
          }
          if (!(error instanceof AgnesError) || error.ambiguousOutcome
            || error.kind === "ambiguous_submission" || error.kind === "network" || error.kind === "provider") {
            await stateStore.markUnknown(originalPrompt, key, message);
            invocationFailure = message;
            return json({
              status: "unknown",
              reason: message,
              retrySafe: false,
              instruction: "The POST outcome is ambiguous; automatic resubmission is blocked to prevent a duplicate render.",
            });
          }
          await stateStore.failCheckpoint(originalPrompt, key, message, true);
          invocationFailure = message;
          emitEvent(options.onEvent, { event: "video_generation_failed", reason: message, retrySafe: true, source: "provider" });
          return json({ status: "failed", reason: message, retrySafe: true, retryOn: "next_invocation" });
        }
        const receipt = providerJobFromTask(task, digest);
        await stateStore.updateProviderJobCheckpoint(originalPrompt, key, {
          providerJob: receipt,
          providerStatus: task.status,
          progress: task.progress,
          ...(task.metadata?.url ? { url: task.metadata.url } : {}),
          ...(task.status === "failed" ? { error: taskError(task) } : {}),
          details: {
            submissionIntent: "accepted",
            agnesPromptRevision: promptRevision,
          },
        });
        emitEvent(options.onEvent, { event: "video_task_submitted", videoId: task.video_id, taskId: task.task_id, status: task.status, progress: task.progress, keyLabel: task.keyLabel });
      }

      const receipt = providerJobFromTask(task, digest);
      // A completed provider checkpoint may predate URL persistence or may
      // have observed a completed response before the output URL appeared.
      // Retrieve it once more instead of repeatedly attempting a download
      // from an incomplete locally reconstructed task.
      if (
        task.status !== "failed"
        && (task.status !== "completed" || !task.metadata?.url)
      ) {
        let polls = 0;
        const pollStartedAt = now().getTime();
        try {
          const polled = await agnes.pollUntilTerminal(task, {
            pollIntervalMs: config.AGNES_POLL_INTERVAL_MS,
            pollWindowMs: config.AGNES_POLL_WINDOW_MS,
            onPoll: async (latest) => {
              polls += 1;
              task = latest;
              await stateStore.updateProviderJobCheckpoint(originalPrompt, key, {
                providerJob: providerJobFromTask(latest, digest),
                providerStatus: latest.status,
                progress: latest.progress,
                ...(latest.metadata?.url ? { url: latest.metadata.url } : {}),
                ...(latest.status === "failed" ? { error: taskError(latest) } : {}),
              });
              emitEvent(options.onEvent, {
                event: "video_poll_result",
                videoId: latest.video_id,
                pollNumber: polls,
                status: latest.status,
                progress: latest.progress,
                elapsedMs: Math.max(0, now().getTime() - pollStartedAt),
                ...(latest.status === "completed"
                  ? { downloadReady: Boolean(latest.metadata?.url) }
                  : {}),
              });
            },
            onPollError: async (error, latest) => {
              polls += 1;
              emitEvent(options.onEvent, {
                event: "video_poll_error",
                videoId: latest.video_id,
                pollNumber: polls,
                reason: error.message,
                elapsedMs: Math.max(0, now().getTime() - pollStartedAt),
              });
            },
          });
          task = polled.task;
          if (polled.outcome === "timed_out") {
            const awaitingOutputUrl = task.status === "completed" && !task.metadata?.url;
            invocationPending = awaitingOutputUrl
              ? `Agnes task ${task.video_id} completed, but its output URL was not available after the eight-minute polling window.`
              : `Agnes task ${task.video_id} is still ${task.status} at ${task.progress}% after the eight-minute polling window.`;
            await stateStore.updateStatus(originalPrompt, "pending");
            emitEvent(options.onEvent, {
              event: "video_poll_window_exhausted",
              videoId: task.video_id,
              status: task.status,
              progress: task.progress,
              pollCount: polls,
              pollWindowMs: config.AGNES_POLL_WINDOW_MS,
              ...(awaitingOutputUrl ? { awaitingOutputUrl: true } : {}),
            });
            return json({
              status: "pending",
              reason: invocationPending,
              videoId: task.video_id,
              providerStatus: task.status,
              progress: task.progress,
              ...(awaitingOutputUrl ? { awaitingOutputUrl: true } : {}),
              instruction: `End this invocation successfully. Continue polling this task with: ${resumeCommand}`,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          invocationPending = `Polling the accepted Agnes task was interrupted: ${message}`;
          await stateStore.updateStatus(originalPrompt, "pending");
          emitEvent(options.onEvent, { event: "video_poll_interrupted", videoId: task.video_id, reason: message });
          return json({
            status: "pending",
            reason: invocationPending,
            videoId: task.video_id,
            instruction: `The accepted task receipt was retained. Poll it again with: ${resumeCommand}`,
          });
        }
      }

      if (task.status === "failed") {
        const message = taskError(task);
        await stateStore.updateProviderJobCheckpoint(originalPrompt, key, {
          providerJob: providerJobFromTask(task, digest),
          providerStatus: "failed",
          progress: task.progress,
          error: message,
        });
        invocationFailure = message;
        emitEvent(options.onEvent, { event: "video_generation_failed", reason: message, retrySafe: false, source: "provider" });
        return json({ status: "failed", reason: message, retrySafe: false, videoId: task.video_id });
      }

      await stateStore.updateProviderJobCheckpoint(originalPrompt, key, {
        providerJob: providerJobFromTask(task, digest),
        providerStatus: "completed",
        progress: task.progress,
        ...(task.metadata?.url ? { url: task.metadata.url } : {}),
      });
      const outputPath = path.join(runDirectory, "video", "source.mp4");
      try {
        const downloaded = await agnes.downloadCompletedVideo(task, outputPath, {
          maxBytes: config.AGNES_MAX_DOWNLOAD_BYTES,
        });
        checkpoint = await stateStore.completeCheckpoint(originalPrompt, key, {
          path: downloaded.outputPath,
          url: downloaded.url,
          externalId: task.video_id,
          sha256: downloaded.sha256,
          durationSeconds: plan.totalDurationSeconds,
          provider: "agnes",
          model: AGNES_VIDEO_MODEL,
          providerJob: providerJobFromTask(task, digest),
          details: {
            progress: task.progress,
            keyLabel: task.keyLabel,
            agnesPromptRevision: promptRevision,
            contentType: downloaded.contentType,
            bytes: downloaded.bytes,
          },
        });
        await stateStore.updateStatus(originalPrompt, "generating");
        emitEvent(options.onEvent, { event: "video_downloaded", path: checkpoint.path as string, model: AGNES_VIDEO_MODEL, source: "provider" });
        return json({ status: "completed", path: checkpoint.path, sha256: checkpoint.sha256, videoId: task.video_id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        invocationPending = `Agnes finished, but its video could not be downloaded: ${message}`;
        await stateStore.updateStatus(originalPrompt, "pending");
        return json({
          status: "pending",
          reason: invocationPending,
          videoId: task.video_id,
          providerStatus: "completed",
          instruction: `Retry only the download from the retained completed task with: ${resumeCommand}`,
        });
      }
    },
  });

  const generateFoleyTool = new DynamicStructuredTool({
    name: VIDEO_TOOL_NAMES.generateFoley,
    description: "Resolve foreground sound after the Agnes download. Preserve usable embedded Agnes audio without vision or ElevenLabs; only for missing/silent source audio, inspect frames and generate the retimed ElevenLabs Foley fallback.",
    schema: EmptyInputSchema,
    func: async () => {
      const final = await completedFinalVideo(stateStore, originalPrompt, config);
      if (final) return json({ status: "final_reused", path: final.path });
      const stop = stopped();
      if (stop) return stop;
      const plan = await requirePlan(stateStore, originalPrompt);
      const video = await stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.sourceVideo);
      if (!await completedArtifactIsValid(video)) return json({ status: "not_ready", missing: ["video"] });
      const key = videoCheckpointKeys.foley;
      let sourceAudio: { document: SourceAudioInspectionDocument; sha256: string };
      try {
        sourceAudio = await ensureSourceAudioInspection(plan, video as ArtifactCheckpoint);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        invocationFailure = `Source-audio inspection failed: ${message}`;
        return json({
          status: "failed",
          reason: invocationFailure,
          retrySafe: true,
          retryOn: "next_invocation",
        });
      }

      if (sourceAudio.document.usable) {
        let selection = await stateStore.loadCheckpoint(originalPrompt, key);
        const nativeDependencies = {
          sourceVideoSha256: video?.sha256 as string,
          sourceAudioAnalysisSha256: sourceAudio.sha256,
        };
        if (nativeSourceAudioSelectionIsCurrent(selection, nativeDependencies)) {
          emitEvent(options.onEvent, {
            event: "foreground_audio_selected",
            mode: "agnes_native",
            source: "local_reuse",
            reason: sourceAudio.document.reason,
          });
          return json({
            status: "reused",
            foregroundAudioMode: "agnes_native",
            sourceAudioAnalysisSha256: sourceAudio.sha256,
          });
        }
        if (selection && ["in_progress", "queued", "unknown"].includes(selection.status)) {
          selection = await stateStore.resetCheckpointForRetry(
            originalPrompt,
            key,
            "Selecting usable Agnes source audio instead of an interrupted Foley fallback.",
            { nativeSourceAudioSelected: true },
            AGNES_NATIVE_AUDIO_MODEL,
          );
        }
        if (attempted.has(key)) {
          return json({ status: "halted", reason: "Foreground audio already ran in this invocation." });
        }
        attempted.add(key);
        await stateStore.startCheckpoint(originalPrompt, key, {
          provider: "agnes",
          model: AGNES_NATIVE_AUDIO_MODEL,
          details: {
            nativeSourceAudioSelected: true,
            foregroundAudioMode: "agnes_native",
            sourceVideoSha256: nativeDependencies.sourceVideoSha256,
            sourceAudioAnalysisSha256: nativeDependencies.sourceAudioAnalysisSha256,
            sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
          },
        });
        await stateStore.skipCheckpoint(
          originalPrompt,
          key,
          "ElevenLabs Foley is not needed because the Agnes source contains usable embedded audio.",
          {
            nativeSourceAudioSelected: true,
            foregroundAudioMode: "agnes_native",
            sourceVideoSha256: nativeDependencies.sourceVideoSha256,
            sourceAudioAnalysisSha256: nativeDependencies.sourceAudioAnalysisSha256,
            sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
          },
        );
        emitEvent(options.onEvent, {
          event: "foreground_audio_selected",
          mode: "agnes_native",
          source: "generated",
          reason: sourceAudio.document.reason,
        });
        return json({
          status: "native_audio_selected",
          foregroundAudioMode: "agnes_native",
          sourceAudioAnalysisSha256: sourceAudio.sha256,
          elevenLabsCalled: false,
          visionCalled: false,
        });
      }

      emitEvent(options.onEvent, {
        event: "foreground_audio_selected",
        mode: "elevenlabs_foley",
        source: "generated",
        reason: sourceAudio.document.reason,
      });
      let reconciliation: { document: FoleyReconciliationDocument; sha256: string };
      try {
        reconciliation = await ensureFoleyVisionReconciliation(plan, video as ArtifactCheckpoint);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        invocationFailure = `Post-render Foley inspection failed: ${message}`;
        return json({
          status: "failed",
          reason: invocationFailure,
          retrySafe: true,
          retryOn: "next_invocation",
        });
      }
      const reconciledCues = reconciliation.document.activeCues;
      const omittedByVision = reconciliation.document.decisions
        .filter(({ decision }) => decision === "omit").length;
      const retimedByVision = reconciliation.document.decisions
        .filter(({ decision }) => decision === "retime").length;
      const outputPath = path.join(runDirectory, "audio", "foley-mix.wav");
      let rebuildingLocalMix = false;
      let retainedSupersededStem: string | null = null;
      let existing = await stateStore.loadCheckpoint(originalPrompt, key);
      const foleyDependencies: FoleyArtifactDependencies = {
        sourceVideoSha256: video?.sha256 as string,
        sourceAudioAnalysisSha256: sourceAudio.sha256,
        reconciliationSha256: reconciliation.sha256,
      };
      if (existing && await completedFoleyArtifactIsValid(existing, foleyDependencies)) {
        emitEvent(options.onEvent, { event: "foley_completed", path: existing.path as string, cueCount: reconciledCues.length, generatedCueCount: 0, reusedCueCount: reconciledCues.length, source: "local_reuse" });
        return json({ status: "reused", path: existing.path, sha256: existing.sha256 });
      }
      if (existing?.status === "completed") {
        rebuildingLocalMix = true;
        const previousRevision = typeof existing.details?.audioMixRevision === "number"
          ? existing.details.audioMixRevision
          : null;
        retainedSupersededStem = await nonEmptyLocalFile(outputPath)
          ? path.join(
              path.dirname(outputPath),
              `foley-mix.superseded-r${previousRevision ?? "unknown"}`
                + `-attempt${existing.attempt}-${randomBytes(4).toString("hex")}.wav`,
            )
          : null;
        if (retainedSupersededStem) await rename(outputPath, retainedSupersededStem);
        existing = await stateStore.resetCheckpointForRetry(
          originalPrompt,
          key,
          "Rebuilding the local Foley aggregate with the current per-cue loudness mix; retained cue downloads will be reused.",
          {
            previousAudioMixRevision: previousRevision,
            audioMixRevision: AUDIO_MIX_REVISION,
            localMixUpgrade: true,
            ...(retainedSupersededStem
              ? { retainedSupersededStem: path.basename(retainedSupersededStem) }
              : {}),
          },
          "eleven_text_to_sound_v2+ffmpeg",
        );
        emitEvent(options.onEvent, {
          event: "foley_mix_rebuild",
          previousRevision,
          audioMixRevision: AUDIO_MIX_REVISION,
          cueAssetsRetained: true,
        });
      }
      existing = await resetInterruptedFoleyAggregation({
        stateStore,
        originalPrompt,
        runDirectory,
        checkpoint: existing,
      });
      if (existing?.status === "unknown" || (existing?.status === "failed" && existing.retrySafe === false)) {
        invocationFailure = existing.error ?? "Foley generation is blocked by an ambiguous provider outcome.";
        return json({ status: "blocked", reason: invocationFailure, retrySafe: false });
      }
      if (existing?.status === "deferred" && existing.retryAt && Date.parse(existing.retryAt) > now().getTime()) {
        invocationPending = existing.error ?? "Foley is waiting for its retry time.";
        return json({ status: "pending", reason: invocationPending, retryAt: existing.retryAt });
      }
      if (attempted.has(key)) return json({ status: "halted", reason: "Foley already ran in this invocation." });
      attempted.add(key);
      await stateStore.startCheckpoint(originalPrompt, key, {
        provider: "elevenlabs+local",
        model: "eleven_text_to_sound_v2+ffmpeg",
        details: {
          cueCount: reconciledCues.length,
          plannedCueCount: plan.foleyCues.length,
          omittedByVision,
          retimedByVision,
          durationSeconds: plan.totalDurationSeconds,
          audioMixRevision: AUDIO_MIX_REVISION,
          foregroundAudioMode: "elevenlabs_foley",
          sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
          sourceAudioAnalysisSha256: foleyDependencies.sourceAudioAnalysisSha256,
          foleyReconciliationRevision: FOLEY_RECONCILIATION_REVISION,
          foleyReconciliationSha256: reconciliation.sha256,
          sourceVideoSha256: foleyDependencies.sourceVideoSha256,
          cueTargetMeanDbfs: FOLEY_CUE_TARGET_MEAN_DBFS,
          cueMaxNormalizationGainDb: FOLEY_CUE_MAX_NORMALIZATION_GAIN_DB,
          cueMinUsablePeakDbfs: FOLEY_CUE_MIN_USABLE_PEAK_DBFS,
          ...(retainedSupersededStem
            ? { retainedSupersededStem: path.basename(retainedSupersededStem) }
            : {}),
        },
      });
      emitEvent(options.onEvent, { event: "foley_generation_started", cueCount: reconciledCues.length, durationSeconds: plan.totalDurationSeconds, placement: "local_ffmpeg_sample_timeline" });
      const cueDirectory = path.join(runDirectory, "audio", "foley-cues");
      await ensureDirectory(cueDirectory);
      const assets: Array<{
        cue: TimedFoleyCue;
        request: ReturnType<typeof resolveFoleySoundEffectRequest>;
        path: string;
        reused: boolean;
        keyLabel?: string;
        requestId?: string;
      }> = [];
      try {
        for (const cue of reconciledCues) {
          const request = resolveFoleySoundEffectRequest(cue, plan.totalDurationSeconds);
          const cuePath = path.join(
            cueDirectory,
            `${cue.cueId}-${timedCueRequestHash(cue, plan.totalDurationSeconds)}.mp3`,
          );
          if (await nonEmptyLocalFile(cuePath)) {
            assets.push({ cue, request, path: cuePath, reused: true });
            continue;
          }
          const generated = await elevenLabs.generateSoundEffect({
            text: request.text,
            durationSeconds: request.providerDurationSeconds,
            outputPath: cuePath,
            promptInfluence: request.promptInfluence,
            loop: request.loop,
            onAttempt: ({ keyLabel }) => emitEvent(options.onEvent, { event: "foley_key_attempt", cueId: cue.cueId, keyLabel }),
          });
          assets.push({
            cue,
            request,
            path: generated.filePath,
            reused: false,
            keyLabel: generated.keyLabel,
            ...(generated.requestId ? { requestId: generated.requestId } : {}),
          });
        }
        const rendered = await renderFoleyStem({
          sceneDurationSeconds: plan.totalDurationSeconds,
          cues: assets.map(({ cue, request, path: cuePath }) => ({
            path: cuePath,
            atSeconds: cue.atSeconds,
            durationSeconds: request.audibleDurationSeconds,
            volume: timedCueMixVolume(cue),
            spatialPosition: request.spatialPosition,
            continuous: request.continuous,
            fadeInSeconds: request.fadeInSeconds,
            fadeOutSeconds: request.fadeOutSeconds,
          })),
          outputPath,
        });
        const generatedCueCount = assets.filter(({ reused }) => !reused).length;
        const reusedCueCount = assets.filter(({ reused }) => reused).length;
        const completed = await stateStore.completeCheckpoint(originalPrompt, key, {
          path: rendered.outputPath,
          sha256: await sha256File(rendered.outputPath),
          durationSeconds: rendered.durationSeconds,
          provider: "elevenlabs+local",
          model: "eleven_text_to_sound_v2+ffmpeg",
          details: {
            cueCount: rendered.cueCount,
            generatedCueCount,
            reusedCueCount,
            omittedUnusableCueCount: rendered.omittedCueCount,
            plannedCueCount: plan.foleyCues.length,
            omittedByVision,
            retimedByVision,
            keyLabels: [...new Set([
              ...stringList(existing?.details?.keyLabels),
              ...assets.flatMap(({ keyLabel }) => keyLabel ? [keyLabel] : []),
            ])],
            requestIds: [...new Set([
              ...stringList(existing?.details?.requestIds),
              ...assets.flatMap(({ requestId }) => requestId ? [requestId] : []),
            ])],
            placement: "local_ffmpeg_sample_timeline",
            audioMixRevision: AUDIO_MIX_REVISION,
            foregroundAudioMode: "elevenlabs_foley",
            sourceAudioInspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
            sourceAudioAnalysisSha256: foleyDependencies.sourceAudioAnalysisSha256,
            foleyReconciliationRevision: FOLEY_RECONCILIATION_REVISION,
            foleyReconciliationSha256: reconciliation.sha256,
            sourceVideoSha256: foleyDependencies.sourceVideoSha256,
            cueTargetMeanDbfs: FOLEY_CUE_TARGET_MEAN_DBFS,
            cueMaxNormalizationGainDb: FOLEY_CUE_MAX_NORMALIZATION_GAIN_DB,
            cueMinUsablePeakDbfs: FOLEY_CUE_MIN_USABLE_PEAK_DBFS,
            prominenceGain: FOLEY_PROMINENCE_GAIN,
            intensityGain: FOLEY_INTENSITY_GAIN,
            ...(retainedSupersededStem
              ? { retainedSupersededStem: path.basename(retainedSupersededStem) }
              : {}),
          },
        });
        emitEvent(options.onEvent, {
          event: "foley_completed",
          path: completed.path as string,
          cueCount: rendered.cueCount,
          generatedCueCount,
          reusedCueCount,
          source: rebuildingLocalMix ? "local_rebuild" : "generated",
        });
        return json({
          status: "completed",
          path: completed.path,
          sha256: completed.sha256,
          cueCount: rendered.cueCount,
          omittedByVision,
          retimedByVision,
          omittedUnusableCueCount: rendered.omittedCueCount,
          placement: "local_ffmpeg_sample_timeline",
          foregroundAudioMode: "elevenlabs_foley",
        });
      } catch (error) {
        if (!(error instanceof ElevenLabsError)) {
          const message = error instanceof Error ? error.message : String(error);
          await stateStore.failCheckpoint(originalPrompt, key, message, true);
          invocationFailure = message;
          throw error;
        }
        const failure = await elevenLabsFailure(stateStore, originalPrompt, key, error, now());
        invocationPending = failure.pending ?? invocationPending;
        invocationFailure = failure.failure ?? invocationFailure;
        return failure.response;
      }
    },
  });

  const generateMusicTool = new DynamicStructuredTool({
    name: VIDEO_TOOL_NAMES.generateMusic,
    description: "Best-effort generation of a quiet instrumental Free.ai ACE-Step background bed. The host performs the initial attempt plus three retries and durably falls back to the selected diegetic soundtrack alone when music remains unavailable.",
    schema: EmptyInputSchema,
    func: async () => {
      const final = await completedFinalVideo(stateStore, originalPrompt, config);
      if (final) return json({ status: "final_reused", path: final.path });
      const stop = stopped();
      if (stop) return stop;
      const plan = await requirePlan(stateStore, originalPrompt);
      const music = enabledMusicForPlan(plan);
      if (!music) return json({ status: "skipped", reason: "The user explicitly disabled background music; the selected diegetic soundtrack remains enabled." });
      const foregroundAudio = await resolveCurrentForegroundAudioBinding(
        stateStore,
        originalPrompt,
        plan,
      );
      if (!foregroundAudio) return json({ status: "not_ready", missing: ["foreground_audio"] });
      const key = videoCheckpointKeys.music;
      let existing = await stateStore.loadCheckpoint(originalPrompt, key);
      if (optionalMusicWasOmitted(existing)) {
        return json({
          status: "skipped",
          reason: existing?.error ?? "Background music was unavailable after its bounded attempt cycle.",
          persisted: true,
          foleyOnly: true,
          instruction: "Continue directly to final assembly; do not retry background music.",
        });
      }
      const isCurrentFreeAiMusic = existing?.provider === "free.ai"
        && existing.model === FREE_AI_MUSIC_MODEL;
      if (isCurrentFreeAiMusic && existing && await completedFreeAiMusicArtifactIsValid(existing)) {
        emitEvent(options.onEvent, { event: "music_downloaded", path: existing.path as string, model: FREE_AI_MUSIC_MODEL, source: "local_reuse" });
        return json({ status: "reused", path: existing.path, sha256: existing.sha256 });
      }
      const outputPath = path.join(runDirectory, "audio", "music.wav");
      const providerDurationSeconds = freeAiMusicDurationSeconds(plan);
      const retainedUrl = isCurrentFreeAiMusic ? existing?.url : undefined;
      if (existing && !retainedUrl && ["in_progress", "queued", "unknown"].includes(existing.status)) {
        existing = await stateStore.resetCheckpointForRetry(
          originalPrompt,
          key,
          "Retrying an interrupted or pre-switch background-music request under the explicit Free.ai three-retry policy.",
          { migratedToFreeAiAceStep: !isCurrentFreeAiMusic },
          FREE_AI_MUSIC_MODEL,
        );
      }
      if (attempted.has(key)) return json({ status: "halted", reason: "Music already ran in this invocation." });
      attempted.add(key);
      const onAttempt = (attempt: FreeAiMusicAttempt): void => {
        if (attempt.phase === "generation" && attempt.keyLabel) {
          emitEvent(options.onEvent, {
            event: "music_key_attempt",
            model: FREE_AI_MUSIC_MODEL,
            keyLabel: attempt.keyLabel,
            attemptNumber: attempt.attemptNumber,
            maxAttempts: attempt.maxAttempts,
          });
        } else if (attempt.phase === "download") {
          emitEvent(options.onEvent, {
            event: "music_download_attempt",
            model: FREE_AI_MUSIC_MODEL,
            attemptNumber: attempt.attemptNumber,
            maxAttempts: attempt.maxAttempts,
          });
        }
      };
      const omitMusic = async (
        error: unknown,
        source: "provider" | "local",
        downloadReceiptRetained: boolean,
      ): Promise<string> => {
        const message = error instanceof Error ? error.message : String(error);
        const retriesExhausted = error instanceof FreeAiMusicError
          ? error.retryExhausted
          : true;
        await stateStore.skipCheckpoint(originalPrompt, key, message, {
          backgroundMusicRequested: true,
          foleyOnlyFallback: true,
          failureSource: source,
          downloadReceiptRetained,
          retriesExhausted,
        });
        emitEvent(options.onEvent, {
          event: "music_generation_failed",
          reason: message,
          retrySafe: false,
          source,
        });
        emitEvent(options.onEvent, {
          event: "music_omitted",
          reason: message,
          source,
          foleyOnly: true,
        });
        return json({
          status: "skipped",
          reason: message,
          retrySafe: false,
          retriesExhausted,
          foleyOnly: true,
          instruction: "Background music is optional and its bounded attempt cycle is complete. Continue directly to final assembly with the selected diegetic soundtrack only; do not retry music on this or later invocations.",
        });
      };
      const preserveDownloadedMusicAfterLocalFailure = async (error: unknown): Promise<string> => {
        const message = `Free.ai music was downloaded and validated, but its local checkpoint could not be finalized: ${error instanceof Error ? error.message : String(error)}`;
        await stateStore.markUnknown(originalPrompt, key, message);
        invocationFailure = message;
        emitEvent(options.onEvent, {
          event: "music_generation_failed",
          reason: message,
          retrySafe: false,
          source: "local",
        });
        return json({
          status: "unknown",
          reason: message,
          retrySafe: false,
          localArtifactRetained: true,
          instruction: `Adopt the validated deterministic music file without another provider request with: ${resumeCommand}`,
        });
      };
      const completeMusic = async (generated: DownloadedMusicArtifact): Promise<string> => {
        try {
          await validateMusicArtifact({
            inputPath: generated.filePath,
            minimumDurationSeconds: plan.totalDurationSeconds,
          });
        } catch (cause) {
          await rm(generated.filePath, { force: true }).catch(() => undefined);
          return await omitMusic(new FreeAiMusicError(
            `Free.ai returned an unusable music file: ${cause instanceof Error ? cause.message : String(cause)}`,
            { kind: "download", cause, retryExhausted: true },
          ), "provider", true);
        }
        try {
          const receiptCheckpoint = await stateStore.loadCheckpoint(originalPrompt, key);
          const completed = await stateStore.completeCheckpoint(originalPrompt, key, {
            path: generated.filePath,
            url: generated.url,
            ...(generated.externalId ? { externalId: generated.externalId } : {}),
            sha256: await sha256File(generated.filePath),
            durationSeconds: plan.totalDurationSeconds,
            provider: "free.ai",
            model: FREE_AI_MUSIC_MODEL,
            details: {
              ...(receiptCheckpoint?.details ?? {}),
              ...(generated.keyLabel ? { keyLabel: generated.keyLabel } : {}),
              providerDurationSeconds: generated.providerDurationSeconds,
              ...(generated.generationAttempts === undefined
                ? {}
                : { generationAttempts: generated.generationAttempts }),
              downloadAttempts: generated.downloadAttempts,
              instrumentalPrompt: true,
              mediaValidated: true,
            },
          });
          emitEvent(options.onEvent, { event: "music_downloaded", path: completed.path as string, model: FREE_AI_MUSIC_MODEL, source: "provider" });
          return json({
            status: "completed",
            path: completed.path,
            sha256: completed.sha256,
            model: FREE_AI_MUSIC_MODEL,
            ...(generated.keyLabel ? { keyLabel: generated.keyLabel } : {}),
            ...(generated.generationAttempts === undefined
              ? {}
              : { generationAttempts: generated.generationAttempts }),
            downloadAttempts: generated.downloadAttempts,
          });
        } catch (error) {
          return await preserveDownloadedMusicAfterLocalFailure(error);
        }
      };

      if (retainedUrl && existing) {
        let localMusicIsValid = false;
        try {
          const information = await stat(outputPath);
          if (information.isFile() && information.size > 0) {
            await validateMusicArtifact({
              inputPath: outputPath,
              minimumDurationSeconds: plan.totalDurationSeconds,
            });
            localMusicIsValid = true;
          }
        } catch {
          // A deterministic final path is created only by atomic rename. If it
          // is absent or FFprobe rejects it, retry the retained provider URL.
          await rm(outputPath, { force: true }).catch(() => undefined);
        }
        if (localMusicIsValid) {
          try {
            const completed = await stateStore.completeCheckpoint(originalPrompt, key, {
              path: outputPath,
              url: retainedUrl,
              ...(existing.externalId ? { externalId: existing.externalId } : {}),
              sha256: await sha256File(outputPath),
              durationSeconds: plan.totalDurationSeconds,
              provider: "free.ai",
              model: FREE_AI_MUSIC_MODEL,
              details: {
                ...(existing.details ?? {}),
                recoveredFromLocalArtifact: true,
                mediaValidated: true,
              },
            });
            emitEvent(options.onEvent, {
              event: "music_downloaded",
              path: completed.path as string,
              model: FREE_AI_MUSIC_MODEL,
              source: "local_reuse",
            });
            return json({
              status: "recovered",
              path: completed.path,
              sha256: completed.sha256,
              providerRequestRepeated: false,
              downloadRepeated: false,
            });
          } catch (error) {
            return await preserveDownloadedMusicAfterLocalFailure(error);
          }
        }
        let resumed;
        try {
          resumed = await stateStore.recordDownloadableMediaReceipt(originalPrompt, key, {
            url: retainedUrl,
            ...(existing.externalId ? { externalId: existing.externalId } : {}),
            durationSeconds: plan.totalDurationSeconds,
            provider: "free.ai",
            model: FREE_AI_MUSIC_MODEL,
            details: { downloadResumed: true },
          });
        } catch (error) {
          return await omitMusic(error, "local", true);
        }
        emitEvent(options.onEvent, {
          event: "music_download_resumed",
          model: FREE_AI_MUSIC_MODEL,
          checkpointAttempt: resumed.attempt,
        });
        try {
          const downloaded = await freeAiMusic.downloadMusic({
            url: retainedUrl,
            outputPath,
            onAttempt,
          });
          const storedGenerationAttempts = existing.details?.generationAttempts;
          const storedProviderDuration = existing.details?.providerDurationSeconds;
          const storedKeyLabel = existing.details?.keyLabel;
          return await completeMusic({
            ...downloaded,
            providerDurationSeconds: typeof storedProviderDuration === "number"
              ? storedProviderDuration
              : providerDurationSeconds,
            ...(typeof storedGenerationAttempts === "number"
              ? { generationAttempts: storedGenerationAttempts }
              : {}),
            ...(typeof storedKeyLabel === "string" ? { keyLabel: storedKeyLabel } : {}),
            ...(existing.externalId ? { externalId: existing.externalId } : {}),
          });
        } catch (error) {
          return await omitMusic(error, "provider", true);
        }
      }

      await rm(outputPath, { force: true }).catch(() => undefined);
      await stateStore.startCheckpoint(originalPrompt, key, {
        provider: "free.ai",
        model: FREE_AI_MUSIC_MODEL,
        details: {
          durationSeconds: plan.totalDurationSeconds,
          providerDurationSeconds,
          maxRetries: DEFAULT_FREE_AI_MUSIC_MAX_RETRIES,
        },
      });
      emitEvent(options.onEvent, {
        event: "music_generation_started",
        model: FREE_AI_MUSIC_MODEL,
        durationSeconds: plan.totalDurationSeconds,
        providerDurationSeconds,
        requestTimeoutMs: config.FREE_AI_REQUEST_TIMEOUT_MS,
        maxRetries: DEFAULT_FREE_AI_MUSIC_MAX_RETRIES,
      });
      let generated: FreeAiMusicResult;
      try {
        generated = await freeAiMusic.generateMusic({
          prompt: musicPrompt(plan),
          durationSeconds: plan.totalDurationSeconds,
          genre: music.genre,
          tempo: music.tempoBpm,
          outputPath,
          onAttempt,
          onSubmitted: async (submission) => {
            await stateStore.recordDownloadableMediaReceipt(originalPrompt, key, {
              url: submission.url,
              ...(submission.externalId ? { externalId: submission.externalId } : {}),
              durationSeconds: plan.totalDurationSeconds,
              provider: "free.ai",
              model: FREE_AI_MUSIC_MODEL,
              details: {
                keyLabel: submission.keyLabel,
                providerDurationSeconds: submission.providerDurationSeconds,
                generationAttempts: submission.generationAttempts,
                maxRetries: DEFAULT_FREE_AI_MUSIC_MAX_RETRIES,
              },
            });
          },
        });
      } catch (error) {
        const retained = Boolean((await stateStore.loadCheckpoint(originalPrompt, key)
          .catch(() => null))?.url);
        return await omitMusic(
          error,
          error instanceof FreeAiMusicError ? "provider" : "local",
          retained,
        );
      }
      return await completeMusic(generated);
    },
  });

  const assembleTool = new DynamicStructuredTool({
    name: VIDEO_TOOL_NAMES.assembleVideo,
    description: "Assemble the one Agnes source with either its preserved native soundtrack or the exact-timeline ElevenLabs Foley fallback, plus the optional quiet Free.ai music bed. Paths come only from durable checkpoints.",
    schema: EmptyInputSchema,
    func: async () => {
      const stop = stopped();
      if (stop) return stop;
      const plan = await requirePlan(stateStore, originalPrompt);
      const configuration = resolveGenerationConfiguration(plan, originalPrompt, config);
      const key = videoCheckpointKeys.assembly;
      const existing = await stateStore.loadCheckpoint(originalPrompt, key);
      if (existing && await validateCompletedFinalVideoForState(
        existing,
        stateStore,
        config,
        plan,
        originalPrompt,
      )) {
        const cleanup = await cleanupValidatedRunArtifacts({
          requested: configuration.cleanupAfterSuccess,
          runDirectory,
          retainedFinalPath: existing.path as string,
          originalPrompt,
          compactReceipts: async () => await stateStore.compactCompletedArtifacts(originalPrompt),
        });
        emitEvent(options.onEvent, { event: "artifact_cleanup", requested: cleanup.requested, performed: cleanup.performed, retention: cleanup.retention, reason: cleanup.reason });
        return json({ status: "reused", path: existing.path, cleanup });
      }
      const video = await stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.sourceVideo);
      const foregroundBinding = await resolveCurrentForegroundAudioBinding(
        stateStore,
        originalPrompt,
        plan,
      );
      const musicRequested = planUsesBackgroundMusic(plan);
      const music = musicRequested
        ? await stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.music)
        : null;
      const musicAvailable = musicRequested && await completedFreeAiMusicArtifactIsValid(music);
      const musicOmitted = musicRequested && optionalMusicWasOmitted(music);
      const missing = [
        ...(!await completedArtifactIsValid(video) ? ["video"] : []),
        ...(!foregroundBinding ? ["foreground_audio"] : []),
        ...(musicRequested && !musicAvailable && !musicOmitted ? ["music"] : []),
      ];
      if (missing.length) {
        await resetInterruptedLocalAssembly({
          stateStore,
          originalPrompt,
          runDirectory,
          checkpoint: existing,
        });
        return json({ status: "not_ready", missing });
      }
      const dependencies: FinalArtifactDependencies = {
        ...(foregroundBinding as CurrentForegroundAudioBinding).dependencies,
        musicDependencyStatus: musicAvailable
          ? "included"
          : musicOmitted
            ? "skipped"
            : "disabled",
        musicSha256: musicAvailable ? music?.sha256 as string : null,
      };
      const recovered = await recoverInterruptedLocalAssembly({
        stateStore,
        originalPrompt,
        runDirectory,
        checkpoint: existing,
        config,
        plan,
        expectedDependencies: dependencies,
      });
      if (recovered) {
        emitEvent(options.onEvent, {
          event: "assembly_completed",
          attempt: recovered.checkpoint.attempt,
          path: recovered.checkpoint.path as string,
          elapsedMs: 0,
        });
        const cleanup = await cleanupValidatedRunArtifacts({
          requested: configuration.cleanupAfterSuccess,
          runDirectory,
          retainedFinalPath: recovered.checkpoint.path as string,
          originalPrompt,
          compactReceipts: async () => await stateStore.compactCompletedArtifacts(originalPrompt),
        });
        emitEvent(options.onEvent, { event: "artifact_cleanup", requested: cleanup.requested, performed: cleanup.performed, retention: cleanup.retention, reason: cleanup.reason });
        return json({
          status: "recovered",
          path: recovered.checkpoint.path,
          sha256: recovered.checkpoint.sha256,
          recoverySource: recovered.source,
          cleanup,
        });
      }
      await resetInterruptedLocalAssembly({
        stateStore,
        originalPrompt,
        runDirectory,
        checkpoint: existing,
      });
      const started = await stateStore.startCheckpoint(originalPrompt, key, {
        provider: "local",
        model: "ffmpeg-static",
        details: {
          totalDurationSeconds: plan.totalDurationSeconds,
          backgroundMusicRequested: musicRequested,
          backgroundMusicIncluded: musicAvailable,
          foleyOnlyFallback: musicOmitted,
          diegeticOnlyFallback: musicOmitted,
          audioMixRevision: AUDIO_MIX_REVISION,
          ...finalDependencyDetails(dependencies),
          musicVolume: config.VIDEO_MUSIC_VOLUME,
          foleyVolume: config.VIDEO_FOLEY_VOLUME,
          backgroundMusicMix: BACKGROUND_MUSIC_MIX,
          processTimeoutMs: DEFAULT_MEDIA_PROCESS_TIMEOUT_MS,
          ...(musicOmitted && music?.error ? { backgroundMusicOmissionReason: music.error } : {}),
        },
      });
      await stateStore.updateStatus(originalPrompt, "assembling");
      const { outputPath, partialPath } = finalVideoArtifactPaths(
        runDirectory,
        originalPrompt,
        started.attempt,
      );
      const assemblyStartedAt = Date.now();
      emitEvent(options.onEvent, {
        event: "assembly_started",
        attempt: started.attempt,
        path: outputPath,
        durationSeconds: plan.totalDurationSeconds,
        processTimeoutMs: DEFAULT_MEDIA_PROCESS_TIMEOUT_MS,
        foregroundAudioMode: dependencies.foregroundAudioMode,
        backgroundMusicIncluded: musicAvailable,
        musicVolume: config.VIDEO_MUSIC_VOLUME,
        foleyVolume: config.VIDEO_FOLEY_VOLUME,
        backgroundMusicMix: BACKGROUND_MUSIC_MIX,
      });
      let recoverableArtifactReady = false;
      try {
        const stagedResult = await assembleVideo({
          scenes: [{
            videoPath: video?.path as string,
            durationSeconds: plan.totalDurationSeconds,
            foregroundAudio: foregroundBinding?.mode === "agnes_native"
              ? { kind: "native" }
              : {
                  kind: "foley",
                  path: (foregroundBinding as CurrentFoleyBinding).foley.path as string,
                  volume: config.VIDEO_FOLEY_VOLUME,
                },
          }],
          ...(musicAvailable && music?.path ? { musicPath: music.path } : {}),
          outputPath: partialPath,
          musicVolume: config.VIDEO_MUSIC_VOLUME,
          width: configuration.video.width,
          height: configuration.video.height,
          fps: configuration.video.fps,
        });
        // FFmpeg and FFprobe have both succeeded. From this point onward the
        // exact attempt artifact is recoverable and must survive state-I/O errors.
        recoverableArtifactReady = true;
        await rename(partialPath, outputPath);
        const result = { ...stagedResult, outputPath };
        const completed = await stateStore.completeCheckpoint(originalPrompt, key, {
          path: result.outputPath,
          sha256: await sha256File(result.outputPath),
          durationSeconds: result.durationSeconds,
          provider: "local",
          model: "ffmpeg-static",
          details: {
            ...result,
            backgroundMusicRequested: musicRequested,
            backgroundMusicIncluded: musicAvailable,
            foleyOnlyFallback: musicOmitted,
            diegeticOnlyFallback: musicOmitted,
            audioMixRevision: AUDIO_MIX_REVISION,
            ...finalDependencyDetails(dependencies),
            musicVolume: config.VIDEO_MUSIC_VOLUME,
            foleyVolume: config.VIDEO_FOLEY_VOLUME,
            backgroundMusicMix: BACKGROUND_MUSIC_MIX,
          },
        });
        await stateStore.updateStatus(originalPrompt, "completed");
        emitEvent(options.onEvent, {
          event: "assembly_completed",
          attempt: started.attempt,
          path: completed.path as string,
          elapsedMs: Date.now() - assemblyStartedAt,
        });
        const cleanup = await cleanupValidatedRunArtifacts({
          requested: configuration.cleanupAfterSuccess,
          runDirectory,
          retainedFinalPath: completed.path as string,
          originalPrompt,
          compactReceipts: async () => await stateStore.compactCompletedArtifacts(originalPrompt),
        });
        emitEvent(options.onEvent, { event: "artifact_cleanup", requested: cleanup.requested, performed: cleanup.performed, retention: cleanup.retention, reason: cleanup.reason });
        return json({
          status: "completed",
          path: completed.path,
          sha256: completed.sha256,
          durationSeconds: result.durationSeconds,
          video: `${result.width}x${result.height} ${result.fps}fps ${result.videoCodec}`,
          audio: `${result.audioCodec} ${result.audioSampleRate}Hz stereo`,
          backgroundMusic: musicAvailable ? "included" : "omitted",
          foleyOnlyFallback: musicOmitted,
          diegeticOnlyFallback: musicOmitted,
          foregroundAudioMode: dependencies.foregroundAudioMode,
          cleanup,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!recoverableArtifactReady) {
          await rm(partialPath, { force: true }).catch(() => undefined);
          await stateStore.failCheckpoint(originalPrompt, key, message, true);
          await stateStore.updateStatus(originalPrompt, "failed");
        }
        emitEvent(options.onEvent, {
          event: "assembly_failed",
          attempt: started.attempt,
          reason: message,
          elapsedMs: Date.now() - assemblyStartedAt,
          processTimeoutMs: DEFAULT_MEDIA_PROCESS_TIMEOUT_MS,
          retrySafe: true,
          retainedInputs: true,
        });
        invocationFailure = message;
        throw error;
      }
    },
  });

  const tools: unknown[] = [
    statusTool,
    validatePlanTool,
    generateVideoTool,
    generateFoleyTool,
    generateMusicTool,
    assembleTool,
  ];

  if (options.youtube) {
    const youtube = options.youtube;
    tools.push(new DynamicStructuredTool({
      name: VIDEO_TOOL_NAMES.youtubeUpload,
      description: "Upload the checkpointed final MP4 with the locked LLM-generated title, description, tags, and category plus trusted privacy, audience, and synthetic-media settings. This capability exists only for an explicitly requested, host-authorized YouTube upload.",
      schema: EmptyInputSchema,
      func: async () => {
        const key = videoCheckpointKeys.youtubeUpload;
        let existing = await stateStore.loadCheckpoint(originalPrompt, key);
        if (existing?.status === "completed" && existing.externalId) {
          return json({ status: "reused", videoId: existing.externalId, url: existing.url });
        }
        const plan = await requirePlan(stateStore, originalPrompt);
        if (!plan.youtubeUpload?.requested) throw new Error("The prompt and locked plan do not authorize YouTube upload.");
        const assembly = await stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.assembly);
        if (!assembly?.path || !await validateCompletedFinalVideoForState(
          assembly,
          stateStore,
          config,
          plan,
          originalPrompt,
        )) return json({ status: "not_ready", reason: "The final MP4 is not ready with the current audio mix." });
        if (
          existing
          && (
            existing.status === "in_progress"
            || existing.status === "unknown"
            || (existing.status === "failed" && existing.retrySafe === false)
          )
        ) {
          const reason = existing.status === "in_progress"
            ? "A previous YouTube upload was interrupted after it started; whether YouTube accepted it is unknown."
            : existing.error ?? "A previous YouTube upload has an ambiguous outcome.";
          if (existing.status === "in_progress") {
            existing = await stateStore.markUnknown(originalPrompt, key, reason, {
              details: { ambiguousUploadOutcome: true, manualReconciliationRequired: true },
            });
          }
          invocationFailure = reason;
          await stateStore.updateStatus(originalPrompt, "failed");
          emitEvent(options.onEvent, {
            event: "youtube_upload_failed",
            reason,
            retrySafe: false,
            ambiguousOutcome: true,
          });
          return json({
            status: "unknown",
            reason,
            retrySafe: false,
            videoId: existing.externalId,
            url: existing.url,
            instruction: "Check YouTube Studio for the video before manually reconciling this checkpoint. Automatic retry is blocked to prevent a duplicate upload.",
          });
        }
        if (attempted.has(key)) {
          return json({ status: "halted", reason: "YouTube upload already ran in this invocation." });
        }
        attempted.add(key);
        const uploadDetails = {
          title: plan.youtubeUpload.title,
          description: plan.youtubeUpload.description,
          tags: plan.youtubeUpload.tags,
          categoryId: plan.youtubeUpload.categoryId,
          privacyStatus: config.YOUTUBE_DEFAULT_PRIVACY,
          madeForKids: config.YOUTUBE_DEFAULT_MADE_FOR_KIDS,
          containsSyntheticMedia: config.YOUTUBE_DEFAULT_CONTAINS_SYNTHETIC_MEDIA,
          notifySubscribers: false,
        };
        await stateStore.startCheckpoint(originalPrompt, key, {
          provider: "youtube",
          model: "youtube-data-api-v3",
          details: uploadDetails,
        });
        await stateStore.updateStatus(originalPrompt, "generating");
        emitEvent(options.onEvent, {
          event: "youtube_upload_started",
          title: plan.youtubeUpload.title,
          categoryId: plan.youtubeUpload.categoryId,
          tagCount: plan.youtubeUpload.tags.length,
          privacyStatus: config.YOUTUBE_DEFAULT_PRIVACY,
          madeForKids: config.YOUTUBE_DEFAULT_MADE_FOR_KIDS,
          containsSyntheticMedia: config.YOUTUBE_DEFAULT_CONTAINS_SYNTHETIC_MEDIA,
        });
        try {
          const uploaded = await youtube.uploader.upload({
            filePath: assembly.path,
            title: plan.youtubeUpload.title,
            description: plan.youtubeUpload.description,
            tags: plan.youtubeUpload.tags,
            categoryId: plan.youtubeUpload.categoryId,
            privacyStatus: config.YOUTUBE_DEFAULT_PRIVACY,
            selfDeclaredMadeForKids: config.YOUTUBE_DEFAULT_MADE_FOR_KIDS,
            containsSyntheticMedia: config.YOUTUBE_DEFAULT_CONTAINS_SYNTHETIC_MEDIA,
            notifySubscribers: false,
            authorization: { confirmed: true, token: youtube.authorizationToken },
          });
          try {
            await stateStore.completeCheckpoint(originalPrompt, key, {
              path: assembly.path,
              url: uploaded.url,
              externalId: uploaded.videoId,
              provider: "youtube",
              model: "youtube-data-api-v3",
              details: { ...uploadDetails, privacyStatus: uploaded.privacyStatus },
            });
          } catch (cause) {
            const message = `YouTube returned video ID ${uploaded.videoId}, but its local receipt could not be finalized: ${cause instanceof Error ? cause.message : String(cause)}`;
            await stateStore.markUnknown(originalPrompt, key, message, {
              url: uploaded.url,
              externalId: uploaded.videoId,
              details: {
                ...uploadDetails,
                privacyStatus: uploaded.privacyStatus,
                ambiguousUploadOutcome: false,
                manualReconciliationRequired: true,
              },
            });
            invocationFailure = message;
            await stateStore.updateStatus(originalPrompt, "failed");
            emitEvent(options.onEvent, {
              event: "youtube_upload_failed",
              reason: message,
              retrySafe: false,
              ambiguousOutcome: false,
            });
            return json({
              status: "unknown",
              reason: message,
              videoId: uploaded.videoId,
              url: uploaded.url,
              retrySafe: false,
              instruction: "The known YouTube video ID is retained; automatic re-upload is blocked.",
            });
          }
          emitEvent(options.onEvent, {
            event: "youtube_upload_completed",
            videoId: uploaded.videoId,
            url: uploaded.url,
            privacyStatus: uploaded.privacyStatus,
          });
          return json({ status: "completed", ...uploaded });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const ambiguousOutcome = !(error instanceof YouTubeUploadError)
            || error.ambiguousOutcome;
          if (ambiguousOutcome) {
            await stateStore.markUnknown(originalPrompt, key, message, {
              details: { ambiguousUploadOutcome: true, manualReconciliationRequired: true },
            });
          } else {
            await stateStore.failCheckpoint(originalPrompt, key, message, true);
          }
          invocationFailure = message;
          await stateStore.updateStatus(originalPrompt, "failed");
          emitEvent(options.onEvent, {
            event: "youtube_upload_failed",
            reason: message,
            retrySafe: !ambiguousOutcome,
            ambiguousOutcome,
          });
          return json({
            status: ambiguousOutcome ? "unknown" : "failed",
            reason: message,
            retrySafe: !ambiguousOutcome,
            ambiguousOutcome,
            instruction: ambiguousOutcome
              ? "Check YouTube Studio before manually reconciling this checkpoint. Automatic retry is blocked to prevent duplicates."
              : "The API definitely rejected this upload. Correct the credentials, metadata, quota, or policy issue and resume this run.",
          });
        }
      },
    }));
  }

  return {
    tools: tools as DynamicStructuredTool[],
    names: VIDEO_TOOL_NAMES,
    youtubeUploadAuthorized: Boolean(options.youtube),
    currentInvocationPending: () => invocationPending,
    currentInvocationFailure: () => invocationFailure,
  };
}

export function createUploadAuthorizationToken(): string {
  return randomBytes(32).toString("hex");
}
