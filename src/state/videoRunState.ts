import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  parseVideoPlanForPrompt,
  promptExplicitlyRequestsYouTubeUpload,
  type VideoPlan,
} from "../agent/videoPlan.js";
import { readJsonIfPresent, sha256File } from "../utils/files.js";

const IsoTimestampSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const VideoRunManifestSchema = z.object({
  schemaVersion: z.literal(2),
  promptHash: Sha256Schema,
  originalPrompt: z.string().trim().min(1),
  status: z.enum(["planning", "generating", "pending", "assembling", "completed", "failed"]),
  youtubeUploadRequested: z.boolean(),
  planStored: z.boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

/** Durable, secret-free receipt for one accepted Agnes asynchronous task. */
export const PersistedProviderJobSchema = z.object({
  schemaVersion: z.literal(2),
  provider: z.literal("agnes"),
  id: z.string().trim().min(1),
  videoId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  keyFingerprint: Sha256Schema,
  keyLabel: z.string().regex(/^key-\d+$/),
  model: z.literal("agnes-video-2.5-flash"),
  requestDigest: Sha256Schema,
}).strict();

export const ArtifactCheckpointSchema = z.object({
  schemaVersion: z.literal(2),
  status: z.enum(["in_progress", "queued", "deferred", "unknown", "completed", "failed", "skipped"]),
  attempt: z.number().int().positive(),
  path: z.string().trim().min(1).optional(),
  url: z.string().url().optional(),
  externalId: z.string().trim().min(1).optional(),
  sha256: Sha256Schema.optional(),
  durationSeconds: z.number().finite().positive().optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  details: z.record(z.unknown()).optional(),
  providerJob: PersistedProviderJobSchema.optional(),
  retryAt: IsoTimestampSchema.optional(),
  providerStatus: z.string().trim().min(1).optional(),
  retrySafe: z.boolean().optional(),
  error: z.string().trim().min(1).optional(),
  startedAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict().superRefine((checkpoint, context) => {
  if (
    checkpoint.status === "completed"
    && !checkpoint.path
    && !checkpoint.url
    && !checkpoint.externalId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A completed checkpoint must include path, url, or externalId.",
    });
  }
  if (checkpoint.status === "queued" && !checkpoint.providerJob) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["providerJob"],
      message: "A queued checkpoint must include its provider job receipt.",
    });
  }
  if (checkpoint.status === "deferred" && !checkpoint.retryAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["retryAt"],
      message: "A deferred checkpoint must include retryAt.",
    });
  }
  if (
    ["failed", "deferred", "unknown", "skipped"].includes(checkpoint.status)
    && !checkpoint.error
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: `${checkpoint.status} checkpoint must include an error or reason.`,
    });
  }
});

export type VideoRunManifest = z.infer<typeof VideoRunManifestSchema>;
export type PersistedProviderJob = z.infer<typeof PersistedProviderJobSchema>;
export type ArtifactCheckpoint = z.infer<typeof ArtifactCheckpointSchema>;
export type VideoRunStatus = VideoRunManifest["status"];
export type VideoCheckpointKey =
  | "video:checkpoint:source"
  | "video:checkpoint:analysis:source-audio"
  | "video:checkpoint:analysis:foley"
  | "video:checkpoint:audio:foley"
  | "video:checkpoint:audio:music"
  | "video:checkpoint:assembly:final"
  | "video:checkpoint:youtube:upload";

const PipelineStateSchema = z.object({
  schemaVersion: z.literal(2),
  manifest: VideoRunManifestSchema,
  checkpoints: z.record(ArtifactCheckpointSchema),
}).strict();

type PipelineState = z.infer<typeof PipelineStateSchema>;

export const videoCheckpointKeys = {
  sourceVideo: "video:checkpoint:source" as const,
  sourceAudioAnalysis: "video:checkpoint:analysis:source-audio" as const,
  foleyAnalysis: "video:checkpoint:analysis:foley" as const,
  foley: "video:checkpoint:audio:foley" as const,
  music: "video:checkpoint:audio:music" as const,
  assembly: "video:checkpoint:assembly:final" as const,
  youtubeUpload: "video:checkpoint:youtube:upload" as const,
};

