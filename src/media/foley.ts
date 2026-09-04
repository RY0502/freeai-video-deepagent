import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import ffmpegStaticModule from "ffmpeg-static";

import {
  AUDIO_MIX_REVISION,
  AUDIO_SAMPLE_RATE,
  MediaAssemblyError,
  createSpawnProcessRunner,
  type ProcessRunner,
} from "./assemble.js";

const ffmpegStaticPath = ffmpegStaticModule as unknown as string | null;
const AUDIO_CHANNELS = 2 as const;
const MAX_CUE_VOLUME = 4;
const MIN_NORMALIZATION_GAIN_DB = -24;
export const FOLEY_CUE_TARGET_LOUDNESS_LUFS = -18;
export const FOLEY_CUE_TRUE_PEAK_DB = -3;
export const FOLEY_CUE_TARGET_MEAN_DBFS = -20;
export const FOLEY_CUE_MAX_NORMALIZATION_GAIN_DB = 12;
export const FOLEY_CUE_MIN_USABLE_PEAK_DBFS = -45;
export const FOLEY_CUE_MIN_USABLE_MEAN_DBFS = -42;
export const FOLEY_CUE_MIN_PEAK_FOR_LOW_MEAN_DBFS = -24;
/**
 * Removes only provider-added leading silence from transient effects. A tiny
 * five-millisecond lead is retained so hard attacks are not clipped.
 */
export const FOLEY_TRANSIENT_ONSET_TRIM_FILTER =
  "silenceremove=start_periods=1:start_duration=0.010:start_threshold=-48dB:" +
  "start_silence=0.005:start_mode=any:detection=peak:window=0.010";
export const FOLEY_MIX_REVISION = AUDIO_MIX_REVISION;

export type FoleySceneDurationSeconds = number;

export interface FoleyCuePlacement {
  /** Path to an isolated effect. Transient provider lead-in is removed locally. */
  path: string;
  /** Scene-relative placement time. Silence before this point is added locally. */
  atSeconds: number;
  /** Maximum audible span; shorter inputs are padded and longer inputs are trimmed. */
  durationSeconds: number;
  /** Linear gain. Defaults to 1. */
  volume?: number;
  /** Deterministic local stereo placement. Defaults to center. */
  spatialPosition?: "left" | "center" | "right" | "moving";
  /** Continuous beds receive a short fade-in as well as a fade-out. */
  continuous?: boolean;
  /** Optional edge fades; safe defaults are selected from `continuous`. */
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
}

export interface FoleyStemRenderInput {
  sceneDurationSeconds: FoleySceneDurationSeconds;
  cues: readonly FoleyCuePlacement[];
  /** Must not already exist. The completed WAV is published atomically. */
  outputPath: string;
}

interface NormalizedFoleyCuePlacement extends FoleyCuePlacement {
  volume: number;
  spatialPosition: NonNullable<FoleyCuePlacement["spatialPosition"]>;
  continuous: boolean;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  normalizationGainDb: number;
  delaySamples: number;
  durationSamples: number;
}

export interface NormalizedFoleyStemRenderInput {
  sceneDurationSeconds: FoleySceneDurationSeconds;
  sceneDurationSamples: number;
  cues: readonly NormalizedFoleyCuePlacement[];
  outputPath: string;
}

export interface FoleyStemRenderDependencies {
  ffmpegPath?: string | null;
  runProcess?: ProcessRunner;
  assertReadable?: (filePath: string) => Promise<void>;
  analyzeCue?: (
    filePath: string,
    ffmpegPath: string,
    runProcess: ProcessRunner,
  ) => Promise<FoleyCueAudioAnalysis>;
}

export interface FoleyStemRenderResult {
  outputPath: string;
  durationSeconds: FoleySceneDurationSeconds;
  /** Number of usable cues actually mixed. */
  cueCount: number;
  inputCueCount: number;
  omittedCueCount: number;
  sampleRate: typeof AUDIO_SAMPLE_RATE;
  channels: typeof AUDIO_CHANNELS;
  codec: "pcm_s16le";
}

export interface FoleyCueAudioAnalysis {
  usable: boolean;
  meanVolumeDbfs: number;
  maxVolumeDbfs: number;
  /** Fixed gain chosen to approach the target without ever amplifying more than 12 dB. */
  normalizationGainDb: number;
  reason?: string;
}

function validatePath(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MediaAssemblyError(`${label} must be a non-empty file path`);
  }
  if (value.includes("\0")) {
    throw new MediaAssemblyError(`${label} contains a NUL byte`);
  }
}

