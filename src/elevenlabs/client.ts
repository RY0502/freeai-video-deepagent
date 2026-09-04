import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { classifyElevenLabsError, ElevenLabsError } from "./errors.js";
import {
  elevenLabsKeyLabel,
  loadElevenLabsApiKeys,
  normalizeElevenLabsApiKeys,
} from "./keys.js";
import type {
  ElevenLabsClientOptions,
  ElevenLabsFetch,
  ElevenLabsMusicRequest,
  ElevenLabsMusicResult,
  ElevenLabsRequestAttemptCallback,
  ElevenLabsSoundEffectRequest,
  ElevenLabsSoundEffectResult,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const SOUND_EFFECT_MODEL = "eleven_text_to_sound_v2" as const;
const MUSIC_MODEL = "music_v2" as const;
const OUTPUT_FORMAT = "mp3_44100_128";
const OUTPUT_CONTENT_TYPE = "audio/mpeg" as const;
const MAXIMUM_SOUND_EFFECT_TEXT_LENGTH = 450;
const MAXIMUM_MUSIC_PROMPT_LENGTH = 4_100;

interface AudioGenerationSpec {
  operation: "sound-effect" | "music";
  endpoint: string;
  body: string;
  outputPath: string;
  onAttempt?: ElevenLabsRequestAttemptCallback;
}

interface GeneratedAudio {
  filePath: string;
  keyLabel: string;
  requestId?: string;
  characterCost?: string;
  songId?: string;
}

function requiredText(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ElevenLabsError(`${name} must not be empty`, { kind: "validation" });
  }
  return normalized;
}

function numberInRange(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ElevenLabsError(`${name} must be from ${minimum} through ${maximum}`, {
      kind: "validation",
    });
  }
  return value;
}

function retryAfterMilliseconds(response: Response, now: () => number): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now()) : undefined;
}

async function errorPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { detail: { message: text } };
  }
}

