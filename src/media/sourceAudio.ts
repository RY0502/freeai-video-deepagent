import { constants } from "node:fs";
import { access } from "node:fs/promises";

import ffprobeStaticModule from "@derhuerst/ffprobe-static";
import ffmpegStaticModule from "ffmpeg-static";
import { z } from "zod";

import { readJsonIfPresent, sha256File, writeJsonAtomic } from "../utils/files.js";
import {
  DEFAULT_MEDIA_PROCESS_TIMEOUT_MS,
  MediaAssemblyError,
  createSpawnProcessRunner,
  type ProcessRunner,
} from "./assemble.js";

// These packages export their binary path through CommonJS at runtime while
// publishing ESM-shaped declarations.
const ffmpegStaticPath = ffmpegStaticModule as unknown as string | null;
const ffprobeStaticPath = ffprobeStaticModule as unknown as string | null;

export const SOURCE_AUDIO_INSPECTION_REVISION = 1 as const;
export const SOURCE_AUDIO_SILENCE_THRESHOLD_DBFS = -50 as const;
export const SOURCE_AUDIO_MIN_SILENCE_SECONDS = 0.1 as const;
export const SOURCE_AUDIO_MIN_PEAK_DBFS = -45 as const;
export const SOURCE_AUDIO_MIN_MEAN_DBFS = -60 as const;
export const SOURCE_AUDIO_MIN_ACTIVE_SECONDS = 0.12 as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const DurationSchema = z.number().int().min(4).max(12);

const SourceAudioThresholdsSchema = z.object({
  silenceDbfs: z.literal(SOURCE_AUDIO_SILENCE_THRESHOLD_DBFS),
  minimumSilenceSeconds: z.literal(SOURCE_AUDIO_MIN_SILENCE_SECONDS),
  minimumPeakDbfs: z.literal(SOURCE_AUDIO_MIN_PEAK_DBFS),
  minimumMeanDbfs: z.literal(SOURCE_AUDIO_MIN_MEAN_DBFS),
  minimumActiveSeconds: z.literal(SOURCE_AUDIO_MIN_ACTIVE_SECONDS),
}).strict();

const SourceAudioStreamSchema = z.object({
  codecName: z.string().trim().min(1),
  sampleRate: z.number().int().positive().nullable(),
  channels: z.number().int().positive().nullable(),
  durationSeconds: z.number().finite().nonnegative().nullable(),
}).strict();

export const SourceAudioInspectionDocumentSchema = z.object({
  schemaVersion: z.literal(2),
  inspectionRevision: z.literal(SOURCE_AUDIO_INSPECTION_REVISION),
  sourceVideoSha256: Sha256Schema,
  durationSeconds: DurationSchema,
  audioStream: SourceAudioStreamSchema.nullable(),
  thresholds: SourceAudioThresholdsSchema,
  peakVolumeDbfs: z.number().finite().nullable(),
  meanVolumeDbfs: z.number().finite().nullable(),
  silentDurationSeconds: z.number().finite().nonnegative(),
  activeDurationSeconds: z.number().finite().nonnegative(),
  usable: z.boolean(),
  reason: z.string().trim().min(1),
}).strict().superRefine((document, context) => {
  const tolerance = 0.000_001;
  if (document.silentDurationSeconds > document.durationSeconds + tolerance) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["silentDurationSeconds"],
      message: "Silent duration cannot exceed the inspection window.",
    });
  }
  if (document.activeDurationSeconds > document.durationSeconds + tolerance) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activeDurationSeconds"],
      message: "Active duration cannot exceed the inspection window.",
    });
  }
  if (
    Math.abs(
      document.silentDurationSeconds
      + document.activeDurationSeconds
      - document.durationSeconds,
    ) > tolerance
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activeDurationSeconds"],
      message: "Active and silent durations must cover the inspection window.",
    });
  }
  if (document.audioStream === null) {
    if (
      document.peakVolumeDbfs !== null
      || document.meanVolumeDbfs !== null
      || document.activeDurationSeconds !== 0
      || document.usable
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audioStream"],
        message: "A video without an audio stream cannot contain usable audio metrics.",
      });
    }
  }
});

