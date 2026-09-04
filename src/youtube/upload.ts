import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { Readable } from "node:stream";

import { google } from "googleapis";

import type { YouTubeOAuthClient } from "./oauth.js";

export type YouTubePrivacyStatus = "private" | "unlisted" | "public";

export interface ExplicitUploadAuthorization {
  /** Must be true only after the current user explicitly requested the upload. */
  confirmed: boolean;
  /** A per-request capability supplied by the host, not exposed in the agent tool schema. */
  token: string;
}

export interface YouTubeUploadInput {
  filePath: string;
  title: string;
  description?: string;
  tags?: readonly string[];
  categoryId?: string;
  privacyStatus?: YouTubePrivacyStatus;
  selfDeclaredMadeForKids: boolean;
  containsSyntheticMedia?: boolean;
  notifySubscribers?: boolean;
  authorization: ExplicitUploadAuthorization;
}

export interface YouTubeUploaderConfig {
  /** Uploading remains off unless the host deliberately enables it. */
  enabled?: boolean;
  /** Required when enabled. Generate a fresh, unpredictable token per approved request. */
  requiredAuthorizationToken?: string;
  auth?: YouTubeOAuthClient;
  defaultPrivacyStatus?: YouTubePrivacyStatus;
}

interface VideosInsertRequest {
  part: readonly ["snippet", "status"];
  notifySubscribers: boolean;
  requestBody: {
    snippet: {
      title: string;
      description: string;
      tags?: string[];
      categoryId: string;
    };
    status: {
      privacyStatus: YouTubePrivacyStatus;
      selfDeclaredMadeForKids: boolean;
      containsSyntheticMedia: boolean;
    };
  };
  media: {
    mimeType: "video/mp4";
    body: Readable;
  };
}

export interface YouTubeApiClient {
  videos: {
    insert(request: VideosInsertRequest): Promise<{
      data: {
        id?: string | null;
        status?: {
          privacyStatus?: string | null;
        } | null;
      };
    }>;
  };
}

export interface YouTubeUploadDependencies {
  youtubeClient?: YouTubeApiClient;
  createYouTubeClient?: (auth: YouTubeOAuthClient) => YouTubeApiClient;
  openFile?: (filePath: string) => Readable;
  assertReadable?: (filePath: string) => Promise<void>;
}

export interface YouTubeUploadResult {
  videoId: string;
  url: string;
  privacyStatus: YouTubePrivacyStatus;
}

export interface YouTubeUploader {
  upload(input: YouTubeUploadInput): Promise<YouTubeUploadResult>;
}

export interface YouTubeUploadErrorOptions extends ErrorOptions {
  /** True when YouTube may have accepted the bytes despite the missing response. */
  ambiguousOutcome?: boolean;
  /** HTTP status observed from Google, when one was returned. */
  status?: number;
}

export class YouTubeUploadError extends Error {
  readonly ambiguousOutcome: boolean;
  readonly status: number | undefined;

  constructor(message: string, options: YouTubeUploadErrorOptions = {}) {
    super(message, options);
    this.name = "YouTubeUploadError";
    this.ambiguousOutcome = options.ambiguousOutcome ?? false;
    this.status = options.status;
  }
}

export class YouTubeUploadDisabledError extends YouTubeUploadError {
  constructor() {
    super("YouTube upload is disabled");
    this.name = "YouTubeUploadDisabledError";
  }
}

export class YouTubeUploadAuthorizationError extends YouTubeUploadError {
  constructor(message = "YouTube upload requires explicit authorization for this request") {
    super(message);
    this.name = "YouTubeUploadAuthorizationError";
  }
}

