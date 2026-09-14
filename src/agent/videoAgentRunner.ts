import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  DeepAgentRunner,
  type DeepAgentRunnerOptions,
  type RunResult,
} from 'freetier-deepagent-framework';
import { LocalFrameworkDatabase } from '../state/localFrameworkDatabase.js';
import { VideoRunStateStore } from '../state/videoRunState.js';
import {
  VideoPlanningAttemptsExhaustedError,
  createVideoPlanningAttemptBudget,
  ensureDeepAgentPlanningMiddleware,
  withVideoPlanningAttemptBudget,
} from './deepAgentCompatibility.js';
import { scopeFrameworkFilesystemToRunDirectory } from './scopedFilesystemBackend.js';
import { createVideoPlanningSystemPrompt } from './systemPrompt.js';
import { promptExplicitlyRequestsYouTubeUpload, type VideoPlan } from './videoPlan.js';

export interface VideoAgentTools {
  /** Prompt-aware compact-draft validator supplied by the host application. */
  validatePlan: DynamicStructuredTool;
  generateVideo: DynamicStructuredTool;
  generateMusic: DynamicStructuredTool;
  generateFoley: DynamicStructuredTool;
  assembleVideo: DynamicStructuredTool;
  additionalTools?: DynamicStructuredTool[];
  youtubeUploadToolFactory?: YouTubeUploadToolFactory;
}

export interface YouTubeUploadAuthorization {
  /** Must come from trusted application state, never from model tool arguments. */
  approved: true;
  /** Binds this approval to one normalized user prompt. */
  promptHash: string;
  /** Opaque one-run token consumed by the external upload-tool factory. */
  token: string;
}

export interface AuthorizedYouTubeToolContext {
  originalPrompt: string;
  promptHash: string;
  authorization: Readonly<YouTubeUploadAuthorization>;
}

export type YouTubeUploadToolFactory = (
  context: AuthorizedYouTubeToolContext,
) => DynamicStructuredTool | Promise<DynamicStructuredTool>;

export interface VideoAgentInvocationOptions {
  youtubeAuthorization?: YouTubeUploadAuthorization;
}

export interface VideoAgentRunResult extends RunResult {
  youtubeUploadRequested: boolean;
  youtubeUploadAuthorized: boolean;
}

export interface CreateVideoAgentRunnerOptions {
  runDirectory: string;
  stateStore?: VideoRunStateStore;
  frameworkDatabase?: LocalFrameworkDatabase;
  tools: VideoAgentTools;
  frameworkOptions?: Omit<DeepAgentRunnerOptions, 'extraTools' | 'systemPromptExtension'>;
  additionalSystemRules?: string;
}

export const EMPTY_FRAMEWORK_FINAL_TEXT = 'Task completed with no final text output.';
const MAX_NO_PROGRESS_AGENT_ATTEMPTS = 3;
const DEFAULT_PLANNING_RETRY_DELAY_MS = 5_000;
const MAX_PLANNING_RETRY_DELAY_MS = 30_000;

const TRANSIENT_PLANNING_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'BAD_GATEWAY',
  'GATEWAY_TIMEOUT',
  'INTERNAL_SERVER_ERROR',
  'SERVICE_UNAVAILABLE',
]);

function errorRecords(error: unknown): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length && records.length < 8) {
    const candidate = pending.shift();
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue;
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    records.push(record);
    if (record.cause) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
  return records;
}

function numericHttpStatus(record: Record<string, unknown>): number | undefined {
  for (const value of [
    record.status,
    record.statusCode,
    record.response && typeof record.response === 'object'
      ? (record.response as Record<string, unknown>).status
      : undefined,
  ]) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  }
  return undefined;
}

function planningErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
}

function isVideoPlanningAttemptsExhaustedError(error: unknown): boolean {
  return errorRecords(error).some((record) =>
    record.code === 'VIDEO_PLANNING_ATTEMPTS_EXHAUSTED'
    || record.name === 'VideoPlanningAttemptsExhaustedError');
}