function sampleCount(label: string, seconds: number, allowZero: boolean): number {
  if (!Number.isFinite(seconds) || seconds < 0 || (!allowZero && seconds === 0)) {
    throw new MediaAssemblyError(`${label} must be ${allowZero ? "non-negative" : "positive"}`);
  }
  const samples = Math.round(seconds * AUDIO_SAMPLE_RATE);
  if ((!allowZero && samples < 1) || !Number.isSafeInteger(samples)) {
    throw new MediaAssemblyError(`${label} must resolve to at least one 48kHz audio sample`);
  }
  return samples;
}

export function normalizeFoleyStemInput(
  input: FoleyStemRenderInput,
): NormalizedFoleyStemRenderInput {
  if (
    !Number.isSafeInteger(input.sceneDurationSeconds)
    || input.sceneDurationSeconds < 4
    || input.sceneDurationSeconds > 12
  ) {
    throw new MediaAssemblyError("sceneDurationSeconds must be an integer from 4 through 12");
  }
  validatePath("outputPath", input.outputPath);
  const sceneDurationSamples = input.sceneDurationSeconds * AUDIO_SAMPLE_RATE;
  const cues = input.cues.map((cue, index): NormalizedFoleyCuePlacement => {
    validatePath(`cues[${index}].path`, cue.path);
    if (cue.path === input.outputPath) {
      throw new MediaAssemblyError(`cues[${index}].path must differ from outputPath`);
    }
    const delaySamples = sampleCount(`cues[${index}].atSeconds`, cue.atSeconds, true);
    const durationSamples = sampleCount(
      `cues[${index}].durationSeconds`,
      cue.durationSeconds,
      false,
    );
    if (delaySamples >= sceneDurationSamples) {
      throw new MediaAssemblyError(`cues[${index}].atSeconds must fall inside the scene`);
    }
    if (delaySamples + durationSamples > sceneDurationSamples) {
      throw new MediaAssemblyError(`cues[${index}] must end by the end of the scene`);
    }
    const volume = cue.volume ?? 1;
    if (!Number.isFinite(volume) || volume < 0 || volume > MAX_CUE_VOLUME) {
      throw new MediaAssemblyError(
        `cues[${index}].volume must be between 0 and ${MAX_CUE_VOLUME}`,
      );
    }
    const spatialPosition = cue.spatialPosition ?? "center";
    if (!["left", "center", "right", "moving"].includes(spatialPosition)) {
      throw new MediaAssemblyError(
        `cues[${index}].spatialPosition must be left, center, right, or moving`,
      );
    }
    const continuous = cue.continuous ?? false;
    if (typeof continuous !== "boolean") {
      throw new MediaAssemblyError(`cues[${index}].continuous must be a boolean`);
    }
    const durationForFades = durationSamples / AUDIO_SAMPLE_RATE;
    const fadeInSeconds = cue.fadeInSeconds
      ?? (continuous ? Math.min(0.08, durationForFades / 4) : 0);
    const fadeOutSeconds = cue.fadeOutSeconds
      ?? Math.min(continuous ? 0.08 : 0.06, durationForFades / 4);
    for (const [fadeName, fadeValue] of [
      ["fadeInSeconds", fadeInSeconds],
      ["fadeOutSeconds", fadeOutSeconds],
    ] as const) {
      if (!Number.isFinite(fadeValue) || fadeValue < 0 || fadeValue > durationForFades) {
        throw new MediaAssemblyError(
          `cues[${index}].${fadeName} must be between 0 and cue duration`,
        );
      }
    }
    if (fadeInSeconds + fadeOutSeconds > durationForFades) {
      throw new MediaAssemblyError(
        `cues[${index}] fade durations must not exceed cue duration`,
      );
    }
    return {
      path: cue.path,
      atSeconds: cue.atSeconds,
      durationSeconds: cue.durationSeconds,
      volume,
      spatialPosition,
      continuous,
      fadeInSeconds,
      fadeOutSeconds,
      normalizationGainDb: 0,
      delaySamples,
      durationSamples,
    };
  });

  return {
    sceneDurationSeconds: input.sceneDurationSeconds,
    sceneDurationSamples,
    cues,
    outputPath: input.outputPath,
  };
}

function formatVolume(volume: number): string {
  return volume.toFixed(3);
}

function formatSeconds(seconds: number): string {
  return seconds.toFixed(3);
}

function formatDecibels(decibels: number): string {
  const rounded = Math.abs(decibels) < 0.0005 ? 0 : decibels;
  return rounded.toFixed(3);
}

