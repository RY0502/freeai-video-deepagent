import { redactFreeAiMusicSecrets } from "./keys.js";

export type FreeAiMusicErrorKind =
  | "configuration"
  | "validation"
  | "http"
  | "provider"
  | "network"
  | "timeout"
  | "download";

export interface FreeAiMusicErrorOptions {
  kind: FreeAiMusicErrorKind;
  status?: number;
  retryAfterMs?: number;
  keyLabel?: string;
  response?: unknown;
  cause?: unknown;
  keys?: readonly string[];
  retryExhausted?: boolean;
}

export class FreeAiMusicError extends Error {
  readonly kind: FreeAiMusicErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly keyLabel: string | undefined;
  readonly response: unknown;
  retryExhausted: boolean;

  constructor(message: string, options: FreeAiMusicErrorOptions) {
    super(redactFreeAiMusicSecrets(message, options.keys), {
      cause: options.cause === undefined
        ? undefined
        : redactFreeAiMusicSecrets(
            options.cause instanceof Error ? options.cause.message : options.cause,
            options.keys,
          ),
    });
    this.name = "FreeAiMusicError";
    this.kind = options.kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.keyLabel = options.keyLabel;
    this.response = options.response;
    this.retryExhausted = options.retryExhausted ?? false;
  }
}
