import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { FreeAiMusicError } from "./errors.js";
import {
  freeAiMusicKeyLabel,
  loadFreeAiMusicKeys,
  normalizeFreeAiMusicKeys,
  redactFreeAiMusicSecrets,
} from "./keys.js";
import {
  FREE_AI_MUSIC_ENDPOINT,
  FREE_AI_MUSIC_MODEL,
  type FreeAiMusicClientOptions,
  type FreeAiMusicDownloadRequest,
  type FreeAiMusicDownloadResult,
  type FreeAiMusicFetch,
  type FreeAiMusicRequest,
  type FreeAiMusicResult,
  type FreeAiMusicSubmission,
} from "./types.js";

export const DEFAULT_FREE_AI_BASE_URL = "https://api.free.ai";
export const DEFAULT_FREE_AI_MUSIC_REQUEST_TIMEOUT_MS = 180_000;
export const DEFAULT_FREE_AI_MUSIC_RETRY_DELAY_MS = 6_000;
export const DEFAULT_FREE_AI_MUSIC_MAX_RETRIES = 3;
export const DEFAULT_FREE_AI_MUSIC_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

interface SubmittedMusic {
  url: string;
  keyLabel: string;
  generationAttempts: number;
  externalId?: string;
}

class RequestDeadlineError extends Error {}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredText(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new FreeAiMusicError(`${name} must not be empty`, { kind: "validation" });
  }
  return normalized;
}

function positiveInteger(name: string, value: number, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new FreeAiMusicError(`${name} must be an integer of at least ${minimum}`, {
      kind: "configuration",
    });
  }
  return value;
}

function finalDuration(value: number): number {
  if (!Number.isInteger(value) || value < 4 || value > 12) {
    throw new FreeAiMusicError("durationSeconds must be an integer from 4 through 12", {
      kind: "validation",
    });
  }
  return value;
}

function tempo(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 30 || value > 300) {
    throw new FreeAiMusicError("tempo must be an integer from 30 through 300", {
      kind: "validation",
    });
  }
  return value;
}

function responseRecords(payload: unknown): JsonRecord[] {
  const root = asRecord(payload);
  if (!root) return [];
  const data = asRecord(root.data);
  const result = asRecord(root.result);
  return [
    root,
    data,
    result,
    asRecord(root.job),
    asRecord(data?.job),
    asRecord(result?.job),
  ].filter((entry): entry is JsonRecord => Boolean(entry));
}

function musicUrl(payload: unknown): string | undefined {
  const records = responseRecords(payload);
  // Audio-specific fields always win over a generic root URL, which some
  // providers use for job or status resources.
  for (const record of records) {
    for (const field of ["audio_url", "audioUrl", "output_url", "outputUrl"] as const) {
      const value = nonEmptyString(record[field]);
      if (value) return value;
    }
  }
  const statuses = records
    .map((record) => nonEmptyString(record.status ?? record.state)?.toLowerCase().replace(/[\s-]+/g, "_"))
    .filter((value): value is string => Boolean(value));
  if (statuses.some((status) => !["completed", "complete", "succeeded", "success", "ready", "done"].includes(status))) {
    return undefined;
  }
  for (const record of records) {
    const value = nonEmptyString(record.url);
    if (value) return value;
  }
  return undefined;
}

function externalId(payload: unknown): string | undefined {
  for (const record of responseRecords(payload)) {
    for (const field of ["job_id", "jobId", "id"] as const) {
      const value = nonEmptyString(record[field]);
      if (value) return value;
    }
  }
  return undefined;
}

function providerMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim().slice(0, 2_048);
  for (const record of responseRecords(payload)) {
    const nestedError = asRecord(record.error);
    for (const value of [
      nestedError?.message,
      nestedError?.detail,
      record.error,
      record.error_message,
      record.errorMessage,
      record.message,
      record.detail,
      record.reason,
    ]) {
      const text = nonEmptyString(value);
      if (text) return text.slice(0, 2_048);
    }
  }
  return fallback;
}

function providerRejected(payload: unknown): boolean {
  const failedStatuses = new Set([
    "failed",
    "error",
    "errored",
    "rejected",
    "cancelled",
    "canceled",
    "expired",
    "aborted",
  ]);
  for (const record of responseRecords(payload)) {
    const status = nonEmptyString(record.status ?? record.state)?.toLowerCase();
    if (status && failedStatuses.has(status.replace(/[\s-]+/g, "_"))) return true;
    if (record.success === false || record.ok === false) return true;
    if (record.error !== undefined && record.error !== null && record.error !== false && record.error !== "") {
      return true;
    }
    if (nonEmptyString(record.error_message ?? record.errorMessage)) return true;
    if (Array.isArray(record.errors) && record.errors.length > 0) return true;
    if (record.errors && !Array.isArray(record.errors) && typeof record.errors === "object") return true;
  }
  return false;
}

