import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readJsonIfPresent } from "../utils/files.js";
import { videoCheckpointKeys, type ArtifactCheckpoint, type VideoRunManifest } from "./videoRunState.js";

export interface EligibleAutogenerateRun {
  runId: string;
  originalPrompt: string;
  runDirectory: string;
  createdAt: string;
  updatedAt: string;
  manifestStatus: string;
  sourceStatus?: string | undefined;
  hasProviderJob: boolean;
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
 * - Has either:
 *   a) Agnes submission accepted (sourceVideo checkpoint has providerJob receipt)
 *   b) Agnes submission in progress (sourceVideo checkpoint is in_progress, queued, deferred, or unknown,
 *      or manifest status is generating/pending)
 */
export function isRunEligibleForAutogenerate(
  manifest: VideoRunManifest,
  checkpoints: Record<string, ArtifactCheckpoint> = {},
): { eligible: boolean; hasProviderJob: boolean; sourceStatus?: string | undefined } {
  // If the run or its final assembly is already marked completed, it's not eligible
  const assemblyCheckpoint = checkpoints[videoCheckpointKeys.assembly];
  if (manifest.status === "completed" || assemblyCheckpoint?.status === "completed") {
    return { eligible: false, hasProviderJob: false };
  }

  const sourceCheckpoint = checkpoints[videoCheckpointKeys.sourceVideo];
  const hasProviderJob = Boolean(sourceCheckpoint?.providerJob);

  // 1. Agnes submission accepted: has provider job receipt
  if (hasProviderJob) {
    return {
      eligible: true,
      hasProviderJob: true,
      sourceStatus: sourceCheckpoint?.status,
    };
  }

  // 2. Agnes submission in progress:
  // source checkpoint is in_progress, queued, deferred, or unknown,
  // or manifest is generating or pending
  const inProgressSourceStatuses = ["in_progress", "queued", "deferred", "unknown"];
  const isSourceInProgress = sourceCheckpoint?.status && inProgressSourceStatuses.includes(sourceCheckpoint.status);
  const isManifestInProgress = manifest.status === "generating" || manifest.status === "pending";

  if (isSourceInProgress || isManifestInProgress) {
    return {
      eligible: true,
      hasProviderJob: false,
      sourceStatus: sourceCheckpoint?.status,
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
 * Scans outputRoot for runs, finds all eligible pending runs,
 * and sorts them oldest first by createdAt.
 */
export async function findEligibleAutogenerateRuns(
  outputRoot: string,
): Promise<EligibleAutogenerateRun[]> {
  const resolvedRoot = path.resolve(outputRoot);
  let entries: string[] = [];

  try {
    entries = await readdir(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const candidates: EligibleAutogenerateRun[] = [];

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

      if (eligibility.eligible) {
        const videoAlreadyOnDisk = await hasVideoAlreadyGeneratedOnDisk(
          runIndex.runDirectory || runDir,
          pipelineState.checkpoints?.[videoCheckpointKeys.assembly],
        );
        if (videoAlreadyOnDisk) {
          continue;
        }

        candidates.push({
          runId: runIndex.runId,
          originalPrompt: runIndex.originalPrompt,
          runDirectory: runIndex.runDirectory || runDir,
          createdAt: runIndex.createdAt || pipelineState.manifest.createdAt,
          updatedAt: runIndex.updatedAt || pipelineState.manifest.updatedAt,
          manifestStatus: pipelineState.manifest.status,
          sourceStatus: eligibility.sourceStatus,
          hasProviderJob: eligibility.hasProviderJob,
        });
      }
    } catch {
      // Ignore corrupt or unreadable directories
      continue;
    }
  }

  // Sort oldest first by createdAt
  candidates.sort((a, b) => {
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
      return timeA - timeB;
    }
    return a.runId.localeCompare(b.runId);
  });

  return candidates;
}
