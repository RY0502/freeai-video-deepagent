import path from "node:path";
import { pathToFileURL } from "node:url";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { AgnesVideoClient } from "./agnes/index.js";
import {
  createBootstrappedVideoAgentRunner,
  planUsesBackgroundMusic,
  promptExplicitlyRequestsYouTubeUpload,
  type VideoPlan,
  type YouTubeUploadAuthorization,
} from "./agent/index.js";
import { bindYouTubeUploadAuthorization } from "./authorization.js";
import { CLI_HELP, parseCliArgs } from "./cli-args.js";
import { assertYouTubeConfig, loadConfig } from "./config.js";
import { ElevenLabsClient } from "./elevenlabs/index.js";
import { FREE_AI_MUSIC_MODEL, FreeAiMusicClient } from "./freeai/index.js";
import { SOURCE_AUDIO_INSPECTION_REVISION } from "./media/index.js";
import { reconcileDueMediaCheckpoints } from "./reconcile.js";
import { createLocalRunIndex, loadLocalRunIndex } from "./run-index.js";
import { pauseVmBeforeExit } from "./pause.js";
import {
  VideoRunStateStore,
  videoCheckpointKeys,
  type ArtifactCheckpoint,
  type VideoCheckpointKey,
} from "./state/index.js";
import {
  VIDEO_TOOL_NAMES,
  cleanupValidatedRunArtifacts,
  completedArtifactIsValid,
  createUploadAuthorizationToken,
  createVideoAgentTools,
  foleyMixRevisionIsCurrent,
  musicSnapshotEvent,
  nativeSourceAudioSelectionIsCurrent,
  optionalMusicWasOmitted,
  resolveGenerationConfiguration,
  resolvePromptPreferencesForConfig,
  SOURCE_AUDIO_ANALYSIS_MODEL,
  validateCompletedFinalVideoForState,
  videoSnapshotEvent,
  type VideoAgentEvent,
  type VideoToolBundle,
} from "./tools/videoAgentTools.js";
import {
  FOLEY_RECONCILIATION_MODEL,
  FOLEY_RECONCILIATION_REVISION,
} from "./vision/index.js";
import {
  applyYouTubeOAuthTokens,
  createYouTubeOAuthClient,
  createYouTubeUploader,
} from "./youtube/index.js";

