import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { AgnesError, classifyAgnesError } from "./errors.js";
import {
  agnesKeyLabel,
  fingerprintAgnesKey,
  loadAgnesApiKeys,
  normalizeAgnesApiKeys,
  redactAgnesSecrets,
  sanitizeAgnesSecrets,
} from "./keys.js";
import {
  AGNES_ASPECT_RATIOS,
  AGNES_DEFAULT_BASE_URL,
  AGNES_VIDEO_MODEL,
  type AgnesClientOptions,
  type AgnesDownloadOptions,
  type AgnesDownloadResult,
  type AgnesFetch,
  type AgnesPollOptions,
  type AgnesPollResult,
  type AgnesSubmitVideoRequest,
  type AgnesTaskStatus,
  type AgnesVideoTask,
} from "./types.js";

export const DEFAULT_AGNES_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_AGNES_POLL_WINDOW_MS = 8 * 60_000;
export const DEFAULT_AGNES_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_AGNES_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

interface ConfiguredKey {
  key: string;
  keyLabel: string;
  keyFingerprint: string;
}

interface ReadPayloadResult {
  payload: unknown;
  malformedJson: boolean;
}

class InvalidTaskResponse extends Error {}

class AgnesRequestTimedOut extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Agnes API request timed out after ${timeoutMs}ms`);
    this.name = "AgnesRequestTimedOut";
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function responseTaskRecord(payload: unknown): JsonRecord | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const data = asRecord(root.data);
  const candidates = [asRecord(root.task), asRecord(data?.task), data, root];
  return candidates.find((candidate) => candidate && (
    candidate.status !== undefined
    || candidate.video_id !== undefined
    || candidate.task_id !== undefined
    || candidate.id !== undefined
  )) ?? root;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeStatus(value: unknown): AgnesTaskStatus | undefined {
  if (typeof value !== "string") return undefined;
  const status = value.trim().toLowerCase();
  return status === "queued"
    || status === "in_progress"
    || status === "completed"
    || status === "failed"
    ? status
    : undefined;
}

function normalizeTask(
  payload: unknown,
  configuredKey: ConfiguredKey,
  fallback?: AgnesVideoTask,
): AgnesVideoTask {
  const data = responseTaskRecord(payload);
  if (!data) throw new InvalidTaskResponse("Agnes returned a non-object task response");

  const responseModel = nonEmptyString(data.model);
  if (responseModel && responseModel !== AGNES_VIDEO_MODEL) {
    throw new InvalidTaskResponse("Agnes returned a task for an unexpected model");
  }

  const videoId = nonEmptyString(data.video_id) ?? fallback?.video_id;
  if (!videoId) throw new InvalidTaskResponse("Agnes response is missing video_id");
  if (fallback && nonEmptyString(data.video_id) && videoId !== fallback.video_id) {
    throw new InvalidTaskResponse("Agnes returned a different video_id during retrieval");
  }

  const taskId = nonEmptyString(data.task_id)
    ?? nonEmptyString(data.id)
    ?? fallback?.task_id
    ?? fallback?.id;
  const id = nonEmptyString(data.id)
    ?? nonEmptyString(data.task_id)
    ?? fallback?.id
    ?? fallback?.task_id;
  if (!taskId || !id) {
    throw new InvalidTaskResponse("Agnes response is missing both task_id and id");
  }

  const status = normalizeStatus(data.status);
  if (!status) throw new InvalidTaskResponse("Agnes response has no supported status");
  const progress = numericField(data.progress);
  if (progress === undefined || progress < 0 || progress > 100) {
    throw new InvalidTaskResponse("Agnes response has invalid progress");
  }

  const metadata = asRecord(data.metadata);
  // The public documentation shows metadata.url, while the live
  // agnes-video-2.5-flash retrieval endpoint currently returns url at the
  // task root. Canonicalize both observed provider shapes for downstream
  // persistence and download handling.
  const metadataUrl = nonEmptyString(metadata?.url) ?? nonEmptyString(data.url);
  const object = nonEmptyString(data.object);
  const createdAt = numericField(data.created_at);
  const completedAt = data.completed_at === null ? null : numericField(data.completed_at);
  const seconds = typeof data.seconds === "number"
    ? String(data.seconds)
    : nonEmptyString(data.seconds);
  const size = nonEmptyString(data.size);

  return {
    id,
    task_id: taskId,
    video_id: videoId,
    model: AGNES_VIDEO_MODEL,
    status,
    progress,
    keyLabel: configuredKey.keyLabel,
    keyFingerprint: configuredKey.keyFingerprint,
    ...(object === undefined ? {} : { object }),
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    ...(completedAt === undefined ? {} : { completed_at: completedAt }),
    ...(seconds === undefined ? {} : { seconds }),
    ...(size === undefined ? {} : { size }),
    ...(metadataUrl === undefined
      ? metadata === undefined ? {} : { metadata: {} }
      : { metadata: { url: metadataUrl } }),
    ...(data.error === undefined ? {} : {
      error: sanitizeAgnesSecrets(data.error, [configuredKey.key]),
    }),
  };
}

function requiredPrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt) {
    throw new AgnesError("prompt must not be empty", { kind: "validation" });
  }
  return prompt;
}

function validDuration(value: number): number {
  if (!Number.isInteger(value) || value < 4 || value > 12) {
    throw new AgnesError("seconds must be an integer from 4 to 12", { kind: "validation" });
  }
  return value;
}

function validAspectRatio(value: string): asserts value is AgnesSubmitVideoRequest["aspectRatio"] {
  if (!(AGNES_ASPECT_RATIOS as readonly string[]).includes(value)) {
    throw new AgnesError(
      `aspectRatio must be one of: ${AGNES_ASPECT_RATIOS.join(", ")}`,
      { kind: "validation" },
    );
  }
}

function finiteMilliseconds(name: string, value: number, allowZero: boolean): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new AgnesError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`, {
      kind: "validation",
    });
  }
  return value;
}

