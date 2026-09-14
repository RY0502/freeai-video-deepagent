import { randomBytes } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { hashUserPrompt } from "freetier-deepagent-framework";
import { ensureDirectory, readJsonIfPresent, writeJsonAtomic } from "./utils/files.js";

export interface LocalRunIndex {
  schemaVersion: 2;
  runId: string;
  promptHash: string;
  originalPrompt: string;
  runDirectory: string;
  createdAt: string;
  updatedAt: string;
}

export function runDirectoryFor(outputRoot: string, runId: string): string {
  if (!/^[a-f0-9]{64}$/.test(runId)) throw new Error("Invalid run id");
  return path.resolve(outputRoot, runId);
}

/**
 * Find an existing run with the same prompt hash.
 * Returns the most recently updated run if multiple exist.
 */
export async function findExistingRunByPromptHash(
  outputRoot: string,
  promptHash: string,
): Promise<LocalRunIndex | null> {
  const resolvedRoot = path.resolve(outputRoot);
  try {
    const entries = await readdir(resolvedRoot);
    const candidates: LocalRunIndex[] = [];
    
    for (const entry of entries) {
      // Only check directories that look like run IDs (64 hex chars)
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      
      try {
        const indexPath = path.join(resolvedRoot, entry, "run.json");
        const stored = await readJsonIfPresent<Partial<LocalRunIndex>>(indexPath);
        if (!stored) continue;
        
        const storedPromptHash = stored.promptHash ?? 
          (stored.runId === hashUserPrompt(stored.originalPrompt || "") ? stored.runId : undefined);
        
        if (storedPromptHash === promptHash && stored.schemaVersion === 2) {
          candidates.push({
            schemaVersion: 2,
            runId: stored.runId!,
            promptHash: storedPromptHash,
            originalPrompt: stored.originalPrompt!,
            runDirectory: stored.runDirectory!,
            createdAt: stored.createdAt!,
            updatedAt: stored.updatedAt!,
          });
        }
      } catch {
        // Skip invalid or corrupt run directories
        continue;
      }
    }
    
    if (candidates.length === 0) return null;
    
    // Return the most recently updated run
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return candidates[0] ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Ensure a run index exists for the given prompt.
 * If a run with the same prompt hash already exists, it will be reused.
 * Otherwise, a new run will be created.
 */
export async function ensureLocalRunIndex(
  outputRoot: string,
  originalPrompt: string,
): Promise<LocalRunIndex> {
  const promptHash = hashUserPrompt(originalPrompt);
  await ensureDirectory(path.resolve(outputRoot));
  
  // Try to find an existing run with the same prompt hash
  const existing = await findExistingRunByPromptHash(outputRoot, promptHash);
  if (existing) {
    // Update the timestamp to indicate it's being resumed
    const indexPath = path.join(existing.runDirectory, "run.json");
    const updated: LocalRunIndex = {
      ...existing,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(indexPath, updated);
    return updated;
  }
  
  // No existing run found, create a new one
  let runId = "";
  let runDirectory = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    runId = randomBytes(32).toString("hex");
    runDirectory = runDirectoryFor(outputRoot, runId);
    try {
      await mkdir(runDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      runId = "";
      runDirectory = "";
    }
  }
  if (!runId || !runDirectory) {
    throw new Error("Could not allocate a unique local video run ID");
  }
  const indexPath = path.join(runDirectory, "run.json");

  const now = new Date().toISOString();
  const value: LocalRunIndex = {
    schemaVersion: 2,
    runId,
    promptHash,
    originalPrompt,
    runDirectory,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonAtomic(indexPath, value);
  return value;
}

/** @deprecated Use ensureLocalRunIndex for prompt-based reuse and resume behavior. */
export const createLocalRunIndex = ensureLocalRunIndex;

export async function loadLocalRunIndex(
  outputRoot: string,
  runId: string,
): Promise<LocalRunIndex> {
  const indexPath = path.join(runDirectoryFor(outputRoot, runId), "run.json");
  const stored = await readJsonIfPresent<Partial<LocalRunIndex>>(indexPath);
  if (!stored) throw new Error(`Run not found: ${runId}`);
  const originalPrompt = typeof stored.originalPrompt === "string"
    ? stored.originalPrompt
    : "";
  const expectedPromptHash = hashUserPrompt(originalPrompt);
  // Schema-v2 runs created before isolated invocation IDs used the prompt hash
  // itself as runId and did not persist a separate promptHash field.
  const promptHash = stored.promptHash
    ?? (stored.runId === expectedPromptHash ? expectedPromptHash : undefined);
  if (
    stored.schemaVersion !== 2
    || stored.runId !== runId
    || !originalPrompt.trim()
    || promptHash !== expectedPromptHash
    || stored.runDirectory !== runDirectoryFor(outputRoot, runId)
    || typeof stored.createdAt !== "string"
    || typeof stored.updatedAt !== "string"
  ) {
    throw new Error(`Run index is corrupt or does not match its directory: ${indexPath}`);
  }
  return {
    schemaVersion: 2,
    runId,
    promptHash,
    originalPrompt,
    runDirectory: stored.runDirectory,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}
