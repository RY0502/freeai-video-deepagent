import type { VideoPlan } from './agent/videoPlan.js';
import { FREE_AI_MUSIC_MODEL } from './freeai/index.js';
import { SOURCE_AUDIO_INSPECTION_REVISION } from './media/index.js';
import {
  foleyMixRevisionIsCurrent,
  nativeSourceAudioSelectionIsCurrent,
  SOURCE_AUDIO_ANALYSIS_MODEL,
} from './tools/videoAgentTools.js';
import {
  FOLEY_RECONCILIATION_MODEL,
  FOLEY_RECONCILIATION_REVISION,
} from './vision/index.js';
import {
  type ArtifactCheckpoint,
  type VideoCheckpointKey,
  VideoRunStateStore,
  videoCheckpointKeys,
} from './state/index.js';

export interface MediaToolInvoker {
  invoke(input: Record<string, never>): Promise<unknown>;
}

export interface MediaReconciliationTools {
  generateVideo: MediaToolInvoker;
  generateMusic: MediaToolInvoker;
  generateFoley: MediaToolInvoker;
}

export interface ReconciledMediaCheckpoint {
  key: VideoCheckpointKey;
  outcome: unknown;
  stopsInvocation?: boolean;
  pendingReason?: string;
  failureReason?: string;
}