/**
 * Keep this deliberately narrower than the framework's `/5\d\d/` matcher:
 * JSON validation errors often contain large byte positions with an arbitrary
 * `5xx` substring and must never be mistaken for transient HTTP failures.
 */
export function isRetryablePlanningProviderError(error: unknown): boolean {
  // The local planning circuit remains fatal even if an SDK or graph wrapper
  // gives its outer error a generic HTTP 500 status or message.
  if (isVideoPlanningAttemptsExhaustedError(error)) return false;

  const records = errorRecords(error);
  // An explicit HTTP status is more trustworthy than a provider's prose. In
  // particular, a 429 body may also say "service unavailable" while quota
  // rotation remains the framework's responsibility.
  for (const record of records) {
    const status = numericHttpStatus(record);
    if (status !== undefined) {
      return status === 408 || status === 425 || (status >= 500 && status <= 599);
    }
  }
  for (const record of records) {
    for (const value of [record.code, record.errno]) {
      if (
        typeof value === 'string'
        && TRANSIENT_PLANNING_ERROR_CODES.has(value.toUpperCase())
      ) return true;
    }
  }

  const messages = [planningErrorMessage(error), ...records.map((record) =>
    typeof record.message === 'string' ? record.message : '')].join(' | ');
  return /\b(?:internal server error|bad gateway|service unavailable|gateway timeout|fetch failed|socket hang up)\b/i.test(messages)
    || /\bHTTP\s+(?:500|501|502|503|504|505|506|507|508|509|510|511)\b/i.test(messages)
    || /\b(?:ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET))\b/i.test(messages)
    || /\b(?:network|connection|request)\s+(?:error|timed out|timeout)\b/i.test(messages);
}

function planningRetryDelayMs(customModel: boolean): number {
  if (customModel) return 0;
  const configured = Number(process.env.PROVIDER_RETRY_DELAY_MS ?? DEFAULT_PLANNING_RETRY_DELAY_MS);
  if (!Number.isFinite(configured)) return DEFAULT_PLANNING_RETRY_DELAY_MS;
  return Math.min(MAX_PLANNING_RETRY_DELAY_MS, Math.max(0, Math.trunc(configured)));
}

async function waitBeforePlanningRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function recoveredProviderUsed(
  provider: string | null | undefined,
  customModel: boolean,
): RunResult['providerUsed'] {
  if (customModel) return 'custom';
  if (
    provider === 'nvidia'
    || provider === 'anyapi'
    || provider === 'requesty'
    || provider === 'openrouter'
    || provider === 'huggingface'
  ) return provider;
  return 'nvidia';
}

export class VideoAgentNoProgressError extends Error {
  constructor(attempts: number) {
    super(
      `Planning did not create a video plan or durable media state within ${attempts} total attempt(s). `
      + 'No Agnes request was submitted. Retry the same prompt; the local run remains reusable.',
    );
    this.name = 'VideoAgentNoProgressError';
  }
}

export class VideoAgentTransientPlanningError extends Error {
  constructor(attempts: number, lastError: unknown) {
    super(
      `Planning did not produce durable video state within ${attempts} total attempt(s); the last attempt ended in a transient provider failure. `
      + `No Agnes request was submitted. Last provider error: ${planningErrorMessage(lastError)}. `
      + 'Retry the same prompt; the local run remains reusable.',
      { cause: lastError },
    );
    this.name = 'VideoAgentTransientPlanningError';
  }
}

export class VideoAgentUnsafePlanningRetryError extends Error {
  constructor(cause: unknown) {
    super(
      'The planning provider failed before a validated plan was available, but durable media state already exists. '
      + 'Automatic replanning was refused to avoid duplicating a provider submission.',
      { cause },
    );
    this.name = 'VideoAgentUnsafePlanningRetryError';
  }
}

export interface VideoAgentRunner {
  readonly state: VideoRunStateStore;
  run(originalPrompt: string, options?: VideoAgentInvocationOptions): Promise<VideoAgentRunResult>;
}

