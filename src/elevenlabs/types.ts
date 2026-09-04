export type ElevenLabsFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ElevenLabsErrorKind =
  | "configuration"
  | "validation"
  | "authentication"
  | "insufficient_credits"
  | "rate_limit"
  | "provider"
  | "network"
  | "download";

export interface ElevenLabsClientOptions {
  /** Explicit values take precedence over ELEVENLABS_API_KEY_<n>. */
  apiKeys?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  baseUrl?: string;
  fetch?: ElevenLabsFetch;
  now?: () => number;
  /** Maximum time to wait for response headers. Defaults to 180 seconds. */
  requestTimeoutMs?: number;
}

/** @deprecated Use ElevenLabsClientOptions. */
export type ElevenLabsSoundEffectsClientOptions = ElevenLabsClientOptions;

export interface ElevenLabsRequestAttempt {
  /** Secret-free diagnostic label based on configured key order. */
  keyLabel: string;
}

export type ElevenLabsRequestAttemptCallback = (
  attempt: ElevenLabsRequestAttempt,
) => void;

export interface ElevenLabsSoundEffectRequest {
  /** Sound-effect description sent as ElevenLabs' required `text` field. */
  text: string;
  /** Exact output duration. ElevenLabs accepts values from 0.5 through 30 seconds. */
  durationSeconds: number;
  outputPath: string;
  /** How literally the model should follow `text`, from 0 through 1. */
  promptInfluence?: number;
  /** Generate a seamless loop. Defaults to false. */
  loop?: boolean;
  /** Secret-free notification emitted immediately before each provider POST. */
  onAttempt?: ElevenLabsRequestAttemptCallback;
}

export interface ElevenLabsSoundEffectResult {
  filePath: string;
  contentType: "audio/mpeg";
  model: "eleven_text_to_sound_v2";
  /** Secret-free diagnostic label based on configured key order. */
  keyLabel: string;
  requestId?: string;
  characterCost?: string;
}

export interface ElevenLabsMusicRequest {
  /** Instrumental music composition prompt. Limited to 4,100 characters. */
  prompt: string;
  /** Exact requested composition length, from 3 through 600 seconds. */
  durationSeconds: number;
  outputPath: string;
  /** Secret-free notification emitted immediately before each provider POST. */
  onAttempt?: ElevenLabsRequestAttemptCallback;
}

export interface ElevenLabsMusicResult {
  filePath: string;
  contentType: "audio/mpeg";
  model: "music_v2";
  /** Secret-free diagnostic label based on configured key order. */
  keyLabel: string;
  songId?: string;
  requestId?: string;
  characterCost?: string;
}