function parsedOutcome(outcome: unknown): Record<string, unknown> | undefined {
  let value = outcome;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function interruption(outcome: unknown): Pick<
  ReconciledMediaCheckpoint,
  'stopsInvocation' | 'pendingReason' | 'failureReason'
> {
  const record = parsedOutcome(outcome);
  if (!record) return {};
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  if (record.status === 'pending') {
    return {
      stopsInvocation: true,
      pendingReason: reason ?? 'The accepted Agnes task is still queued or rendering.',
    };
  }
  if (
    record.status === 'failed'
    && record.retrySafe === true
    && record.retryOn === 'next_invocation'
  ) {
    return {
      stopsInvocation: true,
      failureReason: reason ?? 'A media generation request failed.',
    };
  }
  if (record.status === 'unknown' || record.status === 'blocked') {
    return {
      stopsInvocation: true,
      failureReason: reason ?? 'A media request is blocked by an ambiguous or terminal outcome.',
    };
  }
  return {};
}

function retryIsDue(checkpoint: ArtifactCheckpoint, now: Date): boolean {
  return !checkpoint.retryAt || Date.parse(checkpoint.retryAt) <= now.getTime();
}

function shouldReconcile(
  key: VideoCheckpointKey,
  checkpoint: ArtifactCheckpoint,
  now: Date,
  foleyDependenciesCurrent = true,
): boolean {
  // A best-effort music omission is terminal by policy, even if an older
  // checkpoint happened to retain a provider URL. Never spend another request.
  if (key === videoCheckpointKeys.music && checkpoint.status === 'skipped') return false;
  if (
    key === videoCheckpointKeys.foley
    && checkpoint.status === 'completed'
    && (
      checkpoint.provider !== 'elevenlabs+local'
      || checkpoint.model !== 'eleven_text_to_sound_v2+ffmpeg'
      || !foleyMixRevisionIsCurrent(checkpoint)
      || !foleyDependenciesCurrent
    )
  ) return true;
  // ElevenLabs sound effects return media synchronously and expose no job ID
  // that could be polled after a lost response. Resume on the next invocation;
  // the Foley tool preserves any completed content-addressed cue files and
  // retries only the missing request rather than blocking the prompt forever.
  if (
    key === videoCheckpointKeys.foley
    && (
      ['queued', 'in_progress'].includes(checkpoint.status)
      || checkpoint.status === 'unknown'
    )
  ) return true;
  if (key === videoCheckpointKeys.sourceVideo) {
    if (['queued', 'in_progress', 'unknown'].includes(checkpoint.status)) return true;
    // A locally missing/corrupt completed download can be recovered from its
    // accepted provider receipt without creating another Agnes task.
    if (checkpoint.status === 'completed' && checkpoint.providerJob) return true;
    if (!retryIsDue(checkpoint, now)) return false;
    if (checkpoint.status === 'deferred') return checkpoint.retrySafe !== false;
    return checkpoint.status === 'failed'
      && checkpoint.retrySafe === true
      && !checkpoint.providerJob;
  }
  if (
    key === videoCheckpointKeys.music
    && checkpoint.provider === 'free.ai'
    && checkpoint.model === FREE_AI_MUSIC_MODEL
    && Boolean(checkpoint.url)
    && checkpoint.status !== 'completed'
  ) return true;
  if (
    key === videoCheckpointKeys.music
    && checkpoint.status === 'completed'
    && (checkpoint.provider !== 'free.ai' || checkpoint.model !== FREE_AI_MUSIC_MODEL)
  ) return true;
  if (!retryIsDue(checkpoint, now)) return false;
  if (checkpoint.status === 'deferred') return checkpoint.retrySafe !== false;
  return checkpoint.status === 'failed' && checkpoint.retrySafe === true;
}

function sourceAudioAnalysisIsCurrent(
  source: ArtifactCheckpoint,
  analysis: ArtifactCheckpoint | null,
): analysis is ArtifactCheckpoint {
  return source.status === 'completed'
    && typeof source.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(source.sha256)
    && analysis?.status === 'completed'
    && typeof analysis.path === 'string'
    && typeof analysis.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(analysis.sha256)
    && analysis.provider === 'local'
    && analysis.model === SOURCE_AUDIO_ANALYSIS_MODEL
    && analysis.details?.inspectionRevision === SOURCE_AUDIO_INSPECTION_REVISION
    && analysis.details?.sourceVideoSha256 === source.sha256
    && typeof analysis.details?.usable === 'boolean';
}

function foregroundSelectionIsCurrent(options: {
  source: ArtifactCheckpoint;
  sourceAudioAnalysis: ArtifactCheckpoint;
  foleyAnalysis: ArtifactCheckpoint | null;
  selection: ArtifactCheckpoint | null;
}): boolean {
  const { source, sourceAudioAnalysis, foleyAnalysis, selection } = options;
  if (!source.sha256 || !sourceAudioAnalysis.sha256) return false;
  const expected = {
    sourceVideoSha256: source.sha256,
    sourceAudioAnalysisSha256: sourceAudioAnalysis.sha256,
  };
  if (sourceAudioAnalysis.details?.usable === true) {
    return nativeSourceAudioSelectionIsCurrent(selection, expected);
  }
  return sourceAudioAnalysis.details?.usable === false
    && selection?.status === 'completed'
    && typeof selection.path === 'string'
    && typeof selection.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(selection.sha256)
    && foleyMixRevisionIsCurrent(selection)
    && selection.details?.sourceVideoSha256 === expected.sourceVideoSha256
    && selection.details?.sourceAudioAnalysisSha256
      === expected.sourceAudioAnalysisSha256
    && foleyAnalysis?.status === 'completed'
    && typeof foleyAnalysis.path === 'string'
    && typeof foleyAnalysis.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(foleyAnalysis.sha256)
    && foleyAnalysis.sha256 === selection.details?.foleyReconciliationSha256
    && foleyAnalysis.provider === 'vision-orchestrator+ffmpeg'
    && foleyAnalysis.model === FOLEY_RECONCILIATION_MODEL
    && foleyAnalysis.details?.reconciliationRevision === FOLEY_RECONCILIATION_REVISION
    && foleyAnalysis.details?.sourceVideoSha256 === expected.sourceVideoSha256;
}

/**
 * Resume durable provider/local work before invoking the LLM. An accepted
 * Agnes receipt is always polled, never cleared or replaced. An eight-minute
 * pending result ends this invocation successfully so the next run continues
 * from the same video_id.
 */
export async function reconcileDueMediaCheckpoints(options: {
  stateStore: VideoRunStateStore;
  originalPrompt: string;
  tools: MediaReconciliationTools;
  now?: Date;
}): Promise<ReconciledMediaCheckpoint[]> {
  const { stateStore, originalPrompt, tools } = options;
  const plan = await stateStore.loadPlan(originalPrompt);
  if (!plan) return [];

  const now = options.now ?? new Date();
  const outcomes: ReconciledMediaCheckpoint[] = [];
  const invoke = async (
    key: VideoCheckpointKey,
    tool: keyof MediaReconciliationTools,
  ): Promise<boolean> => {
    try {
      const outcome = await tools[tool].invoke({});
      const stop = interruption(outcome);
      outcomes.push({ key, outcome, ...stop });
      return stop.stopsInvocation === true;
    } catch (error) {
      outcomes.push({
        key,
        outcome: { error: error instanceof Error ? error.message : String(error) },
      });
      return false;
    }
  };

  let source = await stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.sourceVideo);
  if (
    source
    && shouldReconcile(videoCheckpointKeys.sourceVideo, source, now)
    && await invoke(videoCheckpointKeys.sourceVideo, 'generateVideo')
  ) return outcomes;

  // Reload after polling/downloading: the video tool may have converted a
  // retained Agnes receipt into a completed local source during this run.
  source = await stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.sourceVideo);
  if (source?.status === 'completed' && source.path && source.sha256) {
    const [sourceAudioAnalysis, selection, foleyAnalysis] = await Promise.all([
      stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.sourceAudioAnalysis),
      stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.foley),
      stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.foleyAnalysis),
    ]);
    const analysisCurrent = sourceAudioAnalysisIsCurrent(source, sourceAudioAnalysis);
    const foregroundCurrent = analysisCurrent && foregroundSelectionIsCurrent({
      source,
      sourceAudioAnalysis,
      foleyAnalysis,
      selection,
    });
    const selectionCanRun = !selection
      || selection.status === 'skipped'
      || shouldReconcile(videoCheckpointKeys.foley, selection, now, false);
    if ((!analysisCurrent || !foregroundCurrent) && (!analysisCurrent || selectionCanRun)) {
      const triggerKey = analysisCurrent
        ? videoCheckpointKeys.foley
        : videoCheckpointKeys.sourceAudioAnalysis;
      if (await invoke(triggerKey, 'generateFoley')) return outcomes;
    }
  }

  if (plan.music.enabled) {
    const music = await stateStore.loadCheckpoint(originalPrompt, videoCheckpointKeys.music);
    if (
      music
      && shouldReconcile(videoCheckpointKeys.music, music, now)
    ) await invoke(videoCheckpointKeys.music, 'generateMusic');
  }
  return outcomes;
}