function requireTool(bundle: VideoToolBundle, name: string): DynamicStructuredTool {
  const tool = bundle.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Video tool was not created: ${name}`);
  return tool;
}

function logVideoAgentEvent(event: VideoAgentEvent): void {
  console.log(`[video-agent] ${JSON.stringify(event)}`);
}

/** Secret-safe checkpoint view for terminal status output. */
export function publicCheckpoint(checkpoint: ArtifactCheckpoint | null | undefined): unknown {
  if (!checkpoint) return null;
  const keyLabel = typeof checkpoint.details?.keyLabel === "string"
    && /^key-\d+$/.test(checkpoint.details.keyLabel)
    ? checkpoint.details.keyLabel
    : undefined;
  const progress = typeof checkpoint.details?.progress === "number"
    ? checkpoint.details.progress
    : undefined;
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
    } : keyLabel ? { keyLabel } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(checkpoint.retryAt ? { retryAt: checkpoint.retryAt } : {}),
    ...(checkpoint.retrySafe !== undefined ? { retrySafe: checkpoint.retrySafe } : {}),
    ...(checkpoint.error ? { error: checkpoint.error } : {}),
    ...(checkpoint.provider === "youtube" && checkpoint.url ? { url: checkpoint.url } : {}),
    startedAt: checkpoint.startedAt,
    updatedAt: checkpoint.updatedAt,
  };
}

/** Fail closed after any upload that may already exist remotely. */
export function youtubeUploadRequiresManualReconciliation(
  checkpoint: ArtifactCheckpoint | null | undefined,
): boolean {
  return Boolean(checkpoint && (
    checkpoint.status === "in_progress"
    || checkpoint.status === "unknown"
    || (checkpoint.status === "failed" && checkpoint.retrySafe === false)
    || (checkpoint.status === "completed" && !checkpoint.externalId)
  ));
}

export type RequiredMediaWaitReason =
  | "provider_pending"
  | "deferred_not_due"
  | "retryable_failure_after_reconciliation"
  | "retry_unsafe_failure"
  | "ambiguous_submission";

export interface RequiredMediaWait {
  key: VideoCheckpointKey;
  status: ArtifactCheckpoint["status"];
  reason: RequiredMediaWaitReason;
  retryAt?: string;
}

export interface RequiredMediaInspection {
  shouldShortCircuit: boolean;
  assemblyCanRun: boolean;
  requiredKeys: VideoCheckpointKey[];
  readyKeys: VideoCheckpointKey[];
  omittedKeys: VideoCheckpointKey[];
  waiting: RequiredMediaWait[];
  missingKeys: VideoCheckpointKey[];
  actionableKeys: VideoCheckpointKey[];
}

function requiredMediaKeys(plan: VideoPlan): VideoCheckpointKey[] {
  return [
    videoCheckpointKeys.sourceVideo,
    videoCheckpointKeys.foley,
    ...(planUsesBackgroundMusic(plan) ? [videoCheckpointKeys.music] : []),
  ];
}

function requiredMediaWait(
  key: VideoCheckpointKey,
  checkpoint: ArtifactCheckpoint,
  now: Date,
): RequiredMediaWait | null {
  if (checkpoint.status === "queued" || (checkpoint.status === "in_progress" && checkpoint.providerJob)) {
    return { key, status: checkpoint.status, reason: "provider_pending" };
  }
  if (
    checkpoint.status === "deferred"
    && checkpoint.retryAt
    && Date.parse(checkpoint.retryAt) > now.getTime()
  ) return { key, status: checkpoint.status, reason: "deferred_not_due", retryAt: checkpoint.retryAt };
  if (checkpoint.status === "unknown") {
    return { key, status: checkpoint.status, reason: "ambiguous_submission" };
  }
  if (checkpoint.status === "failed") {
    return {
      key,
      status: checkpoint.status,
      reason: checkpoint.retrySafe === false
        ? "retry_unsafe_failure"
        : "retryable_failure_after_reconciliation",
    };
  }
  return null;
}

async function foregroundAudioIsReady(options: {
  source: ArtifactCheckpoint | null | undefined;
  selection: ArtifactCheckpoint;
  loadCheckpoint: (
    key: VideoCheckpointKey,
  ) => ArtifactCheckpoint | null | Promise<ArtifactCheckpoint | null>;
  validateCompletedArtifact: (
    checkpoint: ArtifactCheckpoint,
  ) => boolean | Promise<boolean>;
}): Promise<boolean> {
  const { source, selection, loadCheckpoint, validateCompletedArtifact } = options;
  if (source?.status !== "completed" || !source.sha256) return false;
  const analysis = await loadCheckpoint(videoCheckpointKeys.sourceAudioAnalysis);
  if (
    analysis?.status !== "completed"
    || !analysis.sha256
    || analysis.provider !== "local"
    || analysis.model !== SOURCE_AUDIO_ANALYSIS_MODEL
    || analysis.details?.inspectionRevision !== SOURCE_AUDIO_INSPECTION_REVISION
    || analysis.details?.sourceVideoSha256 !== source.sha256
    || typeof analysis.details?.usable !== "boolean"
    || !await validateCompletedArtifact(analysis)
  ) return false;

  const dependencies = {
    sourceVideoSha256: source.sha256,
    sourceAudioAnalysisSha256: analysis.sha256,
  };
  if (analysis.details.usable) {
    return nativeSourceAudioSelectionIsCurrent(selection, dependencies);
  }
  const foleyAnalysis = await loadCheckpoint(videoCheckpointKeys.foleyAnalysis);
  return selection.status === "completed"
    && foleyMixRevisionIsCurrent(selection)
    && selection.details?.sourceVideoSha256 === dependencies.sourceVideoSha256
    && selection.details?.sourceAudioAnalysisSha256
      === dependencies.sourceAudioAnalysisSha256
    && foleyAnalysis?.status === "completed"
    && foleyAnalysis.sha256 === selection.details?.foleyReconciliationSha256
    && foleyAnalysis.provider === "vision-orchestrator+ffmpeg"
    && foleyAnalysis.model === FOLEY_RECONCILIATION_MODEL
    && foleyAnalysis.details?.reconciliationRevision === FOLEY_RECONCILIATION_REVISION
    && foleyAnalysis.details?.sourceVideoSha256 === dependencies.sourceVideoSha256
    && await validateCompletedArtifact(foleyAnalysis)
    && await validateCompletedArtifact(selection);
}

export async function inspectRequiredMediaForShortCircuit(options: {
  plan: VideoPlan;
  loadCheckpoint: (
    key: VideoCheckpointKey,
  ) => ArtifactCheckpoint | null | Promise<ArtifactCheckpoint | null>;
  validateCompletedArtifact?: (
    checkpoint: ArtifactCheckpoint,
  ) => boolean | Promise<boolean>;
  now?: Date;
}): Promise<RequiredMediaInspection> {
  const requiredKeys = requiredMediaKeys(options.plan);
  const now = options.now ?? new Date();
  const validateCompletedArtifact = options.validateCompletedArtifact ?? completedArtifactIsValid;
  const readyKeys: VideoCheckpointKey[] = [];
  const omittedKeys: VideoCheckpointKey[] = [];
  const waiting: RequiredMediaWait[] = [];
  const missingKeys: VideoCheckpointKey[] = [];
  const actionableKeys: VideoCheckpointKey[] = [];
  let sourceBlocksDownstream = false;
  let sourceCheckpoint: ArtifactCheckpoint | null = null;

  for (const key of requiredKeys) {
    if (key !== videoCheckpointKeys.sourceVideo && sourceBlocksDownstream) continue;
    const checkpoint = await options.loadCheckpoint(key);
    if (key === videoCheckpointKeys.sourceVideo) sourceCheckpoint = checkpoint;
    if (!checkpoint) {
      missingKeys.push(key);
      actionableKeys.push(key);
      continue;
    }
    if (key === videoCheckpointKeys.music && optionalMusicWasOmitted(checkpoint)) {
      omittedKeys.push(key);
      continue;
    }
    if (checkpoint.status === "completed" || key === videoCheckpointKeys.foley) {
      const artifactIsReady = key === videoCheckpointKeys.music
        ? checkpoint.provider === "free.ai"
          && checkpoint.model === FREE_AI_MUSIC_MODEL
          && await validateCompletedArtifact(checkpoint)
        : key === videoCheckpointKeys.foley
          ? await foregroundAudioIsReady({
              source: sourceCheckpoint,
              selection: checkpoint,
              loadCheckpoint: options.loadCheckpoint,
              validateCompletedArtifact,
            })
          : await validateCompletedArtifact(checkpoint);
      if (artifactIsReady) {
        readyKeys.push(key);
        continue;
      }
    }
    const wait = requiredMediaWait(key, checkpoint, now);
    if (wait) {
      waiting.push(wait);
      if (key === videoCheckpointKeys.sourceVideo) sourceBlocksDownstream = true;
    }
    else actionableKeys.push(key);
  }

  const assemblyCanRun = readyKeys.length + omittedKeys.length === requiredKeys.length;
  return {
    shouldShortCircuit: !assemblyCanRun
      && missingKeys.length === 0
      && actionableKeys.length === 0
      && waiting.length > 0,
    assemblyCanRun,
    requiredKeys,
    readyKeys,
    omittedKeys,
    waiting,
    missingKeys,
    actionableKeys,
  };
}

async function printStatus(
  state: VideoRunStateStore,
  originalPrompt: string,
  runDirectory: string,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const manifest = await state.loadManifest(originalPrompt) ?? await state.ensureManifest(originalPrompt);
  const plan = await state.loadPlan(originalPrompt);
  const checkpoints = await state.listCheckpoints(originalPrompt);
  const byKey = Object.fromEntries(checkpoints.map(({ key, value }) => [key, value]));
  const source = byKey[videoCheckpointKeys.sourceVideo];
  const sourceEvent = await videoSnapshotEvent(source);
  if (sourceEvent) logVideoAgentEvent(sourceEvent);
  const music = byKey[videoCheckpointKeys.music];
  const musicEvent = await musicSnapshotEvent(music);
  if (musicEvent) logVideoAgentEvent(musicEvent);
  console.log(JSON.stringify({
    runId: state.runId(originalPrompt),
    runDirectory,
    status: manifest.status,
    planStored: Boolean(plan),
    youtubeUploadRequested: manifest.youtubeUploadRequested,
    requestedConfiguration: resolvePromptPreferencesForConfig(originalPrompt, config),
    resolvedConfiguration: plan
      ? resolveGenerationConfiguration(plan, originalPrompt, config)
      : null,
    video: publicCheckpoint(source),
    sourceAudioAnalysis: publicCheckpoint(byKey[videoCheckpointKeys.sourceAudioAnalysis]),
    sourceAudio: byKey[videoCheckpointKeys.sourceAudioAnalysis]
      ? {
          usable: byKey[videoCheckpointKeys.sourceAudioAnalysis]?.details?.usable ?? null,
          hasAudioStream: byKey[videoCheckpointKeys.sourceAudioAnalysis]?.details?.hasAudioStream ?? null,
          activeDurationSeconds:
            byKey[videoCheckpointKeys.sourceAudioAnalysis]?.details?.activeDurationSeconds ?? null,
          peakVolumeDbfs: byKey[videoCheckpointKeys.sourceAudioAnalysis]?.details?.peakVolumeDbfs ?? null,
          meanVolumeDbfs: byKey[videoCheckpointKeys.sourceAudioAnalysis]?.details?.meanVolumeDbfs ?? null,
          reason: byKey[videoCheckpointKeys.sourceAudioAnalysis]?.details?.reason ?? null,
        }
      : null,
    foleyAnalysis: publicCheckpoint(byKey[videoCheckpointKeys.foleyAnalysis]),
    foley: publicCheckpoint(byKey[videoCheckpointKeys.foley]),
    musicRequested: plan ? planUsesBackgroundMusic(plan) : null,
    musicRequired: plan ? planUsesBackgroundMusic(plan) && !optionalMusicWasOmitted(music) : null,
    musicIncluded: plan
      ? Boolean(music?.status === "completed" && music.provider === "free.ai" && music.model === FREE_AI_MUSIC_MODEL)
      : null,
    musicOmitted: plan ? optionalMusicWasOmitted(music) : null,
    music: publicCheckpoint(music),
    assembly: publicCheckpoint(byKey[videoCheckpointKeys.assembly]),
    youtube: publicCheckpoint(byKey[videoCheckpointKeys.youtubeUpload]),
  }, null, 2));
}

async function createYouTubeRuntime(
  enabledForPrompt: boolean,
  config: ReturnType<typeof loadConfig>,
) {
  if (!enabledForPrompt || !config.YOUTUBE_UPLOAD_ENABLED) return undefined;
  assertYouTubeConfig(config);
  const authorizationToken = createUploadAuthorizationToken();
  const oauth = createYouTubeOAuthClient({
    clientId: config.YOUTUBE_CLIENT_ID,
    clientSecret: config.YOUTUBE_CLIENT_SECRET,
    redirectUri: config.YOUTUBE_REDIRECT_URI,
  });
  applyYouTubeOAuthTokens(oauth, { refresh_token: config.YOUTUBE_REFRESH_TOKEN });
  const uploader = createYouTubeUploader({
    enabled: true,
    requiredAuthorizationToken: authorizationToken,
    auth: oauth,
    defaultPrivacyStatus: config.YOUTUBE_DEFAULT_PRIVACY,
  });
  return { authorizationToken, uploader };
}

/**
 * Deterministically finish an explicitly requested and host-authorized upload
 * once the validated final MP4 exists. This is a backstop for agent tool
 * selection; the tool itself still enforces the prompt-bound capability.
 */
async function uploadCompletedVideoIfReady(options: {
  uploadTool: DynamicStructuredTool;
  state: VideoRunStateStore;
  originalPrompt: string;
  config: ReturnType<typeof loadConfig>;
}): Promise<boolean> {
  const plan = await options.state.loadPlan(options.originalPrompt);
  if (!plan?.youtubeUpload?.requested) return false;
  let existing = await options.state.loadCheckpoint(
    options.originalPrompt,
    videoCheckpointKeys.youtubeUpload,
  );
  if (existing?.status === "completed" && existing.externalId) return true;
  if (existing?.status === "in_progress") {
    const reason = "A previous YouTube upload was interrupted after it started; whether YouTube accepted it is unknown.";
    existing = await options.state.markUnknown(
      options.originalPrompt,
      videoCheckpointKeys.youtubeUpload,
      reason,
      { details: { ambiguousUploadOutcome: true, manualReconciliationRequired: true } },
    );
    await options.state.updateStatus(options.originalPrompt, "failed");
  }
  if (youtubeUploadRequiresManualReconciliation(existing)) {
    throw new Error(
      `${existing?.error ?? "The previous YouTube upload outcome is ambiguous."} `
      + "Automatic upload is blocked to prevent a duplicate; check YouTube Studio and reconcile the local checkpoint manually.",
    );
  }
  const assembly = await options.state.loadCheckpoint(
    options.originalPrompt,
    videoCheckpointKeys.assembly,
  );
  if (!assembly || !await validateCompletedFinalVideoForState(
    assembly,
    options.state,
    options.config,
    plan,
    options.originalPrompt,
  )) return false;

  console.log("Final MP4 is validated; completing the explicitly requested YouTube upload.");
  await options.uploadTool.invoke({});
  const completed = await options.state.loadCheckpoint(
    options.originalPrompt,
    videoCheckpointKeys.youtubeUpload,
  );
  if (completed?.status !== "completed" || !completed.externalId) {
    throw new Error("The authorized YouTube upload tool returned without a completed upload receipt.");
  }
  return true;
}

/** Ensure an agent cannot stop after optional music fallback without assembly. */
async function assembleCompletedVideoIfReady(options: {
  assembleTool: DynamicStructuredTool;
  state: VideoRunStateStore;
  originalPrompt: string;
  config: ReturnType<typeof loadConfig>;
}): Promise<boolean> {
  const plan = await options.state.loadPlan(options.originalPrompt);
  if (!plan) return false;
  const existing = await options.state.loadCheckpoint(
    options.originalPrompt,
    videoCheckpointKeys.assembly,
  );
  if (existing && await validateCompletedFinalVideoForState(
    existing,
    options.state,
    options.config,
    plan,
    options.originalPrompt,
  )) return true;

  const inspection = await inspectRequiredMediaForShortCircuit({
    plan,
    loadCheckpoint: async (key) => await options.state.loadCheckpoint(options.originalPrompt, key),
  });
  if (!inspection.assemblyCanRun) return false;

  console.log("All required media is ready; completing final assembly from durable checkpoints.");
  await options.assembleTool.invoke({});
  const completed = await options.state.loadCheckpoint(
    options.originalPrompt,
    videoCheckpointKeys.assembly,
  );
  if (!completed || !await validateCompletedFinalVideoForState(
    completed,
    options.state,
    options.config,
    plan,
    options.originalPrompt,
  )) {
    throw new Error("The assembly tool returned without a validated final MP4 checkpoint.");
  }
  return true;
}

async function main(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2));
  if (command.kind === "help") {
    console.log(CLI_HELP);
    return;
  }

  const config = loadConfig();
  const outputRoot = path.resolve(config.VIDEO_OUTPUT_ROOT);
  const boundRunPrompt = command.kind === "run"
    ? bindYouTubeUploadAuthorization(command.prompt, command.youtubeUploadRequested)
    : null;
  const localRun = command.kind === "run"
    ? await createLocalRunIndex(outputRoot, boundRunPrompt as string)
    : await loadLocalRunIndex(outputRoot, command.runId);
  const originalPrompt = boundRunPrompt ?? localRun.originalPrompt;
  const runDirectory = localRun.runDirectory;
  const state = new VideoRunStateStore(runDirectory);

  if (command.kind === "status") {
    await printStatus(state, originalPrompt, runDirectory, config);
    return;
  }

  console.log(`${command.kind === "resume" ? "Resuming" : "Started"} run: ${localRun.runId}`);

  let manifest = await state.ensureManifest(originalPrompt);
    const promptPreferences = resolvePromptPreferencesForConfig(originalPrompt, config);
    const storedPlan = await state.loadPlan(originalPrompt);
    logVideoAgentEvent({
      event: "generation_configuration",
      phase: storedPlan ? "plan_reused" : "prompt_resolved",
      configuration: (storedPlan
        ? resolveGenerationConfiguration(storedPlan, originalPrompt, config)
        : promptPreferences) as unknown as Record<string, unknown>,
    });

    const completedAssembly = await state.loadCheckpoint(originalPrompt, videoCheckpointKeys.assembly);
    if (completedAssembly && await validateCompletedFinalVideoForState(
      completedAssembly,
      state,
      config,
      storedPlan,
      originalPrompt,
    )) {
      const cleanup = await cleanupValidatedRunArtifacts({
        requested: promptPreferences.cleanupAfterSuccess,
        runDirectory,
        retainedFinalPath: completedAssembly.path as string,
        originalPrompt,
        compactReceipts: async () => await state.compactCompletedArtifacts(originalPrompt),
      });
      logVideoAgentEvent({
        event: "artifact_cleanup",
        requested: cleanup.requested,
        performed: cleanup.performed,
        retention: cleanup.retention,
        reason: cleanup.reason,
      });
      const youtubeCheckpoint = await state.loadCheckpoint(originalPrompt, videoCheckpointKeys.youtubeUpload);
      if (youtubeUploadRequiresManualReconciliation(youtubeCheckpoint)) {
        if (youtubeCheckpoint?.status === "in_progress") {
          await state.markUnknown(
            originalPrompt,
            videoCheckpointKeys.youtubeUpload,
            "A previous YouTube upload was interrupted after it started; whether YouTube accepted it is unknown.",
            { details: { ambiguousUploadOutcome: true, manualReconciliationRequired: true } },
          );
        }
        await state.updateStatus(originalPrompt, "failed");
        await printStatus(state, originalPrompt, runDirectory, config);
        throw new Error(
          `${youtubeCheckpoint?.error ?? "The previous YouTube upload outcome is ambiguous."} `
          + "Check YouTube Studio and reconcile the local checkpoint manually; automatic upload is blocked to prevent a duplicate.",
        );
      }
      const uploadStillNeeded = manifest.youtubeUploadRequested
        && youtubeCheckpoint?.status !== "completed"
        && config.YOUTUBE_UPLOAD_ENABLED;
      if (!uploadStillNeeded) {
        console.log(`Final video already completed: ${completedAssembly.path}`);
        if (manifest.youtubeUploadRequested && youtubeCheckpoint?.status !== "completed") {
          console.log("YouTube upload remains pending: enable and configure YouTube OAuth, then resume.");
        }
        await printStatus(state, originalPrompt, runDirectory, config);
        return;
      }
    }

    const uploadRequested = promptExplicitlyRequestsYouTubeUpload(originalPrompt);
    const youtube = await createYouTubeRuntime(uploadRequested, config);
    const agnes = new AgnesVideoClient({
      baseUrl: config.AGNES_BASE_URL,
      requestTimeoutMs: config.AGNES_REQUEST_TIMEOUT_MS,
      pollIntervalMs: config.AGNES_POLL_INTERVAL_MS,
      pollWindowMs: config.AGNES_POLL_WINDOW_MS,
      maxDownloadBytes: config.AGNES_MAX_DOWNLOAD_BYTES,
    });
    const elevenLabs = new ElevenLabsClient({
      baseUrl: config.ELEVENLABS_BASE_URL,
      requestTimeoutMs: config.ELEVENLABS_REQUEST_TIMEOUT_MS,
    });
    const freeAiMusic = new FreeAiMusicClient({
      baseUrl: config.FREE_AI_BASE_URL,
      requestTimeoutMs: config.FREE_AI_REQUEST_TIMEOUT_MS,
      retryDelayMs: config.FREE_AI_RETRY_DELAY_MS,
      maxDownloadBytes: config.FREE_AI_MUSIC_MAX_DOWNLOAD_BYTES,
    });
    const bundle = createVideoAgentTools({
      originalPrompt,
      runDirectory,
      config,
      stateStore: state,
      agnes,
      elevenLabs,
      freeAiMusic,
      onEvent: logVideoAgentEvent,
      ...(youtube ? { youtube } : {}),
    });

    const statusTool = requireTool(bundle, VIDEO_TOOL_NAMES.status);
    const uploadTool = youtube
      ? requireTool(bundle, VIDEO_TOOL_NAMES.youtubeUpload)
      : undefined;
    if (uploadTool && await uploadCompletedVideoIfReady({
      uploadTool,
      state,
      originalPrompt,
      config,
    })) {
      console.log("YouTube upload completed or reused from its durable receipt.");
      await printStatus(state, originalPrompt, runDirectory, config);
      return;
    }
    const reconciliation = await reconcileDueMediaCheckpoints({
      stateStore: state,
      originalPrompt,
      tools: {
        generateVideo: requireTool(bundle, VIDEO_TOOL_NAMES.generateVideo),
        generateFoley: requireTool(bundle, VIDEO_TOOL_NAMES.generateFoley),
        generateMusic: requireTool(bundle, VIDEO_TOOL_NAMES.generateMusic),
      },
    });
    if (reconciliation.length) {
      console.log(`Reconciled ${reconciliation.length} durable media checkpoint(s).`);
    }
    const interruption = reconciliation.find(({ stopsInvocation }) => stopsInvocation);
    if (interruption?.pendingReason) {
      await state.updateStatus(originalPrompt, "pending");
      console.log(`${interruption.pendingReason} The accepted task remains saved; resume with: npm run dev -- --resume ${localRun.runId}`);
      await printStatus(state, originalPrompt, runDirectory, config);
      return;
    }
    if (interruption?.failureReason) {
      await state.updateStatus(originalPrompt, "failed");
      await printStatus(state, originalPrompt, runDirectory, config);
      throw new Error(interruption.failureReason);
    }

    // A local mix-revision change can make the final MP4 stale while every
    // retained provider artifact is still valid. Finish that deterministic
    // assembly immediately instead of spending an LLM call rediscovering the
    // same ready state.
    if (await assembleCompletedVideoIfReady({
      assembleTool: requireTool(bundle, VIDEO_TOOL_NAMES.assembleVideo),
      state,
      originalPrompt,
      config,
    })) {
      if (uploadTool) {
        const uploaded = await uploadCompletedVideoIfReady({
          uploadTool,
          state,
          originalPrompt,
          config,
        });
        if (uploaded) console.log("YouTube upload completed or reused from its durable receipt.");
      }
      await printStatus(state, originalPrompt, runDirectory, config);
      return;
    }

    manifest = await state.loadManifest(originalPrompt) ?? manifest;
    if (storedPlan && manifest.status === "failed") await state.updateStatus(originalPrompt, "generating");
    if (storedPlan) {
      const inspection = await inspectRequiredMediaForShortCircuit({
        plan: storedPlan,
        loadCheckpoint: async (key) => await state.loadCheckpoint(originalPrompt, key),
      });
      if (inspection.shouldShortCircuit) {
        const waitingKeys = inspection.waiting.map(({ key }) => key).join(", ");
        console.log(`Required media remains waiting or blocked (${waitingKeys}); no new provider request was made.`);
        await printStatus(state, originalPrompt, runDirectory, config);
        return;
      }
    }

    const videoRunner = await createBootstrappedVideoAgentRunner({
      runDirectory,
      stateStore: state,
      tools: {
        validatePlan: requireTool(bundle, VIDEO_TOOL_NAMES.validatePlan),
        generateVideo: requireTool(bundle, VIDEO_TOOL_NAMES.generateVideo),
        generateFoley: requireTool(bundle, VIDEO_TOOL_NAMES.generateFoley),
        generateMusic: requireTool(bundle, VIDEO_TOOL_NAMES.generateMusic),
        assembleVideo: requireTool(bundle, VIDEO_TOOL_NAMES.assembleVideo),
        additionalTools: [statusTool],
        ...(uploadTool && youtube ? {
          youtubeUploadToolFactory: ({ authorization }: { authorization: YouTubeUploadAuthorization }) => {
            if (authorization.token !== youtube.authorizationToken) {
              throw new Error("YouTube capability token mismatch.");
            }
            return uploadTool;
          },
        } : {}),
      },
      frameworkOptions: { recursionLimit: 150 },
      additionalSystemRules: [
        `Immediately after write_todos, call ${VIDEO_TOOL_NAMES.status} and reuse every completed checkpoint.`,
        `Trusted prompt-derived preferences: ${JSON.stringify(promptPreferences)}.`,
        "Create one coherent story with setup, development, and payoff. Unless the user explicitly asks for 4-9 seconds, target 10-12 seconds and extend only the same narrative context with purposeful anticipation, development, reaction, or aftermath. Use one Agnes render, not multiple scenes or clips.",
        `Agnes is asynchronous. Submit once, durably retain video_id/task_id/key identity, and poll every 30 seconds for at most eight minutes. A pending result ends the invocation; resume this exact task with npm run dev -- --resume ${localRun.runId}.`,
        "Prompt Agnes with the natural diegetic sounds implied by every visible subject, action, and environment, synchronized inside broad achievable timing windows. After download, inspect the embedded Agnes audio first. If it contains a meaningful signal, preserve it as foreground audio and do not call vision or ElevenLabs. Only when it has no usable audio may the Foley tool inspect timestamped frames, retime supported causes, omit absent events, and generate ElevenLabs fallback effects.",
        "Attempt an intentionally quiet, sparse Free.ai ACE-Step instrumental bed unless music was explicitly disabled. Treat BPM as the perceived pulse, never double-time; the selected foreground audio owns all transient accents. If all bounded music attempts fail, immediately assemble with the selected Agnes-native or ElevenLabs foreground audio only. Do not use generic image, TTS, or audio tools.",
        "Never read, list, quote, or expose environment files, credentials, API keys, signed media URLs, or key fingerprints.",
        `For requested YouTube uploads, youtubeUpload.privacyStatus must be ${config.YOUTUBE_DEFAULT_PRIVACY} and youtubeUpload.madeForKids must be ${config.YOUTUBE_DEFAULT_MADE_FOR_KIDS}; generate the title, description, tags, and category from the video. Upload only when the authorized tool is present.`,
      ].join("\n"),
    });

    const promptHash = state.promptHash(originalPrompt);
    const authorization: YouTubeUploadAuthorization | undefined = youtube
      ? { approved: true, promptHash, token: youtube.authorizationToken }
      : undefined;
    process.chdir(runDirectory);
    const result = await videoRunner.run(
      originalPrompt,
      authorization ? { youtubeAuthorization: authorization } : {},
    );

    console.log("\n--- VIDEO AGENT RESULT ---");
    console.log(result.finalText);
    console.log(`\nRun id: ${localRun.runId}`);
    console.log(`Artifacts: ${runDirectory}`);
    if (uploadRequested && !youtube) {
      console.log("YouTube upload is pending: enable YouTube upload and configure OAuth, then resume.");
    }
    if (bundle.currentInvocationPending()) {
      await state.updateStatus(originalPrompt, "pending");
      await printStatus(state, originalPrompt, runDirectory, config);
      return;
    }
    if (bundle.currentInvocationFailure()) {
      await state.updateStatus(originalPrompt, "failed");
      await printStatus(state, originalPrompt, runDirectory, config);
      throw new Error(bundle.currentInvocationFailure() as string);
    }
    const assembled = await assembleCompletedVideoIfReady({
      assembleTool: requireTool(bundle, VIDEO_TOOL_NAMES.assembleVideo),
      state,
      originalPrompt,
      config,
    });
    if (!assembled) {
      await printStatus(state, originalPrompt, runDirectory, config);
      throw new Error(
        "The video agent finished without a validated final MP4 and without a pending provider task.",
      );
    }
    if (uploadTool) {
      const uploaded = await uploadCompletedVideoIfReady({
        uploadTool,
        state,
        originalPrompt,
        config,
      });
      if (!uploaded) {
        throw new Error(
          "The explicitly requested YouTube upload did not complete because no validated final MP4 was available.",
        );
      }
      console.log("YouTube upload completed or reused from its durable receipt.");
    }
    await printStatus(state, originalPrompt, runDirectory, config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let pausePromise: Promise<void> | undefined;
  const pauseOnce = (): Promise<void> => {
    pausePromise ??= pauseVmBeforeExit();
    return pausePromise;
  };
  const handleTerminationSignal = (signal: NodeJS.Signals): void => {
    const exitCode = signal === "SIGINT" ? 130 : 143;
    void pauseOnce().finally(() => process.exit(exitCode));
  };

  process.once("SIGINT", handleTerminationSignal);
  process.once("SIGTERM", handleTerminationSignal);

  main().catch((error) => {
    console.error(`Video agent failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }).finally(async () => {
    await pauseOnce();
  });
}