const YouTubeUploadAuthorizationSchema = z.object({
  approved: z.literal(true),
  promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  token: z.string().trim().min(16),
}).strict();

export class YouTubeUploadAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YouTubeUploadAuthorizationError';
  }
}

interface NamedAgentTool {
  name: string;
}

function looksLikeYouTubeUploadTool(tool: NamedAgentTool): boolean {
  const normalized = tool.name.toLowerCase();
  return normalized.includes('youtube')
    && (normalized.includes('upload') || normalized.includes('publish') || normalized.includes('post'));
}

function assertUniqueToolNames(tools: readonly NamedAgentTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate agent tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
}

type HostContinuationStage = 'video' | 'foley' | 'music' | 'assembly' | 'youtube';

interface HostToolOutcome {
  status: string;
}

const HOST_STAGE_READY_STATUSES: Readonly<Record<HostContinuationStage, ReadonlySet<string>>> = {
  video: new Set(['completed', 'reused', 'final_reused']),
  foley: new Set(['completed', 'reused', 'native_audio_selected', 'final_reused']),
  music: new Set(['completed', 'reused', 'recovered', 'skipped', 'final_reused']),
  assembly: new Set(['completed', 'reused', 'recovered', 'final_reused']),
  youtube: new Set(['completed', 'reused']),
};

function hostToolOutcome(value: unknown): HostToolOutcome {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { status: 'unrecognized' };
    }
  }
  if (!parsed || typeof parsed !== 'object') return { status: 'unrecognized' };
  const status = (parsed as { status?: unknown }).status;
  return { status: typeof status === 'string' ? status : 'unrecognized' };
}

async function invokeHostContinuationStage(
  stage: HostContinuationStage,
  tool: DynamicStructuredTool,
): Promise<boolean> {
  console.log(`[video-agent] ${JSON.stringify({
    event: 'host_workflow_stage_started',
    stage,
    tool: tool.name,
  })}`);
  const outcome = hostToolOutcome(await tool.invoke({} as never));
  const ready = HOST_STAGE_READY_STATUSES[stage].has(outcome.status);
  console.log(`[video-agent] ${JSON.stringify({
    event: 'host_workflow_stage_result',
    stage,
    tool: tool.name,
    status: outcome.status,
    readyForNextStage: ready,
  })}`);
  return ready;
}

/**
 * Plan creation is the only generative orchestration decision. Every later
 * tool reads the locked local plan/checkpoints and has empty input, so execute
 * those stages deterministically if the model ends early. Provider receipts
 * and each tool's per-invocation guard keep this continuation idempotent.
 */
async function continueValidatedVideoWorkflow(options: {
  plan: VideoPlan;
  generateVideo: DynamicStructuredTool;
  generateFoley: DynamicStructuredTool;
  generateMusic: DynamicStructuredTool;
  assembleVideo: DynamicStructuredTool;
  uploadVideo?: DynamicStructuredTool;
}): Promise<void> {
  console.log(`[video-agent] ${JSON.stringify({
    event: 'host_workflow_continuation_started',
    musicEnabled: options.plan.music.enabled,
    youtubeAuthorized: Boolean(options.uploadVideo),
  })}`);

  if (!await invokeHostContinuationStage('video', options.generateVideo)) return;
  if (!await invokeHostContinuationStage('foley', options.generateFoley)) return;
  if (
    options.plan.music.enabled
    && !await invokeHostContinuationStage('music', options.generateMusic)
  ) return;
  if (!await invokeHostContinuationStage('assembly', options.assembleVideo)) return;
  if (
    options.uploadVideo
    && !await invokeHostContinuationStage('youtube', options.uploadVideo)
  ) return;

  console.log(`[video-agent] ${JSON.stringify({
    event: 'host_workflow_continuation_completed',
    youtubeUploaded: Boolean(options.uploadVideo),
  })}`);
}

