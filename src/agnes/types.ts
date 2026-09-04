export const AGNES_VIDEO_MODEL = "agnes-video-2.5-flash" as const;
export const AGNES_DEFAULT_BASE_URL = "https://apihub.agnes-ai.com" as const;
export const AGNES_CREATE_VIDEO_URL = "https://apihub.agnes-ai.com/v1/videos" as const;
export const AGNES_RETRIEVE_VIDEO_URL = "https://apihub.agnes-ai.com/agnesapi" as const;

export const AGNES_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
] as const;

export type AgnesAspectRatio = (typeof AGNES_ASPECT_RATIOS)[number];
export type AgnesTaskStatus = "queued" | "in_progress" | "completed" | "failed";

export type AgnesFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type AgnesSleep = (milliseconds: number) => Promise<void>;
export type AgnesClock = () => number;

export interface AgnesClientOptions {
  /** Explicit keys take precedence over environment discovery, including when empty. */
  apiKeys?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  /** Agnes origin or its documented `/v1` API base. Defaults to the official host. */
  baseUrl?: string;
  fetch?: AgnesFetch;
  sleep?: AgnesSleep;
  now?: AgnesClock;
  /** Defaults to 30 seconds. */
  pollIntervalMs?: number;
  /** Defaults to eight minutes. */
  pollWindowMs?: number;
  /** Per submit/retrieve HTTP deadline. Defaults to 60 seconds. */
  requestTimeoutMs?: number;
  /** Defaults to 256 MiB. */
  maxDownloadBytes?: number;
}

export interface AgnesSubmitVideoRequest {
  prompt: string;
  /** Agnes Video 2.5 Flash accepts integer durations from 4 through 12 seconds. */
  seconds: number;
  aspectRatio: AgnesAspectRatio;
  /** Secret-free notification immediately before each provider POST. */
  onAttempt?: (attempt: { keyLabel: string }) => void;
}

export interface AgnesTaskMetadata {
  /** Canonical completed media URL after normalizing supported provider shapes. */
  url?: string;
}

/**
 * A secret-safe receipt suitable for durable local persistence. Keeping all
 * three provider identifiers avoids guessing which one a future API response
 * will use, while keyFingerprint binds retrieval to the submitting key.
 */
export interface AgnesVideoTask {
  id: string;
  task_id: string;
  video_id: string;
  model: typeof AGNES_VIDEO_MODEL;
  status: AgnesTaskStatus;
  progress: number;
  keyLabel: string;
  /** Full lowercase SHA-256 of the exact key used for submission. */
  keyFingerprint: string;
  object?: string;
  created_at?: number;
  completed_at?: number | null;
  seconds?: string;
  size?: string;
  metadata?: AgnesTaskMetadata;
  error?: unknown;
}

export interface AgnesPollOptions {
  pollIntervalMs?: number;
  pollWindowMs?: number;
  sleep?: AgnesSleep;
  now?: AgnesClock;
  /** Awaited after every successful retrieval response, including terminal responses. */
  onPoll?: (task: AgnesVideoTask) => void | Promise<void>;
  /** Awaited after a transient retrieval failure that will be retried inside this window. */
  onPollError?: (error: AgnesError, task: AgnesVideoTask) => void | Promise<void>;
}

export type AgnesPollResult =
  | { outcome: "completed"; task: AgnesVideoTask }
  | { outcome: "failed"; task: AgnesVideoTask }
  | { outcome: "timed_out"; task: AgnesVideoTask };

export interface AgnesDownloadOptions {
  maxBytes?: number;
}

export interface AgnesDownloadResult {
  outputPath: string;
  url: string;
  bytes: number;
  sha256: string;
  contentType?: string;
}
import type { AgnesError } from "./errors.js";