function spatialFilter(cue: NormalizedFoleyCuePlacement): string[] {
  switch (cue.spatialPosition) {
    case "left":
      return ["stereotools=balance_out=-0.65:bmode_out=power"];
    case "right":
      return ["stereotools=balance_out=0.65:bmode_out=power"];
    case "moving": {
      const hertz = Math.max(0.05, Math.min(0.25, 1 / (2 * cue.durationSeconds)));
      return [
        `apulsator=mode=sine:amount=0.30:offset_l=0:offset_r=0.5:timing=hz:hz=${hertz.toFixed(3)}`,
      ];
    }
    case "center":
      return [];
  }
}

/**
 * Builds a sample-addressed mix. FFmpeg creates the silence; generated effects
 * are never trusted to synthesize their own leading gaps or timeline position.
 */
export function buildFoleyStemFilterGraph(
  input: FoleyStemRenderInput | NormalizedFoleyStemRenderInput,
): string {
  const normalized = "sceneDurationSamples" in input
    ? input
    : normalizeFoleyStemInput(input);
  const silence =
    `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo,` +
    `atrim=start_sample=0:end_sample=${normalized.sceneDurationSamples},` +
    "asetpts=N/SR/TB[silence]";

  if (normalized.cues.length === 0) {
    return `${silence};[silence]anull[foley]`;
  }

  const cueFilters = normalized.cues.map((cue, index) => {
    const filters = [
      `aresample=${AUDIO_SAMPLE_RATE}`,
      `aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo`,
      ...(!cue.continuous ? [FOLEY_TRANSIENT_ONSET_TRIM_FILTER] : []),
      `apad=whole_len=${cue.durationSamples}`,
      `atrim=start_sample=0:end_sample=${cue.durationSamples}`,
      "asetpts=N/SR/TB",
      `volume=${formatDecibels(cue.normalizationGainDb)}dB`,
      ...spatialFilter(cue),
    ];
    if (cue.fadeInSeconds > 0) {
      filters.push(`afade=t=in:st=0:d=${formatSeconds(cue.fadeInSeconds)}:curve=tri`);
    }
    if (cue.fadeOutSeconds > 0) {
      const fadeStart = Math.max(0, cue.durationSeconds - cue.fadeOutSeconds);
      filters.push(
        `afade=t=out:st=${formatSeconds(fadeStart)}:d=${formatSeconds(cue.fadeOutSeconds)}:curve=tri`,
      );
    }
    filters.push(
      `volume=${formatVolume(cue.volume)}`,
      `adelay=${cue.delaySamples}S:all=1`,
    );
    return `[${index}:a:0]${filters.join(",")}[cue${index}]`;
  });
  const inputs = ["[silence]", ...normalized.cues.map((_cue, index) => `[cue${index}]`)].join("");

  return [
    silence,
    ...cueFilters,
    `${inputs}amix=inputs=${normalized.cues.length + 1}:duration=first:` +
      "dropout_transition=0:normalize=0," +
      "alimiter=limit=0.95:attack=5:release=50:latency=1," +
      `atrim=start_sample=0:end_sample=${normalized.sceneDurationSamples},` +
      "asetpts=N/SR/TB[foley]",
  ].join(";");
}

export function buildFoleyStemArgs(
  input: FoleyStemRenderInput | NormalizedFoleyStemRenderInput,
): string[] {
  const normalized = "sceneDurationSamples" in input
    ? input
    : normalizeFoleyStemInput(input);
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-n"];
  for (const cue of normalized.cues) args.push("-i", cue.path);
  args.push(
    "-filter_complex",
    buildFoleyStemFilterGraph(normalized),
    "-map",
    "[foley]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    String(AUDIO_SAMPLE_RATE),
    "-ac",
    String(AUDIO_CHANNELS),
    "-t",
    normalized.sceneDurationSeconds.toFixed(3),
    "-f",
    "wav",
    normalized.outputPath,
  );
  return args;
}

async function defaultAssertReadable(filePath: string): Promise<void> {
  await access(filePath, constants.R_OK);
}

async function assertDoesNotExist(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new MediaAssemblyError(`Foley stem output already exists: ${filePath}`);
}

async function assertNonEmptyFile(filePath: string): Promise<void> {
  const information = await stat(filePath);
  if (!information.isFile() || information.size === 0) {
    throw new MediaAssemblyError("FFmpeg did not create a non-empty Foley stem");
  }
}