class DefaultVideoAgentRunner implements VideoAgentRunner {
  readonly state: VideoRunStateStore;
  readonly #frameworkDatabase: LocalFrameworkDatabase | undefined;

  constructor(private readonly options: CreateVideoAgentRunnerOptions) {
    this.state = options.stateStore ?? new VideoRunStateStore(options.runDirectory);
    this.#frameworkDatabase = options.frameworkDatabase;
    const callerTools = [
      options.tools.generateVideo,
      options.tools.generateFoley,
      options.tools.generateMusic,
      options.tools.assembleVideo,
      ...(options.tools.additionalTools ?? []),
    ];
    const hiddenUpload = callerTools.find(looksLikeYouTubeUploadTool);
    if (hiddenUpload) {
      throw new Error(
        `YouTube-like tool ${hiddenUpload.name} must be supplied through youtubeUploadToolFactory so runtime authorization cannot be bypassed.`,
      );
    }
    assertUniqueToolNames(callerTools);
  }

  async run(
    originalPrompt: string,
    invocationOptions: VideoAgentInvocationOptions = {},
  ): Promise<VideoAgentRunResult> {
    if (!originalPrompt.trim()) throw new Error('A non-empty video prompt is required.');

    const promptHash = this.state.promptHash(originalPrompt);
    const uploadRequested = promptExplicitlyRequestsYouTubeUpload(originalPrompt);
    let uploadTool: DynamicStructuredTool | undefined;

    if (invocationOptions.youtubeAuthorization) {
      const authorization = YouTubeUploadAuthorizationSchema.parse(invocationOptions.youtubeAuthorization);
      if (!uploadRequested) {
        throw new YouTubeUploadAuthorizationError(
          'YouTube authorization was supplied, but the original prompt does not explicitly request an upload.',
        );
      }
      if (authorization.promptHash !== promptHash) {
        throw new YouTubeUploadAuthorizationError(
          'YouTube authorization is bound to a different prompt hash.',
        );
      }
      if (!this.options.tools.youtubeUploadToolFactory) {
        throw new YouTubeUploadAuthorizationError(
          'YouTube authorization was supplied, but no authorized upload-tool factory is configured.',
        );
      }
      uploadTool = await this.options.tools.youtubeUploadToolFactory({
        originalPrompt,
        promptHash,
        authorization,
      });
      if (!looksLikeYouTubeUploadTool(uploadTool)) {
        throw new Error(
          `Authorized upload tool must have an unambiguous YouTube upload/publish name; received ${uploadTool.name}.`,
        );
      }
    }

    const validatePlanTool = this.options.tools.validatePlan;
    const mediaTools = [
      this.options.tools.generateVideo,
      this.options.tools.generateFoley,
      this.options.tools.generateMusic,
      this.options.tools.assembleVideo,
      ...(this.options.tools.additionalTools ?? []),
    ];
    const extraTools = [validatePlanTool, ...mediaTools, ...(uploadTool ? [uploadTool] : [])];
    assertUniqueToolNames(extraTools);

    const promptToolNames = {
      validatePlan: validatePlanTool.name,
      generateVideo: this.options.tools.generateVideo.name,
      generateMusic: this.options.tools.generateMusic.name,
      generateFoley: this.options.tools.generateFoley.name,
      assembleVideo: this.options.tools.assembleVideo.name,
      ...(uploadTool ? { youtubeUpload: uploadTool.name } : {}),
    };
    const systemPromptExtension = createVideoPlanningSystemPrompt({
      tools: promptToolNames,
      youtubeUploadRequested: uploadRequested,
      youtubeUploadAuthorized: Boolean(uploadTool),
      ...(this.options.additionalSystemRules ? { additionalRules: this.options.additionalSystemRules } : {}),
    });

    const frameworkDatabase = this.#frameworkDatabase
      ?? new LocalFrameworkDatabase(this.options.runDirectory, promptHash);
    ensureDeepAgentPlanningMiddleware();
    const planningAttemptBudget = createVideoPlanningAttemptBudget(systemPromptExtension);

    // LangGraph checkpoints are turn-local planning memory, not durable video
    // state. If a process is cancelled before it stores a plan or any media
    // receipt, resuming that partial transcript can repeatedly feed malformed
    // validator calls (and their large error payloads) back to the model. Start
    // the next invocation from a clean planning turn, while leaving every plan,
    // provider receipt, and media checkpoint untouched.
    const [entryPlan, entryMediaCheckpoints, existingFrameworkRun] = await Promise.all([
      this.state.loadPlan(originalPrompt),
      this.state.listCheckpoints(originalPrompt),
      frameworkDatabase.getRun(promptHash),
    ]);
    if (entryPlan) {
      console.log(`[video-agent] ${JSON.stringify({
        event: 'durable_plan_resume_started',
        promptHash,
        checkpointCount: entryMediaCheckpoints.length,
        planningModelSkipped: true,
      })}`);
      await continueValidatedVideoWorkflow({
        plan: entryPlan,
        generateVideo: this.options.tools.generateVideo,
        generateFoley: this.options.tools.generateFoley,
        generateMusic: this.options.tools.generateMusic,
        assembleVideo: this.options.tools.assembleVideo,
        ...(uploadTool ? { uploadVideo: uploadTool } : {}),
      });
      const finalText = 'A validated video plan was already stored, so the planning model was skipped. '
        + 'The host resumed the receipt-aware media workflow from durable local state.';
      if (existingFrameworkRun) {
        await frameworkDatabase.setFinalResult(promptHash, finalText);
      }
      return {
        promptHash,
        finalText,
        providerUsed: recoveredProviderUsed(
          existingFrameworkRun?.current_provider,
          Boolean(this.options.frameworkOptions?.model),
        ),
        youtubeUploadRequested: uploadRequested,
        youtubeUploadAuthorized: Boolean(uploadTool),
      };
    }
    if (!entryPlan && entryMediaCheckpoints.length === 0 && existingFrameworkRun) {
      const reason = 'A new invocation found no validated plan or media receipt; discarded the prior pre-media planning transcript.';
      const restart = await frameworkDatabase.restartPreMediaPlanningState(
        promptHash,
        existingFrameworkRun,
        reason,
        this.options.frameworkOptions?.model ? 'custom' : 'nvidia',
      );
      if (!restart.restarted) {
        throw new Error(
          'The pre-media planning state changed concurrently; refusing to discard a newer planning transcript.',
        );
      }
      const manifestReopened = await this.state.reopenFailedPlanning(originalPrompt);
      console.warn(`[video-agent] ${JSON.stringify({
        event: 'pre_media_planning_state_restarted',
        promptHash,
        previousStatus: existingFrameworkRun.status,
        manifestReopened,
        clearedTodos: restart.clearedTodos,
        clearedCheckpoints: restart.clearedCheckpoints,
        clearedWrites: restart.clearedWrites,
      })}`);
    }

    for (let attempt = 1; attempt <= MAX_NO_PROGRESS_AGENT_ATTEMPTS; attempt += 1) {
      const recoveryRule = attempt === 1
        ? ''
        : '\nA prior planning-model attempt produced no durable video work. This is a recovery attempt: create and validate the compact video plan immediately.';
      const runner = new DeepAgentRunner(frameworkDatabase.asDatabaseClient(), {
        ...(this.options.frameworkOptions ?? {}),
        // The tool schema generic is invariant across this concrete union and the
        // framework option type; the runtime DynamicStructuredTool API is shared.
        extraTools: extraTools as unknown as NonNullable<DeepAgentRunnerOptions['extraTools']>,
        systemPromptExtension: `${systemPromptExtension}${recoveryRule}`,
      });
      scopeFrameworkFilesystemToRunDirectory(runner, this.options.runDirectory);
      let result: RunResult;
      try {
        result = await withVideoPlanningAttemptBudget(
          planningAttemptBudget,
          async () => await runner.run(originalPrompt),
        );
      } catch (error) {
        const planningAttemptsExhausted = error instanceof VideoPlanningAttemptsExhaustedError
          || isVideoPlanningAttemptsExhaustedError(error);
        if (planningAttemptsExhausted || !isRetryablePlanningProviderError(error)) {
          const [fatalPlan, fatalCheckpoints] = await Promise.all([
            this.state.loadPlan(originalPrompt),
            this.state.listCheckpoints(originalPrompt),
          ]);
          if (!fatalPlan && fatalCheckpoints.length === 0) {
            await this.state.updateStatus(originalPrompt, 'failed');
          }
          throw error;
        }

        const errorMessage = planningErrorMessage(error);
        const [plan, checkpoints, failedFrameworkRun] = await Promise.all([
          this.state.loadPlan(originalPrompt),
          this.state.listCheckpoints(originalPrompt),
          frameworkDatabase.getRun(promptHash),
        ]);
        if (!failedFrameworkRun?.updated_at) {
          throw new Error(
            'The planning provider failed before the framework persisted a recoverable run revision.',
            { cause: error },
          );
        }

        // A model/server failure after validation must not restart planning or
        // resubmit Agnes. The local plan plus receipt-aware tools are the source
        // of truth, so advance the deterministic workflow exactly once.
        if (plan) {
          console.warn(`[video-agent] ${JSON.stringify({
            event: 'agent_transient_error_recovered_from_durable_state',
            attempt,
            maxAttempts: MAX_NO_PROGRESS_AGENT_ATTEMPTS,
            provider: failedFrameworkRun?.current_provider ?? 'unknown',
            checkpointCount: checkpoints.length,
            error: errorMessage.slice(0, 240),
          })}`);
          await continueValidatedVideoWorkflow({
            plan,
            generateVideo: this.options.tools.generateVideo,
            generateFoley: this.options.tools.generateFoley,
            generateMusic: this.options.tools.generateMusic,
            assembleVideo: this.options.tools.assembleVideo,
            ...(uploadTool ? { uploadVideo: uploadTool } : {}),
          });

          const finalText = 'The planning provider returned a transient error after the video plan was saved. '
            + 'The host resumed the receipt-aware media workflow from durable local state; see the saved run status below.';
          const recovered = await frameworkDatabase.completeRetryableFailureFromDurableState(
            promptHash,
            errorMessage,
            failedFrameworkRun.updated_at,
            finalText,
          );
          if (!recovered) {
            throw new Error(
              'The transient agent failure changed concurrently; refusing to overwrite newer framework state.',
              { cause: error },
            );
          }
          return {
            promptHash,
            finalText,
            providerUsed: recoveredProviderUsed(
              failedFrameworkRun?.current_provider,
              Boolean(this.options.frameworkOptions?.model),
            ),
            youtubeUploadRequested: uploadRequested,
            youtubeUploadAuthorized: Boolean(uploadTool),
          };
        }

        if (checkpoints.length > 0) {
          console.error(`[video-agent] ${JSON.stringify({
            event: 'agent_transient_error_retry_refused',
            attempt,
            provider: failedFrameworkRun?.current_provider ?? 'unknown',
            checkpointCount: checkpoints.length,
            reason: 'media_checkpoint_exists_without_validated_plan',
          })}`);
          throw new VideoAgentUnsafePlanningRetryError(error);
        }

        const retryReason = 'Transient planning-provider failure before a validated plan; restarting only the agent planning graph.';
        const canRetry = attempt < MAX_NO_PROGRESS_AGENT_ATTEMPTS;
        console.warn(`[video-agent] ${JSON.stringify({
          event: canRetry ? 'agent_transient_error_retry' : 'agent_transient_error_exhausted',
          attempt,
          maxAttempts: MAX_NO_PROGRESS_AGENT_ATTEMPTS,
          provider: failedFrameworkRun?.current_provider ?? 'unknown',
          retryDelayMs: canRetry
            ? planningRetryDelayMs(Boolean(this.options.frameworkOptions?.model))
            : 0,
          planStored: false,
          checkpointCount: 0,
          error: errorMessage.slice(0, 240),
        })}`);

        if (!canRetry) {
          await this.state.updateStatus(originalPrompt, 'failed');
          throw new VideoAgentTransientPlanningError(MAX_NO_PROGRESS_AGENT_ATTEMPTS, error);
        }

        const reopened = await frameworkDatabase.reopenRetryableFailure(
          promptHash,
          errorMessage,
          failedFrameworkRun.updated_at,
          retryReason,
        );
        if (!reopened) {
          throw new Error(
            'The transient agent failure changed concurrently; refusing to overwrite newer framework state.',
            { cause: error },
          );
        }
        await waitBeforePlanningRetry(
          planningRetryDelayMs(Boolean(this.options.frameworkOptions?.model)),
        );
        continue;
      }
      const plan = await this.state.loadPlan(originalPrompt);
      if (plan) {
        await continueValidatedVideoWorkflow({
          plan,
          generateVideo: this.options.tools.generateVideo,
          generateFoley: this.options.tools.generateFoley,
          generateMusic: this.options.tools.generateMusic,
          assembleVideo: this.options.tools.assembleVideo,
          ...(uploadTool ? { uploadVideo: uploadTool } : {}),
        });
      }
      const checkpoints = await this.state.listCheckpoints(originalPrompt);
      const noDurableProgress = !plan && checkpoints.length === 0;
      const emptyFrameworkCompletion = !result.finalText.trim()
        || result.finalText.trim() === EMPTY_FRAMEWORK_FINAL_TEXT;

      // Once a plan or media receipt exists, the deterministic continuation
      // above has advanced every currently runnable stage. Return control to
      // the CLI so it can report pending/failure/final state without retrying
      // a media action past its one-attempt-per-invocation guard.
      if (!noDurableProgress) {
        return {
          ...result,
          finalText: emptyFrameworkCompletion
            ? 'The video workflow made durable progress; see the saved run status below.'
            : result.finalText,
          youtubeUploadRequested: uploadRequested,
          youtubeUploadAuthorized: Boolean(uploadTool),
        };
      }

      const reason = 'The agent returned without creating a validated video plan or any media checkpoint.';
      const reopened = await frameworkDatabase.reopenRejectedCompletion(
        promptHash,
        result.finalText,
        reason,
      );
      if (!reopened) {
        throw new Error(
          'The rejected agent completion changed concurrently; refusing to overwrite newer framework state.',
        );
      }

      console.warn(`[video-agent] ${JSON.stringify({
        event: attempt < MAX_NO_PROGRESS_AGENT_ATTEMPTS
          ? 'agent_no_progress_retry'
          : 'agent_no_progress_exhausted',
        attempt,
        maxAttempts: MAX_NO_PROGRESS_AGENT_ATTEMPTS,
        provider: result.providerUsed,
        planStored: Boolean(plan),
        checkpointCount: checkpoints.length,
        emptyFinalText: emptyFrameworkCompletion,
        reason,
      })}`);

      if (attempt === MAX_NO_PROGRESS_AGENT_ATTEMPTS) {
        await frameworkDatabase.updateRunStatus(promptHash, 'failed', reason);
        await this.state.updateStatus(originalPrompt, 'failed');
        throw new VideoAgentNoProgressError(MAX_NO_PROGRESS_AGENT_ATTEMPTS);
      }
    }

    throw new VideoAgentNoProgressError(MAX_NO_PROGRESS_AGENT_ATTEMPTS);
  }
}

export function createVideoAgentRunner(options: CreateVideoAgentRunnerOptions): VideoAgentRunner {
  return new DefaultVideoAgentRunner(options);
}

export async function createBootstrappedVideoAgentRunner(
  options: CreateVideoAgentRunnerOptions,
): Promise<VideoAgentRunner> {
  return createVideoAgentRunner(options);
}