async function readPayload(response: Response): Promise<ReadPayloadResult> {
  const text = await response.text();
  if (!text.trim()) return { payload: {}, malformedJson: false };
  try {
    return { payload: JSON.parse(text) as unknown, malformedJson: false };
  } catch {
    return { payload: text, malformedJson: true };
  }
}

function retryAfterFromPayload(payload: unknown): number | undefined {
  const root = asRecord(payload);
  const error = asRecord(root?.error);
  const detail = asRecord(root?.detail);
  for (const record of [root, error, detail]) {
    if (!record) continue;
    for (const field of ["retry_after_ms", "retryAfterMs"] as const) {
      const amount = numericField(record[field]);
      if (amount !== undefined && amount >= 0) return amount;
    }
    for (const field of ["retry_after", "retry_after_seconds", "retryAfterSeconds"] as const) {
      const amount = numericField(record[field]);
      if (amount !== undefined && amount >= 0) return amount * 1_000;
    }
  }
  return undefined;
}

function retryAfterFromResponse(response: Response, payload: unknown, now: () => number): number | undefined {
  const header = response.headers.get("retry-after")?.trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const instant = Date.parse(header);
    if (Number.isFinite(instant)) return Math.max(0, instant - now());
  }
  return retryAfterFromPayload(payload);
}

function safeThrownMessage(error: unknown, keys: readonly string[]): string {
  return redactAgnesSecrets(error instanceof Error ? error.message : error, keys);
}

function positiveMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgnesError("maxBytes must be a positive safe integer", { kind: "validation" });
  }
  return value;
}

interface AgnesEndpoints {
  createVideo: string;
  retrieveVideo: string;
}

