import { redactAgnesSecrets, sanitizeAgnesSecrets } from "./keys.js";

export type AgnesErrorKind =
  | "configuration"
  | "validation"
  | "authentication"
  | "insufficient_credits"
  | "quota_exhausted"
  | "daily_limit"
  | "rate_limit"
  | "provider_capacity"
  | "ambiguous_submission"
  | "provider"
  | "network"
  | "timeout"
  | "download";

export interface AgnesErrorOptions {
  kind: AgnesErrorKind;
  status?: number;
  code?: string;
  retryAfterMs?: number;
  keyLabel?: string;
  response?: unknown;
  cause?: unknown;
  keys?: readonly string[];
  ambiguousOutcome?: boolean;
  rotationExhausted?: boolean;
}

export class AgnesError extends Error {
  readonly kind: AgnesErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly keyLabel: string | undefined;
  readonly response: unknown;
  readonly ambiguousOutcome: boolean;
  rotationExhausted: boolean;

  constructor(message: string, options: AgnesErrorOptions) {
    super(redactAgnesSecrets(message, options.keys), {
      cause: options.cause === undefined
        ? undefined
        : redactAgnesSecrets(
            options.cause instanceof Error ? options.cause.message : options.cause,
            options.keys,
          ),
    });
    this.name = "AgnesError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code === undefined
      ? undefined
      : redactAgnesSecrets(options.code, options.keys);
    this.retryAfterMs = options.retryAfterMs;
    this.keyLabel = options.keyLabel;
    this.response = options.response === undefined
      ? undefined
      : sanitizeAgnesSecrets(options.response, options.keys);
    this.ambiguousOutcome = options.ambiguousOutcome ?? false;
    this.rotationExhausted = options.rotationExhausted ?? false;
  }

  /** Only an unambiguous, key-scoped provider rejection permits rotation. */
  get mayTryAnotherKey(): boolean {
    return this.kind === "insufficient_credits"
      || this.kind === "quota_exhausted"
      || this.kind === "daily_limit"
      || this.kind === "rate_limit";
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

const DIAGNOSTIC_FIELDS = new Set([
  "code",
  "detail",
  "error",
  "errorcode",
  "errormessage",
  "errors",
  "message",
  "reason",
  "status",
  "type",
]);

function diagnosticStrings(payload: unknown): string[] {
  const output: string[] = [];
  const seen = new WeakSet<object>();

  const visit = (value: unknown, depth: number, diagnosticContext: boolean): void => {
    if (depth > 8 || output.length >= 128) return;
    if (typeof value === "string") {
      if (diagnosticContext && value.trim()) output.push(value.trim().slice(0, 2_048));
      return;
    }
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, diagnosticContext);
      return;
    }
    for (const [name, nested] of Object.entries(value as JsonRecord)) {
      const normalizedName = name.replace(/[_-]+/g, "").toLowerCase();
      visit(nested, depth + 1, diagnosticContext || DIAGNOSTIC_FIELDS.has(normalizedName));
    }
  };

  visit(payload, 0, typeof payload === "string");
  return output;
}

function providerCode(payload: unknown): string | undefined {
  const root = asRecord(payload);
  const error = asRecord(root?.error);
  const detail = asRecord(root?.detail);
  return firstString(error?.code, detail?.code, root?.code, error?.type, detail?.type, root?.type);
}

function providerMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  const root = asRecord(payload);
  const error = asRecord(root?.error);
  const detail = asRecord(root?.detail);
  return firstString(
    error?.message,
    error?.error_message,
    detail?.message,
    detail?.error_message,
    root?.message,
    root?.error_message,
    typeof root?.error === "string" ? root.error : undefined,
    typeof root?.detail === "string" ? root.detail : undefined,
    diagnosticStrings(payload)[0],
    fallback,
  ) ?? fallback;
}

