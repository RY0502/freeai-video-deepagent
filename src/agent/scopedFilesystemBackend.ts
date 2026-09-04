import path from "node:path";
import type { DeepAgentRunner } from "freetier-deepagent-framework";

interface BackendWriteResult {
  path?: string;
  error?: string | null;
}

/**
 * The pinned framework constructs Deep Agents' FilesystemBackend internally,
 * without exposing its root-directory options. Keep the compatibility access
 * isolated here so absolute virtual paths such as `/conversation_history/...`
 * are stored inside this prompt's run directory instead of at filesystem root.
 */
export interface ScopedFrameworkFilesystemBackend {
  write(filePath: string, content: string): Promise<BackendWriteResult>;
  downloadFiles(paths: string[]): Promise<Array<{ content?: Uint8Array; error?: string | null }>>;
  uploadFiles(files: Array<[string, Uint8Array]>): Promise<Array<{ path?: string; error?: string | null }>>;
}

interface MutableFrameworkFilesystemBackend extends ScopedFrameworkFilesystemBackend {
  cwd: string;
  virtualMode: boolean;
}

function isMutableFrameworkFilesystemBackend(
  value: unknown,
): value is MutableFrameworkFilesystemBackend {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MutableFrameworkFilesystemBackend>;
  return typeof candidate.cwd === "string"
    && typeof candidate.virtualMode === "boolean"
    && typeof candidate.write === "function"
    && typeof candidate.downloadFiles === "function"
    && typeof candidate.uploadFiles === "function";
}

export function scopeFrameworkFilesystemToRunDirectory(
  runner: DeepAgentRunner,
  runDirectory: string,
): ScopedFrameworkFilesystemBackend {
  const backend = (runner as unknown as { backend?: unknown }).backend;
  if (!isMutableFrameworkFilesystemBackend(backend)) {
    throw new Error(
      "The pinned deep-agent framework no longer exposes the expected filesystem backend internals.",
    );
  }

  backend.cwd = path.resolve(runDirectory);
  backend.virtualMode = true;
  return backend;
}