function resolveAgnesEndpoints(baseUrl: string): AgnesEndpoints {
  const normalized = baseUrl.trim();
  if (!normalized) {
    throw new AgnesError("baseUrl must not be empty", { kind: "validation" });
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new AgnesError("baseUrl must be an absolute HTTP or HTTPS URL", {
      kind: "validation",
    });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AgnesError("baseUrl must use HTTP or HTTPS", { kind: "validation" });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AgnesError("baseUrl must not contain credentials, a query, or a fragment", {
      kind: "validation",
    });
  }

  const suppliedPath = parsed.pathname.replace(/\/+$/, "");
  const hasVersionSuffix = suppliedPath.endsWith("/v1");
  const providerRoot = hasVersionSuffix ? suppliedPath.slice(0, -3) : suppliedPath;
  const createPath = hasVersionSuffix
    ? `${suppliedPath}/videos`
    : `${suppliedPath}/v1/videos`;
  const retrievalPath = `${providerRoot}/agnesapi`;

  const createUrl = new URL(parsed.toString());
  createUrl.pathname = createPath || "/v1/videos";
  const retrieveUrl = new URL(parsed.toString());
  retrieveUrl.pathname = retrievalPath || "/agnesapi";
  return {
    createVideo: createUrl.toString(),
    retrieveVideo: retrieveUrl.toString(),
  };
}

/** Return the only documented final-output location, rejecting aliases and non-HTTPS URLs. */
export function completedAgnesVideoUrl(task: AgnesVideoTask): string {
  if (task.status !== "completed") {
    throw new AgnesError("Agnes video is not completed", { kind: "validation" });
  }
  const candidate = task.metadata?.url?.trim();
  if (!candidate) {
    throw new AgnesError("Completed Agnes task is missing its output URL", { kind: "provider" });
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AgnesError("Completed Agnes task has an invalid output URL", { kind: "provider" });
  }
  if (parsed.protocol !== "https:") {
    throw new AgnesError("Completed Agnes task output URL must use HTTPS", {
      kind: "provider",
    });
  }
  return candidate;
}

export class AgnesVideoClient {
  private readonly keys: readonly ConfiguredKey[];
  private readonly fetch: AgnesFetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly pollWindowMs: number;
  private readonly maxDownloadBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly endpoints: AgnesEndpoints;

  constructor(options: AgnesClientOptions = {}) {
    const rawKeys = options.apiKeys === undefined
      ? loadAgnesApiKeys(options.env)
      : normalizeAgnesApiKeys(options.apiKeys);
    this.keys = rawKeys.map((key, index) => ({
      key,
      keyLabel: agnesKeyLabel(index),
      keyFingerprint: fingerprintAgnesKey(key),
    }));
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.endpoints = resolveAgnesEndpoints(options.baseUrl ?? AGNES_DEFAULT_BASE_URL);
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = finiteMilliseconds(
      "pollIntervalMs",
      options.pollIntervalMs ?? DEFAULT_AGNES_POLL_INTERVAL_MS,
      false,
    );
    this.pollWindowMs = finiteMilliseconds(
      "pollWindowMs",
      options.pollWindowMs ?? DEFAULT_AGNES_POLL_WINDOW_MS,
      true,
    );
    this.maxDownloadBytes = positiveMaxBytes(
      options.maxDownloadBytes ?? DEFAULT_AGNES_MAX_DOWNLOAD_BYTES,
    );
    this.requestTimeoutMs = finiteMilliseconds(
      "requestTimeoutMs",
      options.requestTimeoutMs ?? DEFAULT_AGNES_REQUEST_TIMEOUT_MS,
      false,
    );
  }

