import { createHash } from "node:crypto";
import path from "node:path";

import { stripYouTubeUploadAuthorization } from "./authorization.js";

const MAX_STEM_BYTES = 96;
const LEGACY_FINAL_VIDEO_NAME = /^final(?:-\d+)?\.mp4$/;

function trimToUtf8Bytes(value: string, maximumBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result.replace(/-+$/u, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new Error("Final video attempt must be a positive safe integer");
  }
}

/**
 * Create a stable, human-readable filename stem from the user's actual prompt.
 * Only letters, numbers, and internal hyphens survive, which avoids separators,
 * shell metacharacters, Windows-reserved punctuation, and trailing dots/spaces.
 */
export function finalVideoStem(originalPrompt: string): string {
  const visiblePrompt = stripYouTubeUploadAuthorization(originalPrompt);
  const descriptivePrompt = visiblePrompt
    .replace(
      /^(?:please\s+)?(?:create|make|generate|produce|render)\s+(?:(?:me|us)\s+)?(?:(?:a|an|the)\s+)?/iu,
      "",
    )
    .replace(
      /^(?:(?:short|brief)\s+)?(?:video|clip|film|animation)\s+(?:of|about|showing|featuring)\s+/iu,
      "",
    );
  const normalized = descriptivePrompt
    .normalize("NFKC")
    .replace(/&/gu, " and ")
    .replace(/[\p{Quotation_Mark}\p{Dash_Punctuation}]+/gu, "-")
    .replace(/[^\p{Letter}\p{Number}\p{Mark}]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
  const stem = trimToUtf8Bytes(normalized, MAX_STEM_BYTES);
  if (/[\p{Letter}\p{Number}]/u.test(stem)) return stem;

  // Some prompts (for example, emoji-only input) contain no portable word
  // characters. Keep those deterministic and collision-resistant per prompt.
  const digest = createHash("sha256").update(visiblePrompt).digest("hex").slice(0, 12);
  return `video-${digest}`;
}

export function finalVideoFileName(originalPrompt: string, attempt: number): string {
  requireAttempt(attempt);
  return `${finalVideoStem(originalPrompt)}-${attempt}.mp4`;
}

export function finalVideoPartialFileName(originalPrompt: string, attempt: number): string {
  return finalVideoFileName(originalPrompt, attempt).replace(/\.mp4$/u, ".part.mp4");
}

export function finalVideoArtifactPaths(
  runDirectory: string,
  originalPrompt: string,
  attempt: number,
): { outputPath: string; partialPath: string } {
  const resolvedRunDirectory = path.resolve(runDirectory);
  return {
    outputPath: path.join(resolvedRunDirectory, finalVideoFileName(originalPrompt, attempt)),
    partialPath: path.join(resolvedRunDirectory, finalVideoPartialFileName(originalPrompt, attempt)),
  };
}

export function isLegacyFinalVideoFileName(fileName: string): boolean {
  return LEGACY_FINAL_VIDEO_NAME.test(fileName);
}

export function isPromptFinalVideoFileName(fileName: string, originalPrompt: string): boolean {
  const stem = escapeRegExp(finalVideoStem(originalPrompt));
  return new RegExp(`^${stem}-[1-9]\\d*\\.mp4$`, "u").test(fileName);
}

export function isPromptFinalVideoPartialFileName(
  fileName: string,
  originalPrompt: string,
): boolean {
  const stem = escapeRegExp(finalVideoStem(originalPrompt));
  return new RegExp(`^${stem}-[1-9]\\d*\\.part\\.mp4$`, "u").test(fileName);
}