function volumeMetric(stderr: string, metric: "mean_volume" | "max_volume"): number | undefined {
  const match = new RegExp(`${metric}:\\s*(-?inf|[-+]?\\d+(?:\\.\\d+)?)\\s*dB`, "i").exec(stderr);
  if (!match?.[1]) return undefined;
  if (match[1].toLowerCase() === "-inf") return Number.NEGATIVE_INFINITY;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Inspect a downloaded provider cue before mixing it. The selected fixed gain
 * approaches -20 dBFS mean loudness, respects a -3 dBFS peak target, and never
 * boosts quiet material by more than 12 dB. This prevents noise-like provider
 * failures from being amplified by 25-30 dB as dynamic loudness normalization can.
 */
export async function analyzeFoleyCueAudio(
  filePath: string,
  ffmpegPath: string,
  runProcess: ProcessRunner,
): Promise<FoleyCueAudioAnalysis> {
  const result = await runProcess(ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-i",
    filePath,
    "-map",
    "0:a:0",
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const meanVolumeDbfs = volumeMetric(result.stderr, "mean_volume");
  const maxVolumeDbfs = volumeMetric(result.stderr, "max_volume");
  if (meanVolumeDbfs === undefined || maxVolumeDbfs === undefined) {
    throw new MediaAssemblyError(`FFmpeg could not measure Foley cue loudness: ${filePath}`);
  }
  if (
    !Number.isFinite(meanVolumeDbfs)
    || !Number.isFinite(maxVolumeDbfs)
    || maxVolumeDbfs <= FOLEY_CUE_MIN_USABLE_PEAK_DBFS
    || (
      meanVolumeDbfs <= FOLEY_CUE_MIN_USABLE_MEAN_DBFS
      && maxVolumeDbfs <= FOLEY_CUE_MIN_PEAK_FOR_LOW_MEAN_DBFS
    )
  ) {
    return {
      usable: false,
      meanVolumeDbfs,
      maxVolumeDbfs,
      normalizationGainDb: 0,
      reason: `mean ${meanVolumeDbfs.toFixed(1)} dBFS and peak ${maxVolumeDbfs.toFixed(1)} dBFS are effectively silent`,
    };
  }
  const gainTowardMean = FOLEY_CUE_TARGET_MEAN_DBFS - meanVolumeDbfs;
  const gainWithinPeak = FOLEY_CUE_TRUE_PEAK_DB - maxVolumeDbfs;
  const normalizationGainDb = Math.max(
    MIN_NORMALIZATION_GAIN_DB,
    Math.min(FOLEY_CUE_MAX_NORMALIZATION_GAIN_DB, gainTowardMean, gainWithinPeak),
  );
  return {
    usable: true,
    meanVolumeDbfs,
    maxVolumeDbfs,
    normalizationGainDb: Number(normalizationGainDb.toFixed(3)),
  };
}

/** Render and atomically publish an exact-duration 48kHz stereo PCM WAV stem. */
export async function renderFoleyStem(
  input: FoleyStemRenderInput,
  dependencies: FoleyStemRenderDependencies = {},
): Promise<FoleyStemRenderResult> {
  const normalized = normalizeFoleyStemInput(input);
  const ffmpegPath = dependencies.ffmpegPath === undefined
    ? ffmpegStaticPath
    : dependencies.ffmpegPath;
  if (!ffmpegPath) {
    throw new MediaAssemblyError("FFmpeg dependency is unavailable");
  }
  const runProcess = dependencies.runProcess ?? createSpawnProcessRunner();
  const assertReadable = dependencies.assertReadable ?? defaultAssertReadable;
  const analyzeCue = dependencies.analyzeCue ?? analyzeFoleyCueAudio;

  await Promise.all(normalized.cues.map(async (cue) => await assertReadable(cue.path)));
  await assertDoesNotExist(normalized.outputPath);
  await mkdir(path.dirname(normalized.outputPath), { recursive: true });

  const usableCues: NormalizedFoleyCuePlacement[] = [];
  for (const cue of normalized.cues) {
    const analysis = await analyzeCue(cue.path, ffmpegPath, runProcess);
    if (!analysis.usable) continue;
    usableCues.push({
      ...cue,
      normalizationGainDb: analysis.normalizationGainDb,
    });
  }

  const temporaryPath = `${normalized.outputPath}.part-${randomUUID()}.wav`;
  try {
    await runProcess(ffmpegPath, buildFoleyStemArgs({
      ...normalized,
      cues: usableCues,
      outputPath: temporaryPath,
    }));
    await assertNonEmptyFile(temporaryPath);
    await rename(temporaryPath, normalized.outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  return {
    outputPath: normalized.outputPath,
    durationSeconds: normalized.sceneDurationSeconds,
    cueCount: usableCues.length,
    inputCueCount: normalized.cues.length,
    omittedCueCount: normalized.cues.length - usableCues.length,
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: AUDIO_CHANNELS,
    codec: "pcm_s16le",
  };
}