  private async requestJson(
    url: string | URL,
    init: RequestInit,
  ): Promise<{ response: Response; result: ReadPayloadResult }> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new AgnesRequestTimedOut(this.requestTimeoutMs);
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError);
      }, this.requestTimeoutMs);
    });
    const request = (async () => {
      const response = await this.fetch(url, { ...init, signal: controller.signal });
      return { response, result: await readPayload(response) };
    })();

    try {
      return await Promise.race([request, deadline]);
    } catch (error) {
      if (timedOut && !(error instanceof AgnesRequestTimedOut)) throw timeoutError;
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async submitVideo(request: AgnesSubmitVideoRequest): Promise<AgnesVideoTask> {
    const prompt = requiredPrompt(request.prompt);
    const seconds = validDuration(request.seconds);
    validAspectRatio(request.aspectRatio);
    if (this.keys.length === 0) {
      throw new AgnesError(
        "No Agnes API key configured; set AGNES_API_KEY_1 (or AGNES_API_KEY)",
        { kind: "configuration" },
      );
    }

    const payload = {
      model: AGNES_VIDEO_MODEL,
      prompt,
      seconds: String(seconds),
      mode: "text",
      size: "720P",
      aspect_ratio: request.aspectRatio,
      n: 1,
    } as const;
    const body = JSON.stringify(payload);
    const rawKeys = this.keys.map(({ key }) => key);

    for (let index = 0; index < this.keys.length; index += 1) {
      const configuredKey = this.keys[index];
      if (!configuredKey) continue;
      try {
        request.onAttempt?.({ keyLabel: configuredKey.keyLabel });
      } catch {
        // Diagnostics callbacks must not influence submission behavior.
      }
      let response: Response;
      let result: ReadPayloadResult;
      try {
        ({ response, result } = await this.requestJson(this.endpoints.createVideo, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${configuredKey.key}`,
            "content-type": "application/json",
          },
          body,
        }));
      } catch (error) {
        if (error instanceof AgnesRequestTimedOut) {
          throw new AgnesError(error.message, {
            kind: "timeout",
            keyLabel: configuredKey.keyLabel,
            keys: rawKeys,
            ambiguousOutcome: true,
          });
        }
        throw new AgnesError(
          `Agnes submission network failure: ${safeThrownMessage(error, rawKeys)}`,
          {
            kind: "network",
            keyLabel: configuredKey.keyLabel,
            keys: rawKeys,
            ambiguousOutcome: true,
          },
        );
      }

      if (response.ok && !result.malformedJson) {
        try {
          const task = normalizeTask(result.payload, configuredKey);
          if (task.status === "failed" && task.error !== undefined) {
            const retryAfterMs = retryAfterFromResponse(response, result.payload, this.now);
            const failedTaskError = classifyAgnesError(
              response.status,
              result.payload,
              "Agnes rejected the submitted video task",
              {
                keyLabel: configuredKey.keyLabel,
                keys: rawKeys,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
              },
            );
            if (failedTaskError.mayTryAnotherKey && index + 1 < this.keys.length) continue;
            if (failedTaskError.mayTryAnotherKey) {
              failedTaskError.rotationExhausted = true;
              throw failedTaskError;
            }
          }
          return task;
        } catch (error) {
          if (!(error instanceof InvalidTaskResponse)) throw error;
          const classified = classifyAgnesError(
            response.status,
            result.payload,
            error.message,
            {
              keyLabel: configuredKey.keyLabel,
              keys: rawKeys,
              ...(() => {
                const retryAfterMs = retryAfterFromResponse(response, result.payload, this.now);
                return retryAfterMs === undefined ? {} : { retryAfterMs };
              })(),
              ambiguousSubmission: true,
            },
          );
          if (classified.mayTryAnotherKey && index + 1 < this.keys.length) continue;
          if (classified.mayTryAnotherKey) classified.rotationExhausted = true;
          throw classified;
        }
      }

      const classified = classifyAgnesError(
        response.status,
        result.payload,
        result.malformedJson
          ? `Agnes returned non-JSON HTTP ${response.status}`
          : `Agnes returned HTTP ${response.status}`,
        {
          keyLabel: configuredKey.keyLabel,
          keys: rawKeys,
          ...(() => {
            const retryAfterMs = retryAfterFromResponse(response, result.payload, this.now);
            return retryAfterMs === undefined ? {} : { retryAfterMs };
          })(),
          ambiguousSubmission: response.ok,
        },
      );
      if (classified.mayTryAnotherKey && index + 1 < this.keys.length) continue;
      if (classified.mayTryAnotherKey) classified.rotationExhausted = true;
      throw classified;
    }

    throw new AgnesError("No usable Agnes API key remained", { kind: "configuration" });
  }

  /** Retrieve with the exact submitting key selected by the persisted full fingerprint. */
  async retrieveVideo(task: AgnesVideoTask): Promise<AgnesVideoTask> {
    const configuredKey = this.keys.find(({ keyFingerprint }) => (
      keyFingerprint === task.keyFingerprint
    ));
    if (!configuredKey) {
      throw new AgnesError(
        "The Agnes API key used for this video is no longer configured",
        { kind: "configuration", keyLabel: task.keyLabel },
      );
    }
    if (!task.video_id.trim()) {
      throw new AgnesError("video_id must not be empty", { kind: "validation" });
    }

    const url = new URL(this.endpoints.retrieveVideo);
    url.searchParams.set("video_id", task.video_id);
    url.searchParams.set("model_name", AGNES_VIDEO_MODEL);
    let response: Response;
    let result: ReadPayloadResult;
    try {
      ({ response, result } = await this.requestJson(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${configuredKey.key}`,
        },
      }));
    } catch (error) {
      if (error instanceof AgnesRequestTimedOut) {
        throw new AgnesError(error.message, {
          kind: "timeout",
          keyLabel: configuredKey.keyLabel,
          keys: [configuredKey.key],
        });
      }
      throw new AgnesError(
        `Agnes retrieval network failure: ${safeThrownMessage(error, [configuredKey.key])}`,
        {
          kind: "network",
          keyLabel: configuredKey.keyLabel,
          keys: [configuredKey.key],
        },
      );
    }
    if (!response.ok || result.malformedJson) {
      throw classifyAgnesError(
        response.status,
        result.payload,
        result.malformedJson
          ? `Agnes returned non-JSON HTTP ${response.status}`
          : `Agnes returned HTTP ${response.status}`,
        {
          keyLabel: configuredKey.keyLabel,
          keys: [configuredKey.key],
          ...(() => {
            const retryAfterMs = retryAfterFromResponse(response, result.payload, this.now);
            return retryAfterMs === undefined ? {} : { retryAfterMs };
          })(),
        },
      );
    }

    try {
      return normalizeTask(result.payload, configuredKey, task);
    } catch (error) {
      if (!(error instanceof InvalidTaskResponse)) throw error;
      throw new AgnesError(error.message, {
        kind: "provider",
        status: response.status,
        keyLabel: configuredKey.keyLabel,
        response: result.payload,
        keys: [configuredKey.key],
      });
    }
  }

  async pollUntilTerminal(
    initialTask: AgnesVideoTask,
    options: AgnesPollOptions = {},
  ): Promise<AgnesPollResult> {
    const interval = finiteMilliseconds(
      "pollIntervalMs",
      options.pollIntervalMs ?? this.pollIntervalMs,
      false,
    );
    const window = finiteMilliseconds(
      "pollWindowMs",
      options.pollWindowMs ?? this.pollWindowMs,
      true,
    );
    const now = options.now ?? this.now;
    const sleep = options.sleep ?? this.sleep;
    const startedAt = now();
    let scheduledElapsedMs = 0;
    let latest = initialTask;
    let firstPoll = true;

    while (firstPoll || Math.max(0, now() - startedAt, scheduledElapsedMs) <= window) {
      firstPoll = false;
      try {
        latest = await this.retrieveVideo(latest);
        await options.onPoll?.(latest);
        // A completed render is only ready for the caller when Agnes also
        // exposes its media capability URL. Some responses briefly report
        // completed/100 before the URL materializes, so keep polling inside
        // the same window instead of ending early with an undownloadable task.
        if (latest.status === "completed" && latest.metadata?.url) {
          completedAgnesVideoUrl(latest);
          return { outcome: "completed", task: latest };
        }
        if (latest.status === "failed") return { outcome: "failed", task: latest };
      } catch (error) {
        const transient = error instanceof AgnesError
          && ["timeout", "network", "provider", "provider_capacity", "rate_limit"].includes(error.kind);
        if (!transient) throw error;
        await options.onPollError?.(error, latest);
      }

      const elapsed = Math.max(0, now() - startedAt, scheduledElapsedMs);
      const remaining = window - elapsed;
      if (remaining <= 0) return { outcome: "timed_out", task: latest };
      const delay = Math.min(interval, remaining);
      await sleep(delay);
      scheduledElapsedMs += delay;
    }

    return { outcome: "timed_out", task: latest };
  }

  /** Download the normalized output URL to a temporary file, then atomically publish it. */
  async downloadCompletedVideo(
    task: AgnesVideoTask,
    outputPath: string,
    options: AgnesDownloadOptions = {},
  ): Promise<AgnesDownloadResult> {
    const url = completedAgnesVideoUrl(task);
    if (!outputPath.trim()) {
      throw new AgnesError("outputPath must not be empty", { kind: "validation" });
    }
    const maximum = positiveMaxBytes(options.maxBytes ?? this.maxDownloadBytes);
    let response: Response;
    try {
      // Deliberately no headers: the output URL is a media capability, not an API endpoint.
      response = await this.fetch(url, { method: "GET" });
    } catch (error) {
      throw new AgnesError(
        `Agnes media download failed: ${safeThrownMessage(error, this.keys.map(({ key }) => key))}`,
        { kind: "download", keys: this.keys.map(({ key }) => key) },
      );
    }
    if (!response.ok) {
      throw new AgnesError(`Agnes media download returned HTTP ${response.status}`, {
        kind: "download",
        status: response.status,
      });
    }

    const declaredLength = numericField(response.headers.get("content-length"));
    if (declaredLength !== undefined && declaredLength > maximum) {
      await response.body?.cancel().catch(() => undefined);
      throw new AgnesError(`Agnes media exceeds the ${maximum}-byte download limit`, {
        kind: "download",
      });
    }
    if (!response.body) {
      throw new AgnesError("Agnes media response has no body", { kind: "download" });
    }

    const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(outputPath), { recursive: true });
    } catch (error) {
      throw new AgnesError(
        `Could not create Agnes output directory: ${safeThrownMessage(
          error,
          this.keys.map(({ key }) => key),
        )}`,
        { kind: "download", keys: this.keys.map(({ key }) => key) },
      );
    }
    const handle = await open(temporaryPath, "wx", 0o600).catch((error: unknown): never => {
      throw new AgnesError(
        `Could not create temporary Agnes media file: ${safeThrownMessage(
          error,
          this.keys.map(({ key }) => key),
        )}`,
        { kind: "download", keys: this.keys.map(({ key }) => key) },
      );
    });
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (bytes + chunk.value.byteLength > maximum) {
          await reader.cancel().catch(() => undefined);
          throw new AgnesError(`Agnes media exceeds the ${maximum}-byte download limit`, {
            kind: "download",
          });
        }
        await handle.writeFile(chunk.value);
        hash.update(chunk.value);
        bytes += chunk.value.byteLength;
      }
      if (bytes === 0) {
        throw new AgnesError("Agnes media response was empty", { kind: "download" });
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof AgnesError) throw error;
      throw new AgnesError(
        `Could not persist Agnes media: ${safeThrownMessage(
          error,
          this.keys.map(({ key }) => key),
        )}`,
        { kind: "download", keys: this.keys.map(({ key }) => key) },
      );
    }
    try {
      await handle.close();
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new AgnesError(
        `Could not close temporary Agnes media file: ${safeThrownMessage(
          error,
          this.keys.map(({ key }) => key),
        )}`,
        { kind: "download", keys: this.keys.map(({ key }) => key) },
      );
    }

    try {
      await rename(temporaryPath, outputPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new AgnesError(
        `Could not publish Agnes media atomically: ${safeThrownMessage(
          error,
          this.keys.map(({ key }) => key),
        )}`,
        { kind: "download", keys: this.keys.map(({ key }) => key) },
      );
    }

    const contentType = response.headers.get("content-type")?.trim();
    return {
      outputPath,
      url,
      bytes,
      sha256: hash.digest("hex"),
      ...(contentType ? { contentType } : {}),
    };
  }
}

/** Short alias matching the surrounding provider-client naming convention. */
export { AgnesVideoClient as AgnesClient };