function optionalHeader(response: Response, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = response.headers.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

export class ElevenLabsClient {
  readonly #keys: readonly string[];
  readonly #baseUrl: string;
  readonly #fetch: ElevenLabsFetch;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;
  #requestGate: Promise<void> = Promise.resolve();

  constructor(options: ElevenLabsClientOptions = {}) {
    this.#keys = options.apiKeys === undefined
      ? loadElevenLabsApiKeys(options.env)
      : normalizeElevenLabsApiKeys(options.apiKeys);
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    try {
      const parsed = new URL(this.#baseUrl);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        || parsed.username
        || parsed.password
      ) {
        throw new Error("unsupported URL");
      }
    } catch (cause) {
      throw new ElevenLabsError("ElevenLabs baseUrl must be an absolute HTTP(S) URL", {
        kind: "configuration",
        cause,
        keys: this.#keys,
      });
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new ElevenLabsError("ElevenLabs requestTimeoutMs must be a positive integer", {
        kind: "configuration",
        keys: this.#keys,
      });
    }
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
  }

  get keyCount(): number {
    return this.#keys.length;
  }

  async generateSoundEffect(
    request: ElevenLabsSoundEffectRequest,
  ): Promise<ElevenLabsSoundEffectResult> {
    return this.#serialize(() => this.#generateSoundEffect(request));
  }

  async composeMusic(request: ElevenLabsMusicRequest): Promise<ElevenLabsMusicResult> {
    return this.#serialize(() => this.#composeMusic(request));
  }

  async #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#requestGate;
    let release!: () => void;
    this.#requestGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #generateSoundEffect(
    request: ElevenLabsSoundEffectRequest,
  ): Promise<ElevenLabsSoundEffectResult> {
    const text = requiredText("text", request.text);
    if (text.length > MAXIMUM_SOUND_EFFECT_TEXT_LENGTH) {
      throw new ElevenLabsError(
        `text must be at most ${MAXIMUM_SOUND_EFFECT_TEXT_LENGTH} characters`,
        { kind: "validation" },
      );
    }
    const durationSeconds = numberInRange(
      "durationSeconds",
      request.durationSeconds,
      0.5,
      30,
    );
    const promptInfluence = numberInRange(
      "promptInfluence",
      request.promptInfluence ?? 0.3,
      0,
      1,
    );
    const outputPath = requiredText("outputPath", request.outputPath);

    const generated = await this.#generateAudio({
      operation: "sound-effect",
      endpoint: `/v1/sound-generation?output_format=${OUTPUT_FORMAT}`,
      body: JSON.stringify({
        text,
        loop: request.loop ?? false,
        duration_seconds: durationSeconds,
        prompt_influence: promptInfluence,
        model_id: SOUND_EFFECT_MODEL,
      }),
      outputPath,
      ...(request.onAttempt ? { onAttempt: request.onAttempt } : {}),
    });
    const result: ElevenLabsSoundEffectResult = {
      filePath: generated.filePath,
      contentType: OUTPUT_CONTENT_TYPE,
      model: SOUND_EFFECT_MODEL,
      keyLabel: generated.keyLabel,
    };
    if (generated.requestId) result.requestId = generated.requestId;
    if (generated.characterCost) result.characterCost = generated.characterCost;
    return result;
  }

  async #composeMusic(request: ElevenLabsMusicRequest): Promise<ElevenLabsMusicResult> {
    const prompt = requiredText("prompt", request.prompt);
    if (prompt.length > MAXIMUM_MUSIC_PROMPT_LENGTH) {
      throw new ElevenLabsError(
        `prompt must be at most ${MAXIMUM_MUSIC_PROMPT_LENGTH} characters`,
        { kind: "validation" },
      );
    }
    const durationSeconds = numberInRange(
      "durationSeconds",
      request.durationSeconds,
      3,
      600,
    );
    const musicLengthMs = durationSeconds * 1_000;
    if (!Number.isSafeInteger(musicLengthMs)) {
      throw new ElevenLabsError("durationSeconds must resolve to a whole number of milliseconds", {
        kind: "validation",
      });
    }
    const outputPath = requiredText("outputPath", request.outputPath);

    const generated = await this.#generateAudio({
      operation: "music",
      endpoint: `/v1/music?output_format=${OUTPUT_FORMAT}`,
      body: JSON.stringify({
        prompt,
        music_length_ms: musicLengthMs,
        model_id: MUSIC_MODEL,
        force_instrumental: true,
      }),
      outputPath,
      ...(request.onAttempt ? { onAttempt: request.onAttempt } : {}),
    });
    const result: ElevenLabsMusicResult = {
      filePath: generated.filePath,
      contentType: OUTPUT_CONTENT_TYPE,
      model: MUSIC_MODEL,
      keyLabel: generated.keyLabel,
    };
    if (generated.songId) result.songId = generated.songId;
    if (generated.requestId) result.requestId = generated.requestId;
    if (generated.characterCost) result.characterCost = generated.characterCost;
    return result;
  }

  async #generateAudio(spec: AudioGenerationSpec): Promise<GeneratedAudio> {
    if (!this.#keys.length) {
      throw new ElevenLabsError(
        "No ElevenLabs API key is configured; set ELEVENLABS_API_KEY_1 (and optionally _2, _3, ...)",
        { kind: "configuration", keys: this.#keys },
      );
    }

    const rotatableErrors: ElevenLabsError[] = [];
    for (let keyIndex = 0; keyIndex < this.#keys.length; keyIndex += 1) {
      const key = this.#keys[keyIndex];
      if (!key) continue;
      const label = elevenLabsKeyLabel(keyIndex);
      try {
        spec.onAttempt?.({ keyLabel: label });
      } catch {
        // Observability callbacks must never change generation behavior.
      }

      const response = await this.#request(spec, key, label);
      if (!response.ok) {
        let payload: unknown;
        try {
          payload = await errorPayload(response);
        } catch (cause) {
          throw new ElevenLabsError("Could not read the ElevenLabs error response", {
            kind: "network",
            status: response.status,
            keyLabel: label,
            ambiguousOutcome: true,
            cause,
            keys: this.#keys,
          });
        }
        const classified = classifyElevenLabsError(
          response.status,
          payload,
          `ElevenLabs returned HTTP ${response.status}`,
        );
        const retryAfterMs = retryAfterMilliseconds(response, this.#now);
        const error = new ElevenLabsError(classified.message, {
          kind: classified.kind,
          status: response.status,
          ...(classified.code ? { code: classified.code } : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          keyLabel: label,
          response: payload,
          rotateToNextKey: classified.rotateToNextKey,
          ambiguousOutcome: classified.kind === "provider",
          keys: this.#keys,
        });
        if (error.mayTryAnotherKey) {
          rotatableErrors.push(error);
          continue;
        }
        throw error;
      }

      const contentType = response.headers.get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== OUTPUT_CONTENT_TYPE) {
        let payload: unknown;
        try {
          payload = await errorPayload(response);
        } catch (cause) {
          throw new ElevenLabsError("Could not read the unexpected ElevenLabs response", {
            kind: "download",
            status: response.status,
            keyLabel: label,
            ambiguousOutcome: true,
            cause,
            keys: this.#keys,
          });
        }
        throw new ElevenLabsError(
          `ElevenLabs returned unexpected content type ${contentType ?? "(missing)"}`,
          {
            kind: "provider",
            status: response.status,
            keyLabel: label,
            response: payload,
            ambiguousOutcome: true,
            keys: this.#keys,
          },
        );
      }

      await this.#persistAudio(response, spec.outputPath, label);
      const generated: GeneratedAudio = {
        filePath: spec.outputPath,
        keyLabel: label,
      };
      const requestId = optionalHeader(response, "request-id", "x-request-id");
      const characterCost = optionalHeader(response, "character-cost");
      const songId = optionalHeader(response, "song-id", "x-song-id");
      if (requestId) generated.requestId = requestId;
      if (characterCost) generated.characterCost = characterCost;
      if (songId) generated.songId = songId;
      return generated;
    }

    if (rotatableErrors.length > 0) {
      const rateErrors = rotatableErrors.filter((error) => error.kind === "rate_limit");
      const representative = rateErrors.at(-1) ?? rotatableErrors.at(-1) as ElevenLabsError;
      const retryAfterMs = rateErrors.reduce<number | undefined>((maximum, error) => {
        if (error.retryAfterMs === undefined) return maximum;
        return maximum === undefined ? error.retryAfterMs : Math.max(maximum, error.retryAfterMs);
      }, undefined);
      throw new ElevenLabsError(
        `All ${this.#keys.length} configured ElevenLabs API keys rejected the ${spec.operation} request: ${representative.message}`,
        {
          kind: rateErrors.length > 0 ? "rate_limit" : "insufficient_credits",
          ...(representative.status !== undefined ? { status: representative.status } : {}),
          ...(representative.code !== undefined ? { code: representative.code } : {}),
          ...(retryAfterMs !== undefined
            ? { retryAfterMs }
            : representative.retryAfterMs !== undefined
              ? { retryAfterMs: representative.retryAfterMs }
              : {}),
          ...(representative.keyLabel !== undefined
            ? { keyLabel: representative.keyLabel }
            : {}),
          response: representative.response,
          rotationExhausted: true,
          cause: representative,
          keys: this.#keys,
        },
      );
    }

    throw new ElevenLabsError("No usable ElevenLabs API key is configured", {
      kind: "configuration",
      keys: this.#keys,
    });
  }

  async #request(
    spec: AudioGenerationSpec,
    key: string,
    keyLabel: string,
  ): Promise<Response> {
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutError = new ElevenLabsError(
      `ElevenLabs ${spec.operation} request did not return a response within ${this.#requestTimeoutMs}ms`,
      {
        kind: "network",
        code: "request_timeout",
        keyLabel,
        ambiguousOutcome: true,
        keys: this.#keys,
      },
    );
    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(timeoutError);
        controller.abort();
      }, this.#requestTimeoutMs);
    });

    try {
      return await Promise.race([
        this.#fetch(`${this.#baseUrl}${spec.endpoint}`, {
          method: "POST",
          headers: {
            "xi-api-key": key,
            "Content-Type": "application/json",
            Accept: OUTPUT_CONTENT_TYPE,
          },
          body: spec.body,
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch (cause) {
      if (cause === timeoutError || timedOut) throw timeoutError;
      throw new ElevenLabsError(
        `ElevenLabs ${spec.operation} request failed before a response was received`,
        {
          kind: "network",
          keyLabel,
          ambiguousOutcome: true,
          cause,
          keys: this.#keys,
        },
      );
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  async #persistAudio(response: Response, outputPath: string, keyLabel: string): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      throw new ElevenLabsError("Could not read generated ElevenLabs audio", {
        kind: "download",
        status: response.status,
        keyLabel,
        ambiguousOutcome: true,
        cause,
        keys: this.#keys,
      });
    }
    if (!bytes.byteLength) {
      throw new ElevenLabsError("ElevenLabs returned an empty audio file", {
        kind: "download",
        status: response.status,
        keyLabel,
        ambiguousOutcome: true,
        keys: this.#keys,
      });
    }

    const directory = dirname(outputPath);
    const temporaryPath = `${outputPath}.part-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(directory, { recursive: true });
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, outputPath);
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new ElevenLabsError("Could not persist generated ElevenLabs audio atomically", {
        kind: "download",
        status: response.status,
        keyLabel,
        ambiguousOutcome: true,
        cause,
        keys: this.#keys,
      });
    }
  }
}

/** @deprecated Use ElevenLabsClient. */
export { ElevenLabsClient as ElevenLabsSoundEffectsClient };