export type SourceAudioInspectionDocument = z.infer<
  typeof SourceAudioInspectionDocumentSchema
>;

export interface InspectSourceAudioInput {
  sourceVideoPath: string;
  sourceVideoSha256: string;
  durationSeconds: number;
  outputPath: string;
}

export interface LoadReusableSourceAudioInspectionInput {
  filePath: string;
  expectedFileSha256: string;
  sourceVideoSha256: string;
  durationSeconds: number;
}

export interface SourceAudioInspectionDependencies {
  ffmpegPath?: string | null;
  ffprobePath?: string | null;
  runProcess?: ProcessRunner;
  assertReadable?: (filePath: string) => Promise<void>;
  timeoutMs?: number;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}

interface ProbeReport {
  streams?: ProbeStream[];
}

export interface ParsedSourceAudioAnalysisLog {
  peakVolumeDbfs: number;
  meanVolumeDbfs: number;
  silentDurationSeconds: number;
  activeDurationSeconds: number;
}

interface SilenceInterval {
  start: number;
  end: number;
}

function validatePath(label: string, value: string): void {
  if (!value.trim()) throw new MediaAssemblyError(`${label} must be a non-empty file path`);
  if (value.includes("\0")) throw new MediaAssemblyError(`${label} contains a NUL byte`);
}

function requiredBinary(label: string, value: string | null | undefined): string {
  if (!value) {
    throw new MediaAssemblyError(
      `${label} binary is unavailable for this platform. Install dependencies on the target OS and architecture.`,
    );
  }
  return value;
}

async function defaultAssertReadable(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.R_OK);
  } catch (cause) {
    throw new MediaAssemblyError(`Input file is not readable: ${filePath}`, { cause });
  }
}

