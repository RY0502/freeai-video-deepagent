import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
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

/** Create an isolated run for every trigger, including identical prompts. */
export async function createLocalRunIndex(
  outputRoot: string,
  originalPrompt: string,
): Promise<LocalRunIndex> {
  const promptHash = hashUserPrompt(originalPrompt);
  await ensureDirectory(path.resolve(outputRoot));
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

/** @deprecated New prompt invocations intentionally create isolated runs. */
export const ensureLocalRunIndex = createLocalRunIndex;

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
