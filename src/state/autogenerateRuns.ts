import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readJsonIfPresent } from "../utils/files.js";
import { videoCheckpointKeys, type ArtifactCheckpoint, type VideoRunManifest } from "./videoRunState.js";

export type AutogenerateEligibilityTier = "queued_or_in_progress" | "failed_retry_safe";

export interface EligibleAutogenerateRun {
  runId: string;
  originalPrompt: string;
  runDirectory: string;
  createdAt: string;
  updatedAt: string;
  manifestStatus: string;
  sourceStatus?: string | undefined;
  hasProviderJob: boolean;
  tier: AutogenerateEligibilityTier;
  failureReason?: string | undefined;
}

export interface RunAutogenerateEligibility {
  eligible: boolean;
  tier?: AutogenerateEligibilityTier | undefined;
  hasProviderJob: boolean;
  sourceStatus?: string | undefined;
  failureReason?: string | undefined;
}

export interface AutogenerateRunCandidates {
  queuedOrInProgress: EligibleAutogenerateRun[];
  failedRetrySafe: EligibleAutogenerateRun[];
}

interface StoredRunIndex {
  schemaVersion: number;
  runId: string;
  originalPrompt: string;
  runDirectory: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredPipelineState {
  schemaVersion: number;
  manifest: VideoRunManifest;
  checkpoints?: Record<string, ArtifactCheckpoint>;
}

/**
 * Checks whether a run is eligible for auto-completion:
 * - Not already completed (manifest !== "completed" and assembly checkpoint !== "completed")
 * - Not blocked by a non-retryable failure (no checkpoint with status === "failed" && retrySafe === false)
 * - Has either:
 *   Tier 1 ("queued_or_in_progress"):
 *     a) Agnes submission accepted (sourceVideo checkpoint has providerJob receipt and not failed)
 *     b) Agnes submission in progress (sourceVideo checkpoint is in_progress, queued, deferred, or unknown,
 *        or manifest status is generating/pending, and not failed)
 *   Tier 2 ("failed_retry_safe"):
 *     A checkpoint failed with retrySafe === true (e.g. Agnes queue full capacity exhaustion)
 */
export function isRunEligibleForAutogenerate(
  manifest: VideoRunManifest,
  checkpoints: Record<string, ArtifactCheckpoint> = {},
): RunAutogenerateEligibility {
  // If the run or its final assembly is already marked completed, it's not eligible
  const assemblyCheckpoint = checkpoints[videoCheckpointKeys.assembly];
  if (manifest.status === "completed" || assemblyCheckpoint?.status === "completed") {
    return { eligible: false, hasProviderJob: false };
  }

  const checkpointList = Object.values(checkpoints);
  // If any checkpoint failed with retrySafe === false, it is a terminal non-retryable error
  const hasNonRetryableFailure = checkpointList.some(
    (cp) => cp.status === "failed" && cp.retrySafe === false,
  );
  if (hasNonRetryableFailure) {
    return { eligible: false, hasProviderJob: false };
  }

  const sourceCheckpoint = checkpoints[videoCheckpointKeys.sourceVideo];
  const hasProviderJob = Boolean(sourceCheckpoint?.providerJob);

  // 1. Queued or in-progress submissions (Tier 1)
  // - Agnes submission accepted: has provider job receipt AND source checkpoint is not failed
  // - Agnes submission in progress: source checkpoint is in_progress, queued, deferred, or unknown,
  //   or manifest status is generating/pending (and neither source nor manifest is failed)
  const inProgressSourceStatuses = ["in_progress", "queued", "deferred", "unknown"];
  const isSourceInProgress = Boolean(
    sourceCheckpoint?.status && inProgressSourceStatuses.includes(sourceCheckpoint.status),
  );
  const isManifestInProgress = manifest.status === "generating" || manifest.status === "pending";

  const isQueuedOrInProgress =
    (hasProviderJob && sourceCheckpoint?.status !== "failed" && manifest.status !== "failed")
    || isSourceInProgress
    || (isManifestInProgress && sourceCheckpoint?.status !== "failed" && manifest.status !== "failed");

  if (isQueuedOrInProgress) {
    return {
      eligible: true,
      tier: "queued_or_in_progress",
      hasProviderJob,
      sourceStatus: sourceCheckpoint?.status,
    };
  }

  // 2. Failed and retrySafe is true (Tier 2)
  const failedRetrySafeCheckpoint = checkpointList.find(
    (cp) => cp.status === "failed" && cp.retrySafe === true,
  );

  if (failedRetrySafeCheckpoint || (manifest.status === "failed" && sourceCheckpoint?.retrySafe === true)) {
    const failureReason = failedRetrySafeCheckpoint?.error ?? sourceCheckpoint?.error;
    return {
      eligible: true,
      tier: "failed_retry_safe",
      hasProviderJob,
      sourceStatus: sourceCheckpoint?.status,
      failureReason,
    };
  }

  return { eligible: false, hasProviderJob: false };
}

/**
 * Checks whether a video is already generated on disk for a run:
 * 1. Checks if the assembly checkpoint path exists on disk and is a non-empty file.
 * 2. Checks if any completed non-partial .mp4 file exists in the run directory.
 */
export async function hasVideoAlreadyGeneratedOnDisk(
  runDirectory: string,
  assemblyCheckpoint?: ArtifactCheckpoint,
): Promise<boolean> {
  // 1. If assembly checkpoint specifies a path, check if it exists on disk
  if (assemblyCheckpoint?.path) {
    try {
      const stats = await stat(assemblyCheckpoint.path);
      if (stats.isFile() && stats.size > 0) {
        return true;
      }
    } catch {
      // not on disk at that path
    }
  }

  // 2. Check if any completed non-partial .mp4 file exists directly in runDirectory root
  try {
    const files = await readdir(runDirectory);
    for (const file of files) {
      if (file.endsWith(".part.mp4") || file.endsWith(".part")) continue;
      if (file.endsWith(".mp4")) {
        try {
          const stats = await stat(path.join(runDirectory, file));
          if (stats.isFile() && stats.size > 0) {
            return true;
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // run directory unreadable
  }

  return false;
}

/**
 * Scans outputRoot for runs and categorizes them into:
 * 1. queuedOrInProgress: submission accepted or in-progress
 * 2. failedRetrySafe: failed runs where retrySafe is true
 * Both lists are sorted oldest first by createdAt.
 */
export async function findCategorizedAutogenerateRuns(
  outputRoot: string,
): Promise<AutogenerateRunCandidates> {
  const resolvedRoot = path.resolve(outputRoot);
  let entries: string[] = [];

  try {
    entries = await readdir(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { queuedOrInProgress: [], failedRetrySafe: [] };
    }
    throw error;
  }

  const queuedOrInProgress: EligibleAutogenerateRun[] = [];
  const failedRetrySafe: EligibleAutogenerateRun[] = [];

  for (const entry of entries) {
    // Only examine 64-char hex run directories
    if (!/^[a-f0-9]{64}$/.test(entry)) continue;

    const runDir = path.join(resolvedRoot, entry);
    const runIndexPath = path.join(runDir, "run.json");
    const pipelineStatePath = path.join(runDir, "pipeline-state.json");

    try {
      const runIndex = await readJsonIfPresent<StoredRunIndex>(runIndexPath);
      if (!runIndex || !runIndex.originalPrompt) continue;

      const pipelineState = await readJsonIfPresent<StoredPipelineState>(pipelineStatePath);
      if (!pipelineState || !pipelineState.manifest) continue;

      const eligibility = isRunEligibleForAutogenerate(
        pipelineState.manifest,
        pipelineState.checkpoints ?? {},
      );

      if (eligibility.eligible && eligibility.tier) {
        const videoAlreadyOnDisk = await hasVideoAlreadyGeneratedOnDisk(
          runIndex.runDirectory || runDir,
          pipelineState.checkpoints?.[videoCheckpointKeys.assembly],
        );
        if (videoAlreadyOnDisk) {
          continue;
        }

        const candidate: EligibleAutogenerateRun = {
          runId: runIndex.runId,
          originalPrompt: runIndex.originalPrompt,
          runDirectory: runIndex.runDirectory || runDir,
          createdAt: runIndex.createdAt || pipelineState.manifest.createdAt,
          updatedAt: runIndex.updatedAt || pipelineState.manifest.updatedAt,
          manifestStatus: pipelineState.manifest.status,
          sourceStatus: eligibility.sourceStatus,
          hasProviderJob: eligibility.hasProviderJob,
          tier: eligibility.tier,
          failureReason: eligibility.failureReason,
        };

        if (eligibility.tier === "queued_or_in_progress") {
          queuedOrInProgress.push(candidate);
        } else {
          failedRetrySafe.push(candidate);
        }
      }
    } catch {
      // Ignore corrupt or unreadable directories
      continue;
    }
  }

  const sortOldestFirst = (a: EligibleAutogenerateRun, b: EligibleAutogenerateRun) => {
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
      return timeA - timeB;
    }
    return a.runId.localeCompare(b.runId);
  };

  queuedOrInProgress.sort(sortOldestFirst);
  failedRetrySafe.sort(sortOldestFirst);

  return { queuedOrInProgress, failedRetrySafe };
}

/**
 * Scans outputRoot for runs according to autogenerate priority rules:
 * 1. If any queued or in-progress runs exist, return them sorted oldest first.
 * 2. If no queued or in-progress runs exist, return failed runs where retrySafe is true sorted oldest first.
 * 3. If neither exist, return an empty array.
 */
export async function findEligibleAutogenerateRuns(
  outputRoot: string,
): Promise<EligibleAutogenerateRun[]> {
  const { queuedOrInProgress, failedRetrySafe } = await findCategorizedAutogenerateRuns(outputRoot);
  if (queuedOrInProgress.length > 0) {
    return queuedOrInProgress;
  }
  return failedRetrySafe;
}