function supportedAudioContentType(value: string | null): boolean {
  if (!value) return true;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return Boolean(
    mediaType?.startsWith("audio/")
    || mediaType === "application/octet-stream"
    || mediaType === "binary/octet-stream",
  );
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function invokeObserver(
  observer: FreeAiMusicRequest["onAttempt"],
  event: Parameters<NonNullable<FreeAiMusicRequest["onAttempt"]>>[0],
): void {
  try {
    observer?.(event);
  } catch {
    // Observability must not influence provider behavior.
  }
}

async function readBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new RequestDeadlineError("Free.ai music download was aborted");
  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
      reject(new RequestDeadlineError("Free.ai music download was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export class FreeAiMusicClient {
  readonly #keys: readonly string[];
  readonly #baseUrl: string;
  readonly #fetch: FreeAiMusicFetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #requestTimeoutMs: number;
  readonly #retryDelayMs: number;
  readonly #maxRetries: number;
  readonly #maxDownloadBytes: number;

  constructor(options: FreeAiMusicClientOptions = {}) {
    this.#keys = options.apiKeys === undefined
      ? loadFreeAiMusicKeys(options.env)
      : normalizeFreeAiMusicKeys(options.apiKeys);
    this.#baseUrl = (options.baseUrl ?? DEFAULT_FREE_AI_BASE_URL).replace(/\/+$/, "");
    try {
      const parsed = new URL(this.#baseUrl);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash
      ) throw new Error("unsupported URL");
    } catch (cause) {
      throw new FreeAiMusicError("Free.ai baseUrl must be an absolute HTTP(S) URL", {
        kind: "configuration",
        cause,
        keys: this.#keys,
      });
    }
    this.#requestTimeoutMs = positiveInteger(
      "requestTimeoutMs",
      options.requestTimeoutMs ?? DEFAULT_FREE_AI_MUSIC_REQUEST_TIMEOUT_MS,
      1_000,
    );
    this.#retryDelayMs = positiveInteger(
      "retryDelayMs",
      options.retryDelayMs ?? DEFAULT_FREE_AI_MUSIC_RETRY_DELAY_MS,
      0,
    );
    this.#maxRetries = positiveInteger(
      "maxRetries",
      options.maxRetries ?? DEFAULT_FREE_AI_MUSIC_MAX_RETRIES,
      0,
    );
    this.#maxDownloadBytes = positiveInteger(
      "maxDownloadBytes",
      options.maxDownloadBytes ?? DEFAULT_FREE_AI_MUSIC_MAX_DOWNLOAD_BYTES,
    );
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sleep = options.sleep
      ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  get keyCount(): number {
    return this.#keys.length;
  }

  get maxAttempts(): number {
    return this.#maxRetries + 1;
  }

  async generateMusic(request: FreeAiMusicRequest): Promise<FreeAiMusicResult> {
    const prompt = requiredText("prompt", request.prompt);
    const requestedDuration = finalDuration(request.durationSeconds);
    const providerDurationSeconds = Math.max(10, requestedDuration);
    const requestedTempo = tempo(request.tempo);
    const outputPath = requiredText("outputPath", request.outputPath);
    if (!this.#keys.length) {
      throw new FreeAiMusicError(
        "No Free.ai audio API key is configured; set FREE_AI_API_AUDIO_KEY_1 (and optionally _2, _3, ...)",
        { kind: "configuration", keys: this.#keys },
      );
    }

    const body = JSON.stringify({
      prompt,
      duration: providerDurationSeconds,
      model: FREE_AI_MUSIC_MODEL,
      ...(request.genre?.trim() ? { genre: request.genre.trim() } : {}),
      ...(requestedTempo === undefined ? {} : { tempo: requestedTempo }),
    });
    const submitted = await this.#submitWithRetries(body, request.onAttempt);
    const submission: FreeAiMusicSubmission = {
      ...submitted,
      model: FREE_AI_MUSIC_MODEL,
      providerDurationSeconds,
    };
    await request.onSubmitted?.(submission);
    const downloaded = await this.downloadMusic({
      url: submission.url,
      outputPath,
      ...(request.onAttempt ? { onAttempt: request.onAttempt } : {}),
    });
    return {
      ...submission,
      ...downloaded,
    };
  }

  /** Download an already-generated track without issuing another generation POST. */
  async downloadMusic(request: FreeAiMusicDownloadRequest): Promise<FreeAiMusicDownloadResult> {
    const outputPath = requiredText("outputPath", request.outputPath);
    const url = this.#mediaUrl(requiredText("url", request.url));
    const downloaded = await this.#downloadWithRetries(url, outputPath, request.onAttempt);
    return {
      filePath: outputPath,
      url,
      downloadAttempts: downloaded.attempts,
      ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
    };
  }

  async #submitWithRetries(
    body: string,
    observer: FreeAiMusicRequest["onAttempt"],
  ): Promise<SubmittedMusic> {
    let lastError: FreeAiMusicError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const keyIndex = (attempt - 1) % this.#keys.length;
      const key = this.#keys[keyIndex] as string;
      const keyLabel = freeAiMusicKeyLabel(keyIndex);
      invokeObserver(observer, {
        phase: "generation",
        attemptNumber: attempt,
        maxAttempts: this.maxAttempts,
        keyLabel,
      });
      try {
        const { response, payload } = await this.#withDeadline(
          "generation",
          keyLabel,
          async (signal) => {
            const response = await this.#fetch(
              new URL(FREE_AI_MUSIC_ENDPOINT, `${this.#baseUrl}/`),
              {
                method: "POST",
                headers: {
                  accept: "application/json",
                  authorization: `Bearer ${key}`,
                  "content-type": "application/json",
                },
                body,
                signal,
              },
            );
            return { response, payload: await responsePayload(response) };
          },
        );
        if (!response.ok) {
          const retryAfter = retryAfterMs(response);
          throw new FreeAiMusicError(
            providerMessage(payload, `Free.ai returned HTTP ${response.status}`),
            {
              kind: "http",
              status: response.status,
              ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
              keyLabel,
              response: redactFreeAiMusicSecrets(payload, this.#keys),
              keys: this.#keys,
            },
          );
        }
        if (providerRejected(payload)) {
          throw new FreeAiMusicError(
            providerMessage(payload, "Free.ai rejected the ACE-Step request"),
            {
              kind: "provider",
              status: response.status,
              keyLabel,
              response: redactFreeAiMusicSecrets(payload, this.#keys),
              keys: this.#keys,
            },
          );
        }
        const url = musicUrl(payload);
        if (!url) {
          throw new FreeAiMusicError(
            "Free.ai returned no audio URL for the synchronous ACE-Step request",
            {
              kind: "provider",
              status: response.status,
              keyLabel,
              response: redactFreeAiMusicSecrets(payload, this.#keys),
              keys: this.#keys,
            },
          );
        }
        const resultId = externalId(payload);
        return {
          url: this.#mediaUrl(url),
          keyLabel,
          generationAttempts: attempt,
          ...(resultId ? { externalId: resultId } : {}),
        };
      } catch (error) {
        lastError = this.#normalizeAttemptError(error, "generation", keyLabel);
        if (attempt >= this.maxAttempts) break;
        await this.#sleep(this.#retryDelay(lastError));
      }
    }
    const exhausted = lastError ?? new FreeAiMusicError("Free.ai music generation failed", {
      kind: "provider",
      keys: this.#keys,
    });
    exhausted.retryExhausted = true;
    throw exhausted;
  }

  async #downloadWithRetries(
    url: string,
    outputPath: string,
    observer: FreeAiMusicRequest["onAttempt"],
  ): Promise<{ attempts: number; contentType?: string }> {
    let lastError: FreeAiMusicError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      invokeObserver(observer, {
        phase: "download",
        attemptNumber: attempt,
        maxAttempts: this.maxAttempts,
      });
      try {
        const contentType = await this.#withDeadline(
          "download",
          undefined,
          async (signal) => {
            // Media URLs generally use CDN auth-by-URL. Never forward a
            // Free.ai bearer credential to the provider-selected host.
            const response = await this.#fetch(url, { method: "GET", signal });
            if (!response.ok || !response.body) {
              const payload = await responsePayload(response);
              const retryAfter = retryAfterMs(response);
              throw new FreeAiMusicError(
                providerMessage(payload, `Free.ai music download returned HTTP ${response.status}`),
                {
                  kind: "download",
                  status: response.status,
                  ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
                  response: redactFreeAiMusicSecrets(payload, this.#keys),
                  keys: this.#keys,
                },
              );
            }
            const responseContentType = response.headers.get("content-type")?.trim() ?? null;
            if (!supportedAudioContentType(responseContentType)) {
              const payload = await responsePayload(response);
              throw new FreeAiMusicError(
                providerMessage(
                  payload,
                  `Free.ai music download returned non-audio content type ${responseContentType}`,
                ),
                {
                  kind: "download",
                  status: response.status,
                  response: redactFreeAiMusicSecrets(payload, this.#keys),
                  keys: this.#keys,
                },
              );
            }
            const contentLength = Number(response.headers.get("content-length"));
            if (Number.isFinite(contentLength) && contentLength > this.#maxDownloadBytes) {
              await response.body.cancel().catch(() => undefined);
              throw new FreeAiMusicError(
                `Free.ai music exceeds the ${this.#maxDownloadBytes}-byte download limit`,
                { kind: "download", keys: this.#keys },
              );
            }
            await this.#persistBody(response.body, outputPath, signal);
            return responseContentType;
          },
        );
        return {
          attempts: attempt,
          ...(contentType ? { contentType } : {}),
        };
      } catch (error) {
        lastError = this.#normalizeAttemptError(error, "download");
        if (attempt >= this.maxAttempts) break;
        await this.#sleep(this.#retryDelay(lastError));
      }
    }
    const exhausted = lastError ?? new FreeAiMusicError("Free.ai music download failed", {
      kind: "download",
      keys: this.#keys,
    });
    exhausted.retryExhausted = true;
    throw exhausted;
  }

  async #withDeadline<T>(
    phase: "generation" | "download",
    keyLabel: string | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadlineError = new RequestDeadlineError(
      `Free.ai music ${phase} timed out after ${this.#requestTimeoutMs}ms`,
    );
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(deadlineError);
      }, this.#requestTimeoutMs);
    });
    try {
      return await Promise.race([
        operation(controller.signal),
        deadline,
      ]);
    } catch (error) {
      if (timedOut || error === deadlineError) {
        throw new FreeAiMusicError(deadlineError.message, {
          kind: "timeout",
          ...(keyLabel ? { keyLabel } : {}),
          keys: this.#keys,
        });
      }
      if (error instanceof FreeAiMusicError) throw error;
      throw new FreeAiMusicError(
        `Free.ai music ${phase} network failure: ${redactFreeAiMusicSecrets(
          error instanceof Error ? error.message : error,
          this.#keys,
        )}`,
        {
          kind: phase === "download" ? "download" : "network",
          ...(keyLabel ? { keyLabel } : {}),
          cause: error,
          keys: this.#keys,
        },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #normalizeAttemptError(
    error: unknown,
    phase: "generation" | "download",
    keyLabel?: string,
  ): FreeAiMusicError {
    if (error instanceof FreeAiMusicError) return error;
    return new FreeAiMusicError(
      `Free.ai music ${phase} failed: ${redactFreeAiMusicSecrets(
        error instanceof Error ? error.message : error,
        this.#keys,
      )}`,
      {
        kind: phase === "download" ? "download" : "provider",
        ...(keyLabel ? { keyLabel } : {}),
        cause: error,
        keys: this.#keys,
      },
    );
  }

  #retryDelay(error: FreeAiMusicError): number {
    if (error.retryAfterMs === undefined) return this.#retryDelayMs;
    // Do not turn a bounded retry cycle into an hours-long invocation.
    return Math.max(this.#retryDelayMs, Math.min(error.retryAfterMs, 30_000));
  }

  #mediaUrl(value: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value, `${this.#baseUrl}/`);
    } catch {
      throw new FreeAiMusicError("Free.ai returned an invalid audio URL", {
        kind: "provider",
        keys: this.#keys,
      });
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
    ) {
      throw new FreeAiMusicError("Free.ai returned an unsafe audio URL", {
        kind: "provider",
        keys: this.#keys,
      });
    }
    return parsed.toString();
  }

  async #persistBody(
    body: ReadableStream<Uint8Array>,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(outputPath), { recursive: true });
    const handle = await open(temporaryPath, "wx", 0o600);
    const reader = body.getReader();
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      while (true) {
        const chunk = await readBodyChunk(reader, signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.#maxDownloadBytes) {
          await reader.cancel().catch(() => undefined);
          throw new FreeAiMusicError(
            `Free.ai music exceeds the ${this.#maxDownloadBytes}-byte download limit`,
            { kind: "download", keys: this.#keys },
          );
        }
        await handle.writeFile(chunk.value);
        hash.update(chunk.value);
      }
      if (signal.aborted) throw new RequestDeadlineError("Free.ai music download was aborted");
      if (bytes === 0 || hash.digest("hex") === createHash("sha256").update("").digest("hex")) {
        throw new FreeAiMusicError("Free.ai returned an empty music file", {
          kind: "download",
          keys: this.#keys,
        });
      }
      await handle.sync();
      if (signal.aborted) throw new RequestDeadlineError("Free.ai music download was aborted");
      await handle.close();
      await rename(temporaryPath, outputPath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