const VIDEO_CHECKPOINT_KEY = /^video:checkpoint:(?:source|analysis:(?:source-audio|foley)|audio:(?:foley|music)|assembly:final|youtube:upload)$/;

export interface StartCheckpointInput {
  attempt?: number;
  provider?: string;
  model?: string;
  details?: Record<string, unknown>;
}

export interface CompleteCheckpointInput extends StartCheckpointInput {
  path?: string;
  url?: string;
  externalId?: string;
  sha256?: string;
  durationSeconds?: number;
  startedAt?: string;
  providerJob?: PersistedProviderJob;
}

export interface DownloadableMediaReceiptInput extends StartCheckpointInput {
  url: string;
  externalId?: string;
  durationSeconds?: number;
}

function hashPrompt(originalPrompt: string): string {
  const normalized = originalPrompt.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.part-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readableNonEmptyFile(filePath: string): Promise<boolean> {
  if (!filePath) return false;
  try {
    const information = await stat(filePath);
    return information.isFile() && information.size > 0;
  } catch {
    return false;
  }
}

async function checkpointFileMatches(checkpoint: ArtifactCheckpoint): Promise<boolean> {
  if (!checkpoint.path || !checkpoint.sha256) return false;
  try {
    return await readableNonEmptyFile(checkpoint.path)
      && await sha256File(checkpoint.path) === checkpoint.sha256;
  } catch {
    return false;
  }
}

interface RecoverableArtifact {
  key: VideoCheckpointKey;
  filePath: string;
  durationSeconds: number;
  provider: string;
  model: string;
  details?: Record<string, unknown>;
}

/** Prompt-hash-scoped video state stored entirely below the local run directory. */
export class VideoRunStateStore {
  readonly #runDirectory: string;
  readonly #statePath: string;
  readonly #planPath: string;
  #mutex: Promise<void> = Promise.resolve();

  constructor(runDirectory: string) {
    this.#runDirectory = path.resolve(runDirectory);
    this.#statePath = path.join(this.#runDirectory, "pipeline-state.json");
    this.#planPath = path.join(this.#runDirectory, "plan.json");
  }

  promptHash(originalPrompt: string): string {
    return hashPrompt(originalPrompt);
  }

  /** Filesystem run identity; distinct from the normalized prompt hash. */
  runId(originalPrompt: string): string {
    const candidate = path.basename(this.#runDirectory);
    return /^[a-f0-9]{64}$/.test(candidate)
      ? candidate
      : this.promptHash(originalPrompt);
  }

  async ensureManifest(originalPrompt: string, _initialProvider = "nvidia"): Promise<VideoRunManifest> {
    return this.#exclusive(async () => (await this.#ensureDocument(originalPrompt)).manifest);
  }

  async loadManifest(originalPrompt: string): Promise<VideoRunManifest | null> {
    return this.#exclusive(async () => {
      const document = await this.#readDocument();
      if (!document) return null;
      this.#assertDocumentMatchesPrompt(document, originalPrompt);
      return document.manifest;
    });
  }

  async updateStatus(originalPrompt: string, status: VideoRunStatus): Promise<VideoRunManifest> {
    return this.#exclusive(async () => {
      const document = await this.#ensureDocument(originalPrompt);
      document.manifest = VideoRunManifestSchema.parse({
        ...document.manifest,
        status,
        updatedAt: new Date().toISOString(),
      });
      await this.#writeDocument(document);
      return document.manifest;
    });
  }

  async savePlan(originalPrompt: string, input: unknown): Promise<VideoPlan> {
    return this.#exclusive(async () => {
      const document = await this.#ensureDocument(originalPrompt);
      const existing = await this.#readPlanValue();
      if (existing !== null) return parseVideoPlanForPrompt(existing, originalPrompt);

      const plan = parseVideoPlanForPrompt(input, originalPrompt);
      // If the process exits after this write, ensureManifest adopts the plan.
      await this.#writePlanValue(plan);
      document.manifest = VideoRunManifestSchema.parse({
        ...document.manifest,
        status: "generating",
        planStored: true,
        updatedAt: new Date().toISOString(),
      });
      await this.#writeDocument(document);
      return plan;
    });
  }

  async loadPlan(originalPrompt: string): Promise<VideoPlan | null> {
    return this.#exclusive(async () => {
      const value = await this.#readPlanValue();
      return value === null ? null : parseVideoPlanForPrompt(value, originalPrompt);
    });
  }

  async startCheckpoint(
    originalPrompt: string,
    key: VideoCheckpointKey,
    input: StartCheckpointInput = {},
  ): Promise<ArtifactCheckpoint> {
    return this.#exclusive(async () => {
      const document = await this.#ensureDocument(originalPrompt);
      const existing = document.checkpoints[key];
      if (existing && ["in_progress", "queued", "unknown"].includes(existing.status)) {
        throw new Error(
          `Checkpoint ${key} is already ${existing.status}; refusing a concurrent or duplicate start.`,
        );
      }
      const now = new Date().toISOString();
      const checkpoint = ArtifactCheckpointSchema.parse({
        schemaVersion: 2,
        status: "in_progress",
        attempt: input.attempt ?? ((existing?.attempt ?? 0) + 1),
        provider: input.provider,
        model: input.model,
        details: input.details,
        startedAt: now,
        updatedAt: now,
      });
      document.checkpoints[key] = checkpoint;
      document.manifest.status = key === videoCheckpointKeys.assembly
        ? "assembling"
        : "generating";
      document.manifest.updatedAt = now;
      await this.#writeDocument(document);
      return checkpoint;
    });
  }

  /**
   * Persist a synchronous provider's accepted output URL before downloading it.
   * Re-recording a retained URL on a later invocation starts a new local
   * download attempt without creating another provider generation.
   */
  async recordDownloadableMediaReceipt(
    originalPrompt: string,
    key: VideoCheckpointKey,
    input: DownloadableMediaReceiptInput,
  ): Promise<ArtifactCheckpoint> {
    return this.#exclusive(async () => {
      const document = await this.#ensureDocument(originalPrompt);
      const previous = document.checkpoints[key];
      if (!previous) {
        throw new Error(`Checkpoint ${key} must be started before recording a media URL.`);
      }
      const continuingCurrentAttempt = previous.status === "in_progress"
        && previous.url === undefined;
      const now = new Date().toISOString();
      const checkpoint = ArtifactCheckpointSchema.parse({
        schemaVersion: 2,
        status: "in_progress",
        attempt: continuingCurrentAttempt ? previous.attempt : previous.attempt + 1,
        url: input.url,
        externalId: input.externalId ?? previous.externalId,
        durationSeconds: input.durationSeconds ?? previous.durationSeconds,
        provider: input.provider ?? previous.provider,
        model: input.model ?? previous.model,
        details: {
          ...(previous.details ?? {}),
          ...(input.details ?? {}),
          submissionAccepted: true,
        },
        startedAt: continuingCurrentAttempt ? previous.startedAt : now,
        updatedAt: now,
      });
      document.checkpoints[key] = checkpoint;
      document.manifest.status = "generating";
      document.manifest.updatedAt = now;
      await this.#writeDocument(document);
      return checkpoint;
    });
  }

  /** Persist an accepted Agnes receipt or a later poll result before more I/O. */
  async updateProviderJobCheckpoint(
    originalPrompt: string,
    key: VideoCheckpointKey,
    input: {
      providerJob: PersistedProviderJob;
      providerStatus: "queued" | "in_progress" | "completed" | "failed";
      progress: number;
      url?: string;
      error?: string;
      details?: Record<string, unknown>;
    },
  ): Promise<ArtifactCheckpoint> {
    return this.#exclusive(async () => {
      const document = await this.#ensureDocument(originalPrompt);
      const previous = document.checkpoints[key];
      if (!previous) {
        throw new Error(`Checkpoint ${key} must be started before recording a provider job.`);
      }
      const now = new Date().toISOString();
      const localStatus = input.providerStatus === "queued"
        ? "queued"
        : input.providerStatus === "failed"
          ? "failed"
          : "in_progress";
      const checkpoint = ArtifactCheckpointSchema.parse({
        schemaVersion: 2,
        // Provider completion is not local completion: retain a resumable state
        // until the media URL has been atomically downloaded and checksummed.
        status: localStatus,
        attempt: previous.attempt,
        path: previous.path,
        url: input.url ?? previous.url,
        externalId: input.providerJob.videoId,
        provider: previous.provider ?? "agnes",
        model: previous.model ?? input.providerJob.model,
        details: {
          ...(previous.details ?? {}),
          ...(input.details ?? {}),
          progress: input.progress,
          lastProviderUpdateAt: now,
        },
        providerJob: input.providerJob,
        providerStatus: input.providerStatus,
        retrySafe: input.providerStatus === "failed" ? false : undefined,
        error: input.providerStatus === "failed"
          ? (input.error ?? "Agnes reported that the accepted video task failed.")
          : undefined,
        startedAt: previous.startedAt,
        updatedAt: now,
      });
      document.checkpoints[key] = checkpoint;
      document.manifest.status = input.providerStatus === "failed"
        ? "failed"
        : input.providerStatus === "completed"
          ? "generating"
          : "pending";
      document.manifest.updatedAt = now;
      await this.#writeDocument(document);
      return checkpoint;
    });
  }

  async deferCheckpoint(
    originalPrompt: string,
    key: VideoCheckpointKey,
    reason: string,
    retryAt: string,
  ): Promise<ArtifactCheckpoint> {
    return this.#exclusive(async () => {
      const document = await this.#ensureDocument(originalPrompt);
      const previous = document.checkpoints[key];
      const now = new Date().toISOString();
      const checkpoint = ArtifactCheckpointSchema.parse({
        schemaVersion: 2,
        status: "deferred",
        attempt: previous?.attempt ?? 1,
        provider: previous?.provider,
        model: previous?.model,
        details: previous?.details,
        retryAt,
        retrySafe: true,
        error: reason,
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
      });
      document.checkpoints[key] = checkpoint;
      await this.#writeDocument(document);
      return checkpoint;
    });
  }

  async markUnknown(
    originalPrompt: string,
    key: VideoCheckpointKey,
    error: string,
    input: {
      url?: string;
      externalId?: string;
      details?: Record<string, unknown>;
    } = {},
  ): Promise<ArtifactCheckpoint> {
    return this.#exclusive(async () => {
      const document = await this.#ensureDocument(originalPrompt);
      const previous = document.checkpoints[key];
      const now = new Date().toISOString();
      const checkpoint = ArtifactCheckpointSchema.parse({
        schemaVersion: 2,
        status: "unknown",
        attempt: previous?.attempt ?? 1,
        path: previous?.path,
        url: input.url ?? previous?.url,
        externalId: input.externalId ?? previous?.externalId,
        provider: previous?.provider,
        model: previous?.model,
        details: input.details
          ? { ...(previous?.details ?? {}), ...input.details }
          : previous?.details,
        providerJob: previous?.providerJob,
        retryAt: previous?.retryAt,
        providerStatus: previous?.providerStatus,
        retrySafe: false,
        error,
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
      });
      document.checkpoints[key] = checkpoint;
      await this.#writeDocument(document);
      return checkpoint;
    });
  }

  /** Clear an unaccepted/terminal retryable attempt before a new submission. */
  async resetCheckpointForRetry(
    originalPrompt: string,
    key: VideoCheckpointKey,
    error: string,
    details?: Record<string, unknown>,
    model?: string,
  ): Promise<ArtifactCheckpoint> {
    return this.#exclusive(async () => {
      const document = await this.#ensureDocument(originalPrompt);
      const previous = document.checkpoints[key];
      const now = new Date().toISOString();
      const checkpoint = ArtifactCheckpointSchema.parse({
        schemaVersion: 2,
        status: "failed",
        attempt: previous?.attempt ?? 1,
        provider: previous?.provider,
        model: model ?? previous?.model,
        details: details
          ? { ...(previous?.details ?? {}), ...details }
          : previous?.details,
        retrySafe: true,
        error,
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
      });
      document.checkpoints[key] = checkpoint;
      await this.#writeDocument(document);
      return checkpoint;
    });
  }

  async completeCheckpoint(
    originalPrompt: string,
    key: VideoCheckpointKey,
    input: CompleteCheckpointInput,
  ): Promise<ArtifactCheckpoint> {
    return this.#exclusive(async () => {
      const document = await this.#ensureDocument(originalPrompt);
      const previous = document.checkpoints[key];
      const now = new Date().toISOString();
      const checkpoint = ArtifactCheckpointSchema.parse({
        schemaVersion: 2,
        status: "completed",
        attempt: input.attempt ?? previous?.attempt ?? 1,
        path: input.path,
        url: input.url,
        externalId: input.externalId ?? previous?.externalId,
        sha256: input.sha256,
        durationSeconds: input.durationSeconds,
        provider: input.provider ?? previous?.provider,
        model: input.model ?? previous?.model,
        details: input.details ?? previous?.details,
        providerJob: input.providerJob ?? previous?.providerJob,
        providerStatus: previous?.providerStatus,
        startedAt: input.startedAt ?? previous?.startedAt ?? now,
        updatedAt: now,
      });
      document.checkpoints[key] = checkpoint;
      if (key === videoCheckpointKeys.youtubeUpload) {
        document.manifest.status = "completed";
        document.manifest.updatedAt = now;
      }
      await this.#writeDocument(document);
      return checkpoint;
    });
  }

  async failCheckpoint(
    originalPrompt: string,
    key: VideoCheckpointKey,
    error: string,
    retrySafe?: boolean,
  ): Promise<ArtifactCheckpoint> {
    return this.#exclusive(async () => {
      const document = await this.#ensureDocument(originalPrompt);
      const previous = document.checkpoints[key];
      const now = new Date().toISOString();
      const checkpoint = ArtifactCheckpointSchema.parse({
        schemaVersion: 2,
        status: "failed",
        attempt: previous?.attempt ?? 1,
        path: previous?.path,
        url: previous?.url,
        externalId: previous?.externalId,
        provider: previous?.provider,
        model: previous?.model,
        details: previous?.details,
        providerJob: previous?.providerJob,
        providerStatus: previous?.providerStatus,
        retrySafe: retrySafe ?? (previous?.providerJob ? false : true),
        error,
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
      });
      document.checkpoints[key] = checkpoint;
      await this.#writeDocument(document);
      return checkpoint;
    });
  }

  /**
   * Persist a deliberate best-effort omission. Unlike a retryable failure,
   * this is terminal for the optional artifact and must not block assembly or
   * trigger another provider request on a later invocation.
   */
  async skipCheckpoint(
    originalPrompt: string,
    key: VideoCheckpointKey,
    reason: string,
    details: Record<string, unknown> = {},
  ): Promise<ArtifactCheckpoint> {
    return this.#exclusive(async () => {
      const document = await this.#ensureDocument(originalPrompt);
      const previous = document.checkpoints[key];
      const now = new Date().toISOString();
      const checkpoint = ArtifactCheckpointSchema.parse({
        schemaVersion: 2,
        status: "skipped",
        attempt: previous?.attempt ?? 1,
        provider: previous?.provider,
        model: previous?.model,
        details: {
          ...(previous?.details ?? {}),
          ...details,
          optionalArtifactOmitted: true,
        },
        retrySafe: false,
        error: reason,
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
      });
      document.checkpoints[key] = checkpoint;
      if (document.manifest.status === "failed" || document.manifest.status === "pending") {
        document.manifest.status = "generating";
      }
      document.manifest.updatedAt = now;
      await this.#writeDocument(document);
      return checkpoint;
    });
  }

  async loadCheckpoint(
    originalPrompt: string,
    key: VideoCheckpointKey,
  ): Promise<ArtifactCheckpoint | null> {
    return this.#exclusive(async () => {
      const document = await this.#readDocument();
      if (!document) return null;
      this.#assertDocumentMatchesPrompt(document, originalPrompt);
      return document.checkpoints[key] ?? null;
    });
  }

  async listCheckpoints(
    originalPrompt: string,
  ): Promise<Array<{ key: string; value: ArtifactCheckpoint }>> {
    return this.#exclusive(async () => {
      const document = await this.#readDocument();
      if (!document) return [];
      this.#assertDocumentMatchesPrompt(document, originalPrompt);
      return Object.entries(document.checkpoints)
        .filter(([key]) => VIDEO_CHECKPOINT_KEY.test(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value }));
    });
  }

  /**
   * Once the validated final MP4 exists, intermediate media receipts no longer
   * need to retain temporary URLs or provider job metadata. Keep only the
   * final assembly and any YouTube receipt needed by a later authorized run.
   */
  async compactCompletedArtifacts(originalPrompt: string): Promise<void> {
    await this.#exclusive(async () => {
      const document = await this.#ensureDocument(originalPrompt);
      const assembly = document.checkpoints[videoCheckpointKeys.assembly];
      if (assembly?.status !== "completed" || !assembly.path || !await readableNonEmptyFile(assembly.path)) {
        throw new Error("Cannot compact media checkpoints before a readable final video exists.");
      }
      if (!assembly.sha256 || await sha256File(assembly.path) !== assembly.sha256) {
        throw new Error("Cannot compact media checkpoints because the final video checksum is missing or invalid.");
      }
      const youtube = document.checkpoints[videoCheckpointKeys.youtubeUpload];
      document.checkpoints = {
        [videoCheckpointKeys.assembly]: assembly,
        ...(youtube ? { [videoCheckpointKeys.youtubeUpload]: youtube } : {}),
      };
      document.manifest.status = "completed";
      document.manifest.updatedAt = new Date().toISOString();
      await this.#writeDocument(document);
    });
  }

  async #ensureDocument(originalPrompt: string): Promise<PipelineState> {
    const promptHash = this.promptHash(originalPrompt);

    const existing = await this.#readDocument();
    if (existing) {
      this.#assertDocumentMatchesPrompt(existing, originalPrompt);
      const before = JSON.stringify(existing);
      await this.#adoptLocalFiles(existing, originalPrompt);
      if (JSON.stringify(existing) !== before) await this.#writeDocument(existing);
      return existing;
    }

    const planValue = await this.#readPlanValue();
    const planStored = planValue !== null;
    if (planValue !== null) parseVideoPlanForPrompt(planValue, originalPrompt);
    const now = new Date().toISOString();
    const document = PipelineStateSchema.parse({
      schemaVersion: 2,
      manifest: {
        schemaVersion: 2,
        promptHash,
        originalPrompt,
        status: planStored ? "generating" : "planning",
        youtubeUploadRequested: promptExplicitlyRequestsYouTubeUpload(originalPrompt),
        planStored,
        createdAt: now,
        updatedAt: now,
      },
      checkpoints: {},
    });
    await this.#adoptLocalFiles(document, originalPrompt);
    await this.#writeDocument(document);
    return document;
  }

  #assertDocumentMatchesPrompt(document: PipelineState, originalPrompt: string): void {
    if (document.manifest.promptHash !== this.promptHash(originalPrompt)) {
      throw new Error("Pipeline state belongs to a different prompt hash.");
    }
  }

  async #adoptLocalFiles(document: PipelineState, originalPrompt: string): Promise<void> {
    let changed = false;
    const planValue = await this.#readPlanValue();
    let lockedPlan: VideoPlan | null = null;
    if (planValue !== null) {
      lockedPlan = parseVideoPlanForPrompt(planValue, originalPrompt);
      if (!document.manifest.planStored) {
        document.manifest.planStored = true;
        if (document.manifest.status === "planning") document.manifest.status = "generating";
        changed = true;
      }
    }

    const artifacts: RecoverableArtifact[] = lockedPlan ? [
      ...(lockedPlan.music.enabled ? [{
        key: videoCheckpointKeys.music,
        filePath: path.join(this.#runDirectory, "audio", "music.wav"),
        durationSeconds: lockedPlan.totalDurationSeconds,
        provider: "free.ai",
        model: "ace-step",
      } satisfies RecoverableArtifact] : []),
      {
        key: videoCheckpointKeys.sourceVideo,
        filePath: path.join(this.#runDirectory, "video", "source.mp4"),
        durationSeconds: lockedPlan.totalDurationSeconds,
        provider: "agnes",
        model: "agnes-video-2.5-flash",
        details: { singleContinuousRender: true },
      },
      {
        key: videoCheckpointKeys.foley,
        filePath: path.join(this.#runDirectory, "audio", "foley-mix.wav"),
        durationSeconds: lockedPlan.totalDurationSeconds,
        provider: "elevenlabs+local",
        model: "eleven_text_to_sound_v2+ffmpeg",
        details: { composedFromCueAssets: true, globalTimeline: true },
      },
    ] : [];
    for (const artifact of artifacts) {
      const existing = document.checkpoints[artifact.key];
      // A best-effort omission is a durable workflow decision. Do not let a
      // stale deterministic file silently turn it back into a required input.
      if (existing?.status === "skipped") continue;
      const sameProviderArtifact = existing?.provider === artifact.provider
        && existing.model === artifact.model;
      // Local crash recovery must never replace an actively transitioning
      // checkpoint with a stale deterministic file from another provider or
      // foreground-audio mode. Same-provider in-progress adoption remains
      // available for the narrow atomic-download-before-checkpoint window.
      if (
        existing
        && !sameProviderArtifact
        && ["in_progress", "queued", "unknown"].includes(existing.status)
      ) continue;
      if (existing?.status === "completed" && sameProviderArtifact) {
        if (await checkpointFileMatches(existing)) continue;
        // Never bless a corrupted deterministic artifact by replacing its
        // stored checksum with a checksum of the corruption.
        if (existing.path && path.resolve(existing.path) === path.resolve(artifact.filePath)) continue;
      }
      // Accepted provider receipts are more authoritative than an orphaned
      // non-empty local file and enable exact download-only recovery.
      if (existing?.url || existing?.providerJob) continue;
      if (!await readableNonEmptyFile(artifact.filePath)) continue;
      const now = new Date().toISOString();
      document.checkpoints[artifact.key] = ArtifactCheckpointSchema.parse({
        schemaVersion: 2,
        status: "completed",
        attempt: existing?.attempt ?? 1,
        path: artifact.filePath,
        sha256: await sha256File(artifact.filePath),
        durationSeconds: artifact.durationSeconds,
        provider: artifact.provider,
        model: artifact.model,
        details: { ...(artifact.details ?? {}), recoveredFromLocalArtifact: true },
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
      });
      changed = true;
    }

    // Recover only the narrow crash window between persisting a completed
    // assembly receipt and publishing the matching run status. An older final
    // must never overwrite the status of newly started reconciliation work.
    if (document.checkpoints[videoCheckpointKeys.assembly]?.status === "completed"
      && document.manifest.status === "assembling") {
      document.manifest.status = "completed";
      changed = true;
    }
    if (changed) document.manifest.updatedAt = new Date().toISOString();
  }

  async #readDocument(): Promise<PipelineState | null> {
    const value = await readJsonIfPresent<unknown>(this.#statePath);
    return value === null ? null : PipelineStateSchema.parse(value);
  }

  async #writeDocument(document: PipelineState): Promise<void> {
    const parsed = PipelineStateSchema.parse(document);
    await writeJsonAtomic(this.#statePath, parsed);
  }

  async #readPlanValue(): Promise<unknown | null> {
    return readJsonIfPresent<unknown>(this.#planPath);
  }

  async #writePlanValue(plan: VideoPlan): Promise<void> {
    await writeJsonAtomic(this.#planPath, plan);
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.#mutex;
    this.#mutex = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
