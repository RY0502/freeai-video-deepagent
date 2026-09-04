import {
  redactElevenLabsSecrets,
  sanitizeElevenLabsSecrets,
} from "./keys.js";
import type { ElevenLabsErrorKind } from "./types.js";

export interface ElevenLabsErrorOptions {
  kind: ElevenLabsErrorKind;
  status?: number;
  code?: string;
  retryAfterMs?: number;
  keyLabel?: string;
  response?: unknown;
  rotationExhausted?: boolean;
  ambiguousOutcome?: boolean;
  /** Internal policy decision: this rejection is definitively key-scoped. */
  rotateToNextKey?: boolean;
  cause?: unknown;
  keys?: readonly string[];
}

export class ElevenLabsError extends Error {
  readonly kind: ElevenLabsErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly keyLabel: string | undefined;
  readonly response: unknown;
  readonly rotationExhausted: boolean;
  readonly ambiguousOutcome: boolean;
  readonly #rotateToNextKey: boolean;

  constructor(message: string, options: ElevenLabsErrorOptions) {
    super(redactElevenLabsSecrets(message, options.keys), { cause: options.cause });
    this.name = "ElevenLabsError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code === undefined
      ? undefined
      : redactElevenLabsSecrets(options.code, options.keys);
    this.retryAfterMs = options.retryAfterMs;
    this.keyLabel = options.keyLabel;
    this.response = options.response === undefined
      ? undefined
      : sanitizeElevenLabsSecrets(options.response, options.keys);
    this.rotationExhausted = options.rotationExhausted ?? false;
    this.ambiguousOutcome = options.ambiguousOutcome ?? false;
    this.#rotateToNextKey = options.rotateToNextKey ?? false;
  }

  /** Only definitive, key-scoped rejections may move to the next configured key. */
  get mayTryAnotherKey(): boolean {
    return this.#rotateToNextKey;
  }
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function diagnosticText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export interface ParsedElevenLabsError {
  kind: ElevenLabsErrorKind;
  message: string;
  code?: string;
  rotateToNextKey: boolean;
}

/** Classify both the current `{detail:{type,code,...}}` and legacy envelopes. */
export function classifyElevenLabsError(
  status: number,
  payload: unknown,
  fallback: string,
): ParsedElevenLabsError {
  const root = asRecord(payload);
  const detail = asRecord(root?.detail);
  const nestedError = asRecord(root?.error);
  const code = firstString(
    detail?.code,
    detail?.status,
    detail?.type,
    root?.code,
    root?.status,
    root?.type,
    nestedError?.code,
    nestedError?.status,
    nestedError?.type,
  );
  const message = firstString(
    detail?.message,
    typeof root?.detail === "string" ? root.detail : undefined,
    nestedError?.message,
    typeof root?.error === "string" ? root.error : undefined,
    root?.message,
    fallback,
  ) ?? fallback;
  const normalized = `${code ?? ""} ${message} ${diagnosticText(payload)}`
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const normalizedCode = (code ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  // Paid-feature and subscription gates are account configuration failures,
  // not transient provider failures and not evidence that another key has
  // usable credits. Keep them non-rotating even though ElevenLabs uses 403.
  if (
    status === 403
    && (
      normalizedCode === "feature not available"
      || normalizedCode === "subscription required"
      || /\b(?:feature|music|model)\b.{0,48}\b(?:not available|unavailable|not enabled)\b/.test(normalized)
      || /\b(?:subscription required|paid subscription|upgrade (?:your )?(?:plan|subscription))\b/.test(normalized)
      || /\bnot included in (?:your )?(?:plan|subscription)\b/.test(normalized)
    )
  ) {
    return { kind: "configuration", message, rotateToNextKey: false, ...(code ? { code } : {}) };
  }

  // Concurrency and provider saturation are not key exhaustion. Rotating keys
  // from the same workspace cannot fix either condition.
  if (
    /\btoo many concurrent requests\b/.test(normalized)
    || /\bconcurrent limit exceeded\b/.test(normalized)
    || /\bsystem busy\b/.test(normalized)
  ) {
    return { kind: "rate_limit", message, rotateToNextKey: false, ...(code ? { code } : {}) };
  }

  // A generic 5xx has an ambiguous provider outcome and must never consume
  // another key. Explicit concurrency/system-busy responses above are safe
  // cooldowns because the provider has definitively declined the request.
  if (status >= 500) {
    return { kind: "provider", message, rotateToNextKey: false, ...(code ? { code } : {}) };
  }

  if (
    normalizedCode === "bad prompt"
    || normalizedCode === "bad composition plan"
    || normalizedCode === "invalid prompt"
    || /\bbad (?:music )?(?:prompt|composition plan)\b/.test(normalized)
  ) {
    return { kind: "validation", message, rotateToNextKey: false, ...(code ? { code } : {}) };
  }

  if (
    normalizedCode === "invalid api key"
    || normalizedCode === "missing api key"
    || normalizedCode === "authentication error"
    || normalizedCode === "unauthorized"
    || normalizedCode === "forbidden"
    || normalizedCode === "missing permissions"
    || normalizedCode === "insufficient permissions"
    || /\b(?:invalid|missing) api key\b/.test(normalized)
    || /\bauthentication error\b/.test(normalized)
    || /\binvalid authorization header\b/.test(normalized)
    || /\bunauthorized\b/.test(normalized)
    || /\b(?:forbidden|permission denied|insufficient permissions?)\b/.test(normalized)
  ) {
    return { kind: "authentication", message, rotateToNextKey: false, ...(code ? { code } : {}) };
  }

  if (
    status === 402
    || normalizedCode === "payment required"
    || /\binsufficient\b.{0,32}\b(?:credits?|quota)\b/.test(normalized)
    || /\b(?:credits?|quota)\b.{0,32}\b(?:exhausted|exceeded|depleted|used up)\b/.test(normalized)
    || /\bquota exceeded\b/.test(normalized)
    || /\bdaily credits?\b.{0,24}\b(?:exhausted|exceeded|depleted|used up|limit reached)\b/.test(normalized)
  ) {
    return {
      kind: "insufficient_credits",
      message,
      rotateToNextKey: true,
      ...(code ? { code } : {}),
    };
  }

  if (
    normalizedCode === "rate limit exceeded"
    || /\brate limited\b/.test(normalized)
    || /\brate limit (?:exceeded|reached)\b/.test(normalized)
  ) {
    return { kind: "rate_limit", message, rotateToNextKey: true, ...(code ? { code } : {}) };
  }

  if (
    status === 401
    || status === 403
  ) {
    return { kind: "authentication", message, rotateToNextKey: false, ...(code ? { code } : {}) };
  }

  if (status === 400 || status === 422) {
    return { kind: "validation", message, rotateToNextKey: false, ...(code ? { code } : {}) };
  }
  if (status === 429) {
    return { kind: "rate_limit", message, rotateToNextKey: false, ...(code ? { code } : {}) };
  }
  return { kind: "provider", message, rotateToNextKey: false, ...(code ? { code } : {}) };
}