function normalizedDiagnostics(payload: unknown): string {
  return diagnosticStrings(payload)
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isRateLimited(text: string): boolean {
  return /\brate limits?(?:ed| exceeded| reached)?\b/.test(text)
    || /\bratelimit(?:ed| exceeded| reached)?\b/.test(text)
    || /\btoo many requests\b/.test(text);
}

function isDailyLimit(text: string): boolean {
  return /\bdaily (?:credit|credits|limit|quota)(?: limit)? (?:exhausted|exceeded|reached|used up)\b/.test(text)
    || /\b(?:credit|credits|limit|quota) per day (?:exhausted|exceeded|reached)\b/.test(text)
    || /\b(?:exhausted|exceeded|reached|used up) (?:your |the )?daily (?:credit|credits|limit|quota)\b/.test(text);
}

function isInsufficientCredits(text: string): boolean {
  return /\binsufficient (?:account )?credits?\b/.test(text)
    || /\bnot enough credits?\b/.test(text)
    || /\bout of credits?\b/.test(text)
    || /\bno credits? (?:left|remaining)\b/.test(text)
    || /\bcredits? (?:are )?(?:depleted|exhausted)\b/.test(text)
    || /\bcredit balance (?:is )?(?:0|zero|depleted|exhausted)\b/.test(text);
}

function isQuotaExhausted(text: string): boolean {
  return /\bquota (?:is )?(?:exhausted|exceeded|reached|used up)\b/.test(text)
    || /\b(?:exhausted|exceeded) (?:the )?quota\b/.test(text);
}

/**
 * Agnes sometimes returns an application-level rejection with HTTP 200 and
 * no task receipt when its render queue is full. That response is a definite
 * non-acceptance, not an ambiguous submission: there is no video_id to poll
 * and a later invocation may safely submit the locked request again.
 */
export function isAgnesProviderCapacityRejection(payload: unknown): boolean {
  const text = normalizedDiagnostics(payload);
  return /\b(?:(?:video(?: generation)?|render|request)\s+)?queue\s+(?:is\s+)?(?:full|at capacity)\b/.test(text)
    || /\b(?:(?:video(?: generation)?|render|request)\s+)?queue\s+(?:has\s+)?(?:reached|exceeded)\s+(?:its\s+)?capacity\b/.test(text);
}

export interface ClassifyAgnesErrorOptions {
  keyLabel?: string;
  keys?: readonly string[];
  retryAfterMs?: number;
  /** A syntactically successful POST without a usable receipt may have been accepted. */
  ambiguousSubmission?: boolean;
}

/** Classify a provider response without treating vague availability text as key exhaustion. */
export function classifyAgnesError(
  status: number,
  payload: unknown,
  fallback: string,
  options: ClassifyAgnesErrorOptions = {},
): AgnesError {
  const message = providerMessage(payload, fallback);
  const code = providerCode(payload);
  const diagnostics = normalizedDiagnostics(payload);
  const base = {
    status,
    ...(code === undefined ? {} : { code }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.keyLabel === undefined ? {} : { keyLabel: options.keyLabel }),
    response: payload,
    ...(options.keys === undefined ? {} : { keys: options.keys }),
  };

  // Server and credential failures are never rotation signals, even if their
  // untrusted prose happens to contain words such as "quota" or "rate".
  if (status >= 500) {
    return new AgnesError(message, {
      ...base,
      kind: "provider",
      ambiguousOutcome: true,
    });
  }
  if (status === 401 || status === 403) {
    return new AgnesError(message, { ...base, kind: "authentication" });
  }
  // A queue-capacity response explicitly says that no render was accepted.
  // Check it before generic HTTP 429 and the ambiguous-success fallback so it
  // neither rotates keys nor blocks reruns. Authentication and 5xx status
  // remain authoritative regardless of untrusted response prose.
  if (isAgnesProviderCapacityRejection(payload)) {
    return new AgnesError(message, { ...base, kind: "provider_capacity" });
  }
  if (status === 429) {
    return new AgnesError(message, { ...base, kind: "rate_limit" });
  }
  if (isRateLimited(diagnostics)) {
    return new AgnesError(message, { ...base, kind: "rate_limit" });
  }
  if (isDailyLimit(diagnostics)) {
    return new AgnesError(message, { ...base, kind: "daily_limit" });
  }
  if (isInsufficientCredits(diagnostics)) {
    return new AgnesError(message, { ...base, kind: "insufficient_credits" });
  }
  if (isQuotaExhausted(diagnostics)) {
    return new AgnesError(message, { ...base, kind: "quota_exhausted" });
  }
  if (options.ambiguousSubmission) {
    return new AgnesError(message, {
      ...base,
      kind: "ambiguous_submission",
      ambiguousOutcome: true,
    });
  }
  if (status === 400 || status === 422) {
    return new AgnesError(message, { ...base, kind: "validation" });
  }
  return new AgnesError(message, { ...base, kind: "provider" });
}