function finiteNumberOrNull(value: unknown): number | null {
  const parsed = typeof value === "string" || typeof value === "number"
    ? Number(value)
    : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseDbfs(text: string, label: "max_volume" | "mean_volume"): number {
  const matches = [...text.matchAll(
    new RegExp(`${label}:\\s*(-?inf|-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))\\s*dB`, "gi"),
  )];
  const raw = matches.at(-1)?.[1];
  if (!raw) {
    throw new MediaAssemblyError(`FFmpeg did not report ${label.replace("_", " ")}.`);
  }
  if (raw.toLowerCase() === "-inf") return Number.NEGATIVE_INFINITY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new MediaAssemblyError(`FFmpeg reported an invalid ${label.replace("_", " ")}.`);
  }
  return parsed;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function mergeSilenceIntervals(
  intervals: readonly SilenceInterval[],
  durationSeconds: number,
): SilenceInterval[] {
  const normalized = intervals
    .map(({ start, end }) => ({
      start: clamp(start, 0, durationSeconds),
      end: clamp(end, 0, durationSeconds),
    }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SilenceInterval[] = [];
  for (const interval of normalized) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
    } else {
      previous.end = Math.max(previous.end, interval.end);
    }
  }
  return merged;
}

function silenceIntervals(text: string, durationSeconds: number): SilenceInterval[] {
  const events = [...text.matchAll(
    /silence_(start|end):\s*(-?(?:\d+(?:\.\d+)?|\.\d+))/gi,
  )];
  const intervals: SilenceInterval[] = [];
  let openStart: number | null = null;
  for (const event of events) {
    const kind = event[1]?.toLowerCase();
    const atSeconds = Number(event[2]);
    if (!Number.isFinite(atSeconds)) continue;
    if (kind === "start") {
      if (openStart === null) openStart = atSeconds;
    } else if (openStart !== null) {
      intervals.push({ start: openStart, end: atSeconds });
      openStart = null;
    }
  }
  if (openStart !== null) intervals.push({ start: openStart, end: durationSeconds });
  return mergeSilenceIntervals(intervals, durationSeconds);
}

function roundedDuration(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Parse the deterministic FFmpeg filter log used by source-audio inspection. */
export function parseSourceAudioAnalysisLog(
  stderr: string,
  durationSeconds: number,
): ParsedSourceAudioAnalysisLog {
  const duration = DurationSchema.parse(durationSeconds);
  const peakVolumeDbfs = parseDbfs(stderr, "max_volume");
  const meanVolumeDbfs = parseDbfs(stderr, "mean_volume");
  const intervals = silenceIntervals(stderr, duration);
  const silentDurationSeconds = roundedDuration(intervals.reduce(
    (total, interval) => total + interval.end - interval.start,
    0,
  ));
  const activeDurationSeconds = roundedDuration(Math.max(0, duration - silentDurationSeconds));
  return {
    peakVolumeDbfs,
    meanVolumeDbfs,
    silentDurationSeconds,
    activeDurationSeconds,
  };
}

function serializableDbfs(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function usabilityReason(metrics: ParsedSourceAudioAnalysisLog): {
  usable: boolean;
  reason: string;
} {
  if (!(metrics.peakVolumeDbfs > SOURCE_AUDIO_MIN_PEAK_DBFS)) {
    return {
      usable: false,
      reason: `Embedded audio peak did not exceed ${SOURCE_AUDIO_MIN_PEAK_DBFS} dBFS.`,
    };
  }
  if (!(metrics.meanVolumeDbfs > SOURCE_AUDIO_MIN_MEAN_DBFS)) {
    return {
      usable: false,
      reason: `Embedded audio mean level did not exceed ${SOURCE_AUDIO_MIN_MEAN_DBFS} dBFS.`,
    };
  }
  if (metrics.activeDurationSeconds < SOURCE_AUDIO_MIN_ACTIVE_SECONDS) {
    return {
      usable: false,
      reason: `Embedded audio contained less than ${SOURCE_AUDIO_MIN_ACTIVE_SECONDS} seconds of active signal.`,
    };
  }
  return {
    usable: true,
    reason: "Embedded source audio contains a meaningful decodable signal.",
  };
}

function thresholds(): SourceAudioInspectionDocument["thresholds"] {
  return {
    silenceDbfs: SOURCE_AUDIO_SILENCE_THRESHOLD_DBFS,
    minimumSilenceSeconds: SOURCE_AUDIO_MIN_SILENCE_SECONDS,
    minimumPeakDbfs: SOURCE_AUDIO_MIN_PEAK_DBFS,
    minimumMeanDbfs: SOURCE_AUDIO_MIN_MEAN_DBFS,
    minimumActiveSeconds: SOURCE_AUDIO_MIN_ACTIVE_SECONDS,
  };
}

function probeArgs(filePath: string): string[] {
  return [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,duration",
    "-of", "json",
    filePath,
  ];
}

function analysisArgs(filePath: string, durationSeconds: number): string[] {
  const duration = durationSeconds.toFixed(3);
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "info",
    "-i", filePath,
    "-map", "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-af",
    `apad=whole_dur=${duration},atrim=start=0:duration=${duration},`
      + `silencedetect=noise=${SOURCE_AUDIO_SILENCE_THRESHOLD_DBFS}dB:d=${SOURCE_AUDIO_MIN_SILENCE_SECONDS},`
      + "volumedetect",
    "-f", "null",
    "-",
  ];
}

/**
 * Inspect and atomically persist whether an Agnes MP4 contains useful native
 * audio. Provider/process failures throw; a valid file with no stream or only
 * silence returns a durable `usable: false` decision.
 */
export async function inspectSourceAudio(
  input: InspectSourceAudioInput,
  dependencies: SourceAudioInspectionDependencies = {},
): Promise<SourceAudioInspectionDocument> {
  validatePath("sourceVideoPath", input.sourceVideoPath);
  validatePath("outputPath", input.outputPath);
  const sourceVideoSha256 = Sha256Schema.parse(input.sourceVideoSha256);
  const durationSeconds = DurationSchema.parse(input.durationSeconds);
  const ffprobePath = requiredBinary(
    "FFprobe",
    dependencies.ffprobePath === undefined ? ffprobeStaticPath : dependencies.ffprobePath,
  );
  const ffmpegPath = requiredBinary(
    "FFmpeg",
    dependencies.ffmpegPath === undefined ? ffmpegStaticPath : dependencies.ffmpegPath,
  );
  const runProcess = dependencies.runProcess ?? createSpawnProcessRunner({
    timeoutMs: dependencies.timeoutMs ?? DEFAULT_MEDIA_PROCESS_TIMEOUT_MS,
  });
  const processOptions = dependencies.timeoutMs === undefined
    ? undefined
    : { timeoutMs: dependencies.timeoutMs };
  const assertReadable = dependencies.assertReadable ?? defaultAssertReadable;
  await assertReadable(input.sourceVideoPath);

  const probe = await runProcess(ffprobePath, probeArgs(input.sourceVideoPath), processOptions);
  let report: ProbeReport;
  try {
    report = JSON.parse(probe.stdout) as ProbeReport;
  } catch (cause) {
    throw new MediaAssemblyError("FFprobe returned invalid JSON for source audio.", { cause });
  }
  const audioStreams = (report.streams ?? []).filter(({ codec_type }) => codec_type === "audio");
  if (audioStreams.length > 1) {
    throw new MediaAssemblyError(
      `Expected at most one selected source audio stream; FFprobe reported ${audioStreams.length}.`,
    );
  }
  const stream = audioStreams[0];
  if (!stream) {
    const document = SourceAudioInspectionDocumentSchema.parse({
      schemaVersion: 2,
      inspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
      sourceVideoSha256,
      durationSeconds,
      audioStream: null,
      thresholds: thresholds(),
      peakVolumeDbfs: null,
      meanVolumeDbfs: null,
      silentDurationSeconds: durationSeconds,
      activeDurationSeconds: 0,
      usable: false,
      reason: "The source video contains no embedded audio stream.",
    });
    await writeJsonAtomic(input.outputPath, document);
    return document;
  }
  if (!stream.codec_name?.trim()) {
    throw new MediaAssemblyError("FFprobe reported a source audio stream without a codec name.");
  }

  const analysis = await runProcess(
    ffmpegPath,
    analysisArgs(input.sourceVideoPath, durationSeconds),
    processOptions,
  );
  const metrics = parseSourceAudioAnalysisLog(analysis.stderr, durationSeconds);
  const decision = usabilityReason(metrics);
  const document = SourceAudioInspectionDocumentSchema.parse({
    schemaVersion: 2,
    inspectionRevision: SOURCE_AUDIO_INSPECTION_REVISION,
    sourceVideoSha256,
    durationSeconds,
    audioStream: {
      codecName: stream.codec_name.trim(),
      sampleRate: finiteNumberOrNull(stream.sample_rate),
      channels: Number.isSafeInteger(stream.channels) && (stream.channels as number) > 0
        ? stream.channels
        : null,
      durationSeconds: finiteNumberOrNull(stream.duration),
    },
    thresholds: thresholds(),
    peakVolumeDbfs: serializableDbfs(metrics.peakVolumeDbfs),
    meanVolumeDbfs: serializableDbfs(metrics.meanVolumeDbfs),
    silentDurationSeconds: metrics.silentDurationSeconds,
    activeDurationSeconds: metrics.activeDurationSeconds,
    usable: decision.usable,
    reason: decision.reason,
  });
  await writeJsonAtomic(input.outputPath, document);
  return document;
}

/** Load an inspection only while it remains bound to its exact local inputs. */
export async function loadReusableSourceAudioInspection(
  input: LoadReusableSourceAudioInspectionInput,
): Promise<SourceAudioInspectionDocument | null> {
  try {
    const expectedFileSha256 = Sha256Schema.parse(input.expectedFileSha256);
    const sourceVideoSha256 = Sha256Schema.parse(input.sourceVideoSha256);
    const durationSeconds = DurationSchema.parse(input.durationSeconds);
    if (await sha256File(input.filePath) !== expectedFileSha256) return null;
    const value = await readJsonIfPresent<unknown>(input.filePath);
    if (value === null) return null;
    const parsed = SourceAudioInspectionDocumentSchema.safeParse(value);
    if (!parsed.success) return null;
    return parsed.data.sourceVideoSha256 === sourceVideoSha256
      && parsed.data.durationSeconds === durationSeconds
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}
