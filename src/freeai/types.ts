export const FREE_AI_MUSIC_MODEL = "ace-step" as const;
export const FREE_AI_MUSIC_ENDPOINT = "/v1/music/generate/ace-step/" as const;

export type FreeAiMusicFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type FreeAiMusicSleep = (milliseconds: number) => Promise<void>;

export interface FreeAiMusicAttempt {
  phase: "generation" | "download";
  attemptNumber: number;
  maxAttempts: number;
  /** Present only for authenticated generation requests. */
  keyLabel?: string;
}

export interface FreeAiMusicClientOptions {
  /** Explicit keys take precedence over FREE_AI_API_AUDIO_KEY_<n> discovery. */
  apiKeys?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  baseUrl?: string;
  fetch?: FreeAiMusicFetch;
  sleep?: FreeAiMusicSleep;
  /** Per generation or download request. Defaults to 180 seconds. */
  requestTimeoutMs?: number;
  /** Delay between retries. Defaults to six seconds (Free.ai's free 10 RPM tier). */
  retryDelayMs?: number;
  /** Defaults to three retries after the first attempt. */
  maxRetries?: number;
  /** Maximum accepted download size. Defaults to 64 MiB. */
  maxDownloadBytes?: number;
}

export interface FreeAiMusicRequest {
  prompt: string;
  /** Final video duration. ACE-Step is requested for at least ten seconds. */
  durationSeconds: number;
  genre?: string;
  tempo?: number;
  outputPath: string;
  onAttempt?: (attempt: FreeAiMusicAttempt) => void;
  /** Called after generation succeeds and before the returned media is downloaded. */
  onSubmitted?: (submission: FreeAiMusicSubmission) => void | Promise<void>;
}

export interface FreeAiMusicSubmission {
  url: string;
  model: typeof FREE_AI_MUSIC_MODEL;
  keyLabel: string;
  generationAttempts: number;
  providerDurationSeconds: number;
  externalId?: string;
}

export interface FreeAiMusicDownloadRequest {
  url: string;
  outputPath: string;
  onAttempt?: (attempt: FreeAiMusicAttempt) => void;
}

export interface FreeAiMusicDownloadResult {
  filePath: string;
  url: string;
  downloadAttempts: number;
  contentType?: string;
}

export interface FreeAiMusicResult extends FreeAiMusicSubmission, FreeAiMusicDownloadResult {}