function requireText(label: string, value: unknown, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new YouTubeUploadError(`${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new YouTubeUploadError(`${label} must be at most ${maxLength} characters`);
  }
}

function safeTokenMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isPrivacyStatus(value: unknown): value is YouTubePrivacyStatus {
  return value === "private" || value === "unlisted" || value === "public";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function uploadErrorStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  if (!record) return undefined;
  const response = asRecord(record.response);
  for (const candidate of [record.status, response?.status, record.code]) {
    const numeric = typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && /^\d{3}$/.test(candidate)
        ? Number(candidate)
        : Number.NaN;
    if (Number.isInteger(numeric) && numeric >= 100 && numeric <= 599) return numeric;
  }
  return undefined;
}

function isAmbiguousApiFailure(status: number | undefined): boolean {
  // A normal 4xx response (other than a request timeout) is a definite
  // rejection. Missing responses, timeouts, and server failures can occur
  // after Google accepted some or all of the resumable upload.
  return status === undefined || status === 408 || status >= 500;
}

function validateUploadInput(input: YouTubeUploadInput): void {
  requireText("filePath", input.filePath, 4096);
  requireText("title", input.title, 100);
  if (/[<>]/.test(input.title)) {
    throw new YouTubeUploadError("title cannot contain < or >");
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string" || input.description.includes("\0")) {
      throw new YouTubeUploadError("description must be a string without NUL bytes");
    }
    if (/[<>]/.test(input.description)) {
      throw new YouTubeUploadError("description cannot contain < or >");
    }
    if (Buffer.byteLength(input.description, "utf8") > 5000) {
      throw new YouTubeUploadError("description must be at most 5000 UTF-8 bytes");
    }
  }
  if (typeof input.selfDeclaredMadeForKids !== "boolean") {
    throw new YouTubeUploadError("selfDeclaredMadeForKids must be explicitly set");
  }
  if (
    input.containsSyntheticMedia !== undefined &&
    typeof input.containsSyntheticMedia !== "boolean"
  ) {
    throw new YouTubeUploadError("containsSyntheticMedia must be a boolean");
  }
  if (input.notifySubscribers !== undefined && typeof input.notifySubscribers !== "boolean") {
    throw new YouTubeUploadError("notifySubscribers must be a boolean");
  }
  if (input.tags !== undefined) {
    if (input.tags.length > 50) {
      throw new YouTubeUploadError("tags must contain at most 50 entries");
    }
    input.tags.forEach((tag, index) => requireText(`tags[${index}]`, tag, 100));
    const serializedTags = input.tags
      .map((tag) => tag.trim())
      .map((tag) => tag.includes(" ") ? `"${tag}"` : tag)
      .join(",");
    if (Array.from(serializedTags).length > 500) {
      throw new YouTubeUploadError("tags must fit YouTube's aggregate 500-character limit");
    }
    const normalizedTags = input.tags.map((tag) => tag.trim().toLocaleLowerCase());
    if (new Set(normalizedTags).size !== normalizedTags.length) {
      throw new YouTubeUploadError("tags must be unique");
    }
  }
  if (
    input.categoryId !== undefined &&
    (typeof input.categoryId !== "string" || !/^\d+$/.test(input.categoryId))
  ) {
    throw new YouTubeUploadError("categoryId must contain only digits");
  }
  if (input.privacyStatus !== undefined && !isPrivacyStatus(input.privacyStatus)) {
    throw new YouTubeUploadError("privacyStatus must be private, unlisted, or public");
  }
}

async function defaultAssertReadable(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.R_OK);
  } catch (cause) {
    throw new YouTubeUploadError(`Video file is not readable: ${filePath}`, { cause });
  }
}

function defaultCreateYouTubeClient(auth: YouTubeOAuthClient): YouTubeApiClient {
  return google.youtube({ version: "v3", auth: auth as never }) as unknown as YouTubeApiClient;
}

export function createYouTubeUploader(
  config: YouTubeUploaderConfig = {},
  dependencies: YouTubeUploadDependencies = {},
): YouTubeUploader {
  const enabled = config.enabled ?? false;
  const defaultPrivacyStatus = config.defaultPrivacyStatus ?? "private";

  if (!isPrivacyStatus(defaultPrivacyStatus)) {
    throw new YouTubeUploadError(
      "defaultPrivacyStatus must be private, unlisted, or public",
    );
  }

  if (enabled) {
    requireText("requiredAuthorizationToken", config.requiredAuthorizationToken, 4096);
    if (config.requiredAuthorizationToken.length < 16) {
      throw new YouTubeUploadAuthorizationError(
        "requiredAuthorizationToken must contain at least 16 characters",
      );
    }
  }

  const assertReadable = dependencies.assertReadable ?? defaultAssertReadable;
  const openFile = dependencies.openFile ?? ((filePath: string) => createReadStream(filePath));

  return {
    async upload(input): Promise<YouTubeUploadResult> {
      // Check capability before touching the filesystem or constructing an API client.
      if (!enabled) {
        throw new YouTubeUploadDisabledError();
      }
      if (
        input?.authorization?.confirmed !== true ||
        !safeTokenMatches(input.authorization.token, config.requiredAuthorizationToken as string)
      ) {
        throw new YouTubeUploadAuthorizationError();
      }

      validateUploadInput(input);
      await assertReadable(input.filePath);

      const youtubeClient =
        dependencies.youtubeClient ??
        (() => {
          if (!config.auth) {
            throw new YouTubeUploadError(
              "An OAuth client is required when no YouTube API client is injected",
            );
          }
          return (dependencies.createYouTubeClient ?? defaultCreateYouTubeClient)(config.auth);
        })();

      const privacyStatus = input.privacyStatus ?? defaultPrivacyStatus;
      let mediaBody: Readable | undefined;

      try {
        mediaBody = openFile(input.filePath);
        const response = await youtubeClient.videos.insert({
          part: ["snippet", "status"],
          notifySubscribers: input.notifySubscribers ?? false,
          requestBody: {
            snippet: {
              title: input.title.trim(),
              description: input.description ?? "",
              ...(input.tags ? { tags: input.tags.map((tag) => tag.trim()) } : {}),
              categoryId: input.categoryId ?? "22",
            },
            status: {
              privacyStatus,
              selfDeclaredMadeForKids: input.selfDeclaredMadeForKids,
              containsSyntheticMedia: input.containsSyntheticMedia ?? true,
            },
          },
          media: {
            mimeType: "video/mp4",
            body: mediaBody,
          },
        });

        const videoId = response.data.id;
        if (!videoId) {
          throw new YouTubeUploadError("YouTube returned no video ID after upload", {
            ambiguousOutcome: true,
          });
        }

        const effectivePrivacyStatus = isPrivacyStatus(response.data.status?.privacyStatus)
          ? response.data.status.privacyStatus
          : privacyStatus;
        return {
          videoId,
          url: `https://youtu.be/${encodeURIComponent(videoId)}`,
          privacyStatus: effectivePrivacyStatus,
        };
      } catch (cause) {
        if (cause instanceof YouTubeUploadError) throw cause;
        const status = uploadErrorStatus(cause);
        throw new YouTubeUploadError("YouTube video upload failed", {
          cause,
          ...(status === undefined ? {} : { status }),
          ambiguousOutcome: isAmbiguousApiFailure(status),
        });
      } finally {
        if (mediaBody && typeof mediaBody.destroy === "function" && !mediaBody.destroyed) {
          mediaBody.destroy();
        }
      }
    },
  };
}
