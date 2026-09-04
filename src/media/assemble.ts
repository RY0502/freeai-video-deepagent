import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

import ffmpegStaticModule from "ffmpeg-static";
import ffprobeStaticModule from "@derhuerst/ffprobe-static";

// These packages are CommonJS at runtime but publish ESM-style default type
// declarations. The explicit narrowing keeps NodeNext builds correct while the
// imports still resolve to the string exported through module.exports.
const ffmpegStaticPath = ffmpegStaticModule as unknown as string | null;
const ffprobeStaticPath = ffprobeStaticModule as unknown as string | null;

export const MIN_SCENE_COUNT = 1;
export const MAX_SCENE_COUNT = 1;
export const MIN_FINAL_DURATION_SECONDS = 4;
export const MAX_FINAL_DURATION_SECONDS = 12;
export const AUDIO_SAMPLE_RATE = 48_000;

/**
 * Increment when a local Foley/assembly filter graph changes in a way that
 * requires deterministic artifacts to be rebuilt from retained source media.
 */
export const AUDIO_MIX_REVISION = 7;
export const DEFAULT_BACKGROUND_MUSIC_VOLUME = 0.10;
export const BACKGROUND_MUSIC_MIX = Object.freeze({
  mode: "continuous_overlay" as const,
  ducking: false as const,
});

export const DEFAULT_MEDIA_PROCESS_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 1_000_000;
const MAX_VOLUME = 4;

export interface FoleyStemInput {
  path: string;
  /** Linear gain. Values above 1 amplify the stem. */
  volume?: number;
}

/**
 * Foreground sound can either come from the soundtrack Agnes embedded in the
 * source video or from a separately generated Foley stem. Native sound does
 * not accept gain or normalization controls so its original dynamics survive
 * the assembly pass.
 */
export type ForegroundAudioInput =
  | { kind: "native" }
  | ({ kind: "foley" } & FoleyStemInput);

export type SceneDurationSeconds = number;

export interface VideoAssemblySceneInput {
  /** Scene clip path. Scenes are assembled in array order. */
  videoPath: string;
  /** Agnes Video 2.5 Flash supports one integer-duration 4-12 second source. */
  durationSeconds: SceneDurationSeconds;
  /**
   * Foreground audio for this scene. Do not also provide `foleyStem`.
   */
  foregroundAudio?: ForegroundAudioInput;
  /**
   * Backwards-compatible shorthand for `foregroundAudio: { kind: "foley", ... }`.
   * Exactly one of `foregroundAudio` and `foleyStem` is required.
   */
  foleyStem?: FoleyStemInput;
}

export interface VideoAssemblyInput {
  /** Exactly one continuous Agnes source video. */
  scenes: readonly VideoAssemblySceneInput[];
  /** Optional quiet background score. Omit it for Foley-only output. */
  musicPath?: string;
  /** Must not already exist; the production command uses ffmpeg's `-n`. */
  outputPath: string;
  musicVolume?: number;
  width?: number;
  height?: number;
  fps?: number;
}

export interface NormalizedVideoAssemblySceneInput {
  videoPath: string;
  durationSeconds: SceneDurationSeconds;
  startSeconds: number;
  foregroundAudio:
    | { kind: "native" }
    | ({ kind: "foley" } & FoleyStemInput & { volume: number });
}

export interface NormalizedAssemblyInput {
  scenes: readonly NormalizedVideoAssemblySceneInput[];
  musicPath?: string;
  outputPath: string;
  musicVolume: number;
  width: number;
  height: number;
  fps: number;
  totalDurationSeconds: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface ProcessRunOptions {
  timeoutMs?: number;
}

export type ProcessRunner = (
  executable: string,
  args: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ProcessResult>;

export interface MediaDependencies {
  ffmpegPath?: string | null;
  ffprobePath?: string | null;
  runProcess?: ProcessRunner;
  assertReadable?: (filePath: string) => Promise<void>;
}

export interface VideoAssemblyResult {
  outputPath: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: "h264";
  audioCodec: "aac";
  audioSampleRate: typeof AUDIO_SAMPLE_RATE;
  audioChannels: 2;
}

export interface ExistingVideoValidationInput {
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  expectedDurationSeconds: number;
}

export interface ExistingAudioValidationInput {
  inputPath: string;
  /** The score may be longer than the final edit, but never shorter. */
  minimumDurationSeconds: number;
}

export interface ExistingAudioValidationResult {
  inputPath: string;
  durationSeconds: number;
  codecName: string;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
}

interface ProbeReport {
  streams?: ProbeStream[];
  format?: {
    duration?: string;
  };
}

export class MediaAssemblyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MediaAssemblyError";
  }
}

export class MediaProcessError extends MediaAssemblyError {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(
    message: string,
    executable: string,
    args: readonly string[],
    stderr: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MediaProcessError";
    this.executable = executable;
    this.args = args;
    this.stderr = stderr;
  }
}

export interface SpawnRunnerOptions {
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Executes a known binary directly. It deliberately never invokes a shell, so
 * prompts and file names cannot be interpreted as shell syntax.
 */
export function createSpawnProcessRunner(options: SpawnRunnerOptions = {}): ProcessRunner {
  const spawnImpl = options.spawnImpl ?? spawn;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_MEDIA_PROCESS_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES;

  if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    throw new MediaAssemblyError("Process timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new MediaAssemblyError("Maximum process output must be a positive integer");
  }

  return async (executable, args, runOptions = {}) => {
    const timeoutMs = runOptions.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new MediaAssemblyError("Process timeout must be a positive integer");
    }

    return await new Promise<ProcessResult>((resolve, reject) => {
      // Passing an argument array with shell:false is intentional. Do not replace
      // this with a command string or expose arbitrary FFmpeg arguments to tools.
      const child = spawnImpl(executable, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }) as unknown as ChildProcessWithoutNullStreams;

      let stdout = "";
      let stderr = "";
      let capturedBytes = 0;
      let settled = false;

      const capture = (current: string, chunk: Buffer | string): string => {
        if (capturedBytes >= maxOutputBytes) return current;
        const text = chunk.toString();
        const remaining = maxOutputBytes - capturedBytes;
        const captured = text.slice(0, remaining);
        capturedBytes += Buffer.byteLength(captured);
        return current + captured;
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout = capture(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr = capture(stderr, chunk);
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(
          new MediaProcessError(
            `Media process exceeded its ${timeoutMs}ms timeout`,
            executable,
            args,
            stderr,
          ),
        );
      }, timeoutMs);
      timer.unref();

      child.once("error", (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new MediaProcessError(
            `Unable to start media process: ${executable}`,
            executable,
            args,
            stderr,
            { cause },
          ),
        );
      });

      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          new MediaProcessError(
            `Media process exited with code ${String(code)}${signal ? ` (${signal})` : ""}`,
            executable,
            args,
            stderr,
          ),
        );
      });
    });
  };
}

function validateFilePath(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MediaAssemblyError(`${label} must be a non-empty file path`);
  }
  if (value.includes("\0")) {
    throw new MediaAssemblyError(`${label} contains a NUL byte`);
  }
}

function validateEvenDimension(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 16 || value > 7680 || value % 2 !== 0) {
    throw new MediaAssemblyError(`${label} must be an even integer between 16 and 7680`);
  }
}

function validateVolume(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > MAX_VOLUME) {
    throw new MediaAssemblyError(`${label} must be between 0 and ${MAX_VOLUME}`);
  }
}

export function normalizeAssemblyInput(
  input: VideoAssemblyInput,
): NormalizedAssemblyInput {
  if (input.scenes.length < MIN_SCENE_COUNT || input.scenes.length > MAX_SCENE_COUNT) {
    throw new MediaAssemblyError(
      `Between ${MIN_SCENE_COUNT} and ${MAX_SCENE_COUNT} ordered scenes are required`,
    );
  }

  validateFilePath("outputPath", input.outputPath);
  if (input.musicPath !== undefined) validateFilePath("musicPath", input.musicPath);

  let startSeconds = 0;
  const scenes = input.scenes.map((scene, index): NormalizedVideoAssemblySceneInput => {
    validateFilePath(`scenes[${index}].videoPath`, scene.videoPath);
    const sourceCount = Number(scene.foregroundAudio !== undefined)
      + Number(scene.foleyStem !== undefined);
    if (sourceCount !== 1) {
      throw new MediaAssemblyError(
        `scenes[${index}] requires exactly one foreground audio source: `
        + `provide either foregroundAudio or foleyStem`,
      );
    }

    const requestedForeground = scene.foregroundAudio
      ?? (scene.foleyStem === undefined
        ? undefined
        : { kind: "foley" as const, ...scene.foleyStem });
    let foregroundAudio: NormalizedVideoAssemblySceneInput["foregroundAudio"];
    if (requestedForeground?.kind === "native") {
      foregroundAudio = { kind: "native" };
    } else if (requestedForeground?.kind === "foley") {
      validateFilePath(
        `scenes[${index}].foregroundAudio.path`,
        requestedForeground.path,
      );
      validateVolume(
        `scenes[${index}].foregroundAudio.volume`,
        requestedForeground.volume ?? 1,
      );
      foregroundAudio = {
        ...requestedForeground,
        volume: requestedForeground.volume ?? 1,
      };
    } else {
      throw new MediaAssemblyError(
        `scenes[${index}].foregroundAudio.kind must be native or foley`,
      );
    }
    if (
      !Number.isSafeInteger(scene.durationSeconds)
      || scene.durationSeconds < MIN_FINAL_DURATION_SECONDS
      || scene.durationSeconds > MAX_FINAL_DURATION_SECONDS
    ) {
      throw new MediaAssemblyError(
        `scenes[${index}].durationSeconds must be an integer from `
        + `${MIN_FINAL_DURATION_SECONDS} through ${MAX_FINAL_DURATION_SECONDS}`,
      );
    }
    const normalized = {
      videoPath: scene.videoPath,
      durationSeconds: scene.durationSeconds,
      startSeconds,
      foregroundAudio,
    };
    startSeconds += scene.durationSeconds;
    return normalized;
  });
  if (startSeconds > MAX_FINAL_DURATION_SECONDS) {
    throw new MediaAssemblyError(
      `Scene durations total ${startSeconds}s; the maximum is ${MAX_FINAL_DURATION_SECONDS}s`,
    );
  }

  const allInputs = [
    ...scenes.map(({ videoPath }) => videoPath),
    ...(input.musicPath === undefined ? [] : [input.musicPath]),
    ...scenes.flatMap(({ foregroundAudio }) =>
      foregroundAudio.kind === "foley" ? [foregroundAudio.path] : []),
  ];
  if (allInputs.includes(input.outputPath)) {
    throw new MediaAssemblyError("outputPath must differ from every input path");
  }

  const width = input.width ?? 720;
  const height = input.height ?? 1280;
  const fps = input.fps ?? 30;
  // Music is a quiet, continuous underscore. Scene sound effects are mixed on
  // top without changing the music gain when a cue begins or ends.
  const musicVolume = input.musicVolume ?? DEFAULT_BACKGROUND_MUSIC_VOLUME;

  validateEvenDimension("width", width);
  validateEvenDimension("height", height);
  if (!Number.isSafeInteger(fps) || fps < 1 || fps > 120) {
    throw new MediaAssemblyError("fps must be an integer between 1 and 120");
  }
  validateVolume("musicVolume", musicVolume);

  return {
    scenes,
    ...(input.musicPath !== undefined ? { musicPath: input.musicPath } : {}),
    outputPath: input.outputPath,
    musicVolume,
    width,
    height,
    fps,
    totalDurationSeconds: startSeconds,
  };
}

function formatGain(value: number): string {
  return value.toFixed(3);
}

export function buildFilterGraph(input: NormalizedAssemblyInput): string {
  const sceneCount = input.scenes.length;
  const videoFilters = input.scenes.map(
    (scene, index) =>
      `[${index}:v:0]fps=fps=${input.fps},` +
      `scale=w=${input.width}:h=${input.height}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${input.width}:${input.height},setsar=1,` +
      `tpad=stop_mode=clone:stop_duration=${scene.durationSeconds},` +
      `trim=start=0:duration=${scene.durationSeconds},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`,
  );

  const musicInputIndex = sceneCount;
  const musicFilter = input.musicPath === undefined
    ? undefined
    : `[${musicInputIndex}:a:0]aresample=${AUDIO_SAMPLE_RATE},` +
      `aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,` +
      `loudnorm=I=-18:TP=-3:LRA=7,` +
      `apad=whole_dur=${input.totalDurationSeconds},` +
      `atrim=start=0:duration=${input.totalDurationSeconds},` +
      `asetpts=N/SR/TB,volume=${formatGain(input.musicVolume)}[music]`;

  let nextExternalAudioInput = sceneCount + (input.musicPath === undefined ? 0 : 1);
  const foregroundFilters = input.scenes.map((scene, index) => {
    if (scene.foregroundAudio.kind === "native") {
      // Reuse the audio stream from the already-open scene input. Async
      // resampling corrects provider timestamp drift without reopening the
      // source video, while avoiding loudness normalization preserves the
      // source soundtrack's dynamics.
      return (
        `[${index}:a:0]aresample=${AUDIO_SAMPLE_RATE}:async=1:first_pts=0,` +
        `aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,` +
        `apad=whole_dur=${scene.durationSeconds},` +
        `atrim=start=0:duration=${scene.durationSeconds},asetpts=N/SR/TB[native${index}]`
      );
    }

    const inputIndex = nextExternalAudioInput;
    nextExternalAudioInput += 1;
    const delayMilliseconds = scene.startSeconds * 1000;
    return (
      `[${inputIndex}:a:0]aresample=${AUDIO_SAMPLE_RATE},` +
      `aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,` +
      `apad=whole_dur=${scene.durationSeconds},` +
      `atrim=start=0:duration=${scene.durationSeconds},asetpts=N/SR/TB,` +
      `volume=${formatGain(scene.foregroundAudio.volume)},adelay=${delayMilliseconds}:all=1[foley${index}]`
    );
  });

  const videoConcat = sceneCount === 1
    ? "[v0]null[video]"
    : `${input.scenes.map((_scene, index) => `[v${index}]`).join("")}` +
      `concat=n=${sceneCount}:v=1:a=0[video]`;
  const foregroundLabels = input.scenes.map((scene, index) =>
    scene.foregroundAudio.kind === "native" ? `[native${index}]` : `[foley${index}]`
  ).join("");
  const effectsMix = foregroundLabels +
    (sceneCount === 1
      ? "anull[effects]"
      : `amix=inputs=${sceneCount}:duration=longest:dropout_transition=0:normalize=0[effects]`);
  const finalAudio = input.musicPath === undefined
    ? `[effects]alimiter=limit=0.95:attack=5:release=50:latency=1,` +
      `apad=whole_dur=${input.totalDurationSeconds},` +
      `atrim=start=0:duration=${input.totalDurationSeconds},asetpts=N/SR/TB[audio]`
    : `[music][effects]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,` +
      `alimiter=limit=0.95:attack=5:release=50:latency=1,` +
      `apad=whole_dur=${input.totalDurationSeconds},` +
      `atrim=start=0:duration=${input.totalDurationSeconds},asetpts=N/SR/TB[audio]`;

  return [
    ...videoFilters,
    videoConcat,
    ...(musicFilter === undefined ? [] : [musicFilter]),
    ...foregroundFilters,
    effectsMix,
    finalAudio,
  ].join(";");
}

export function buildAssemblyArgs(
  input: VideoAssemblyInput | NormalizedAssemblyInput,
): string[] {
  const normalized = normalizeAssemblyInput(input);
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-n"];

  for (const scene of normalized.scenes) {
    args.push("-i", scene.videoPath);
  }
  if (normalized.musicPath !== undefined) args.push("-i", normalized.musicPath);
  for (const scene of normalized.scenes) {
    if (scene.foregroundAudio.kind === "foley") {
      args.push("-i", scene.foregroundAudio.path);
    }
  }

  args.push(
    "-filter_complex",
    buildFilterGraph(normalized),
    "-map",
    "[video]",
    "-map",
    "[audio]",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(normalized.fps),
    "-fps_mode",
    "cfr",
    "-g",
    String(Math.max(1, Math.round(normalized.fps / 2))),
    "-bf",
    "2",
    "-flags",
    "+cgop",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-c:a",
    "aac",
    "-profile:a",
    "aac_low",
    "-b:a",
    "192k",
    "-ar",
    String(AUDIO_SAMPLE_RATE),
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    "-t",
    normalized.totalDurationSeconds.toFixed(3),
    normalized.outputPath,
  );

  return args;
}

export function buildProbeArgs(outputPath: string): string[] {
  validateFilePath("outputPath", outputPath);
  return [
    "-v",
    "error",
    "-of",
    "json",
    "-show_entries",
    "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
    outputPath,
  ];
}

function parseFrameRate(value: string | undefined): number {
  if (!value) return Number.NaN;
  const [numeratorText, denominatorText = "1"] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return Number.NaN;
  }
  return numerator / denominator;
}

export function validateProbeReport(
  report: ProbeReport,
  input: Pick<
    NormalizedAssemblyInput,
    "outputPath" | "totalDurationSeconds" | "width" | "height" | "fps"
  >,
): VideoAssemblyResult {
  const streams = report.streams ?? [];
  const videoStreams = streams.filter(({ codec_type }) => codec_type === "video");
  const audioStreams = streams.filter(({ codec_type }) => codec_type === "audio");
  if (videoStreams.length !== 1 || audioStreams.length !== 1) {
    throw new MediaAssemblyError(
      `Expected one video stream and one audio stream; found ${videoStreams.length} video and ${audioStreams.length} audio`,
    );
  }

  const video = videoStreams[0]!;
  const audio = audioStreams[0]!;
  const duration = Number(report.format?.duration);
  const frameRate = parseFrameRate(video.r_frame_rate);
  const durationTolerance = Math.max(0.05, 1 / input.fps);

  if (!Number.isFinite(duration) || Math.abs(duration - input.totalDurationSeconds) > durationTolerance) {
    throw new MediaAssemblyError(
      `Expected a ${input.totalDurationSeconds}s output; ffprobe reported ${String(report.format?.duration)}`,
    );
  }
  if (video.codec_name !== "h264") {
    throw new MediaAssemblyError(`Expected H.264 video; ffprobe reported ${String(video.codec_name)}`);
  }
  if (video.width !== input.width || video.height !== input.height) {
    throw new MediaAssemblyError(
      `Expected ${input.width}x${input.height}; ffprobe reported ${String(video.width)}x${String(video.height)}`,
    );
  }
  if (!Number.isFinite(frameRate) || Math.abs(frameRate - input.fps) > 0.01) {
    throw new MediaAssemblyError(
      `Expected ${input.fps}fps; ffprobe reported ${String(video.r_frame_rate)}`,
    );
  }
  if (audio.codec_name !== "aac") {
    throw new MediaAssemblyError(`Expected AAC audio; ffprobe reported ${String(audio.codec_name)}`);
  }
  if (Number(audio.sample_rate) !== AUDIO_SAMPLE_RATE || audio.channels !== 2) {
    throw new MediaAssemblyError(
      `Expected 48kHz stereo audio; ffprobe reported ${String(audio.sample_rate)}Hz/${String(audio.channels)} channels`,
    );
  }

  return {
    outputPath: input.outputPath,
    durationSeconds: duration,
    width: input.width,
    height: input.height,
    fps: input.fps,
    videoCodec: "h264",
    audioCodec: "aac",
    audioSampleRate: AUDIO_SAMPLE_RATE,
    audioChannels: 2,
  };
}

async function defaultAssertReadable(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.R_OK);
  } catch (cause) {
    throw new MediaAssemblyError(`Input file is not readable: ${filePath}`, { cause });
  }
}

function requireBinaryPath(label: string, binaryPath: string | null | undefined): string {
  if (!binaryPath) {
    throw new MediaAssemblyError(
      `${label} binary is unavailable for this platform. Install dependencies on the target OS and architecture.`,
    );
  }
  return binaryPath;
}

export async function assembleVideo(
  input: VideoAssemblyInput,
  dependencies: MediaDependencies = {},
): Promise<VideoAssemblyResult> {
  const normalized = normalizeAssemblyInput(input);
  const ffmpegPath = requireBinaryPath(
    "FFmpeg",
    dependencies.ffmpegPath === undefined ? ffmpegStaticPath : dependencies.ffmpegPath,
  );
  const ffprobePath = requireBinaryPath(
    "FFprobe",
    dependencies.ffprobePath === undefined ? ffprobeStaticPath : dependencies.ffprobePath,
  );
  const runProcess = dependencies.runProcess ?? createSpawnProcessRunner();
  const assertReadable = dependencies.assertReadable ?? defaultAssertReadable;

  await Promise.all(
    [
      ...normalized.scenes.map(({ videoPath }) => videoPath),
      ...(normalized.musicPath === undefined ? [] : [normalized.musicPath]),
      ...normalized.scenes.flatMap(({ foregroundAudio }) =>
        foregroundAudio.kind === "foley" ? [foregroundAudio.path] : []),
    ].map(async (filePath) => await assertReadable(filePath)),
  );

  await runProcess(ffmpegPath, buildAssemblyArgs(normalized));
  return await validateExistingVideo({
    outputPath: normalized.outputPath,
    width: normalized.width,
    height: normalized.height,
    fps: normalized.fps,
    expectedDurationSeconds: normalized.totalDurationSeconds,
  }, {
    ffprobePath,
    runProcess,
    assertReadable,
  });
}

/** Re-probe a completed artifact before it is reused or its inputs are deleted. */
export async function validateExistingVideo(
  input: ExistingVideoValidationInput,
  dependencies: MediaDependencies = {},
): Promise<VideoAssemblyResult> {
  validateFilePath("outputPath", input.outputPath);
  validateEvenDimension("width", input.width);
  validateEvenDimension("height", input.height);
  if (!Number.isSafeInteger(input.fps) || input.fps < 1 || input.fps > 120) {
    throw new MediaAssemblyError("fps must be an integer between 1 and 120");
  }
  if (
    !Number.isSafeInteger(input.expectedDurationSeconds)
    || input.expectedDurationSeconds < MIN_FINAL_DURATION_SECONDS
    || input.expectedDurationSeconds > MAX_FINAL_DURATION_SECONDS
  ) {
    throw new MediaAssemblyError(
      `expectedDurationSeconds must be an integer between `
      + `${MIN_FINAL_DURATION_SECONDS} and ${MAX_FINAL_DURATION_SECONDS}`,
    );
  }
  const ffprobePath = requireBinaryPath(
    "FFprobe",
    dependencies.ffprobePath === undefined ? ffprobeStaticPath : dependencies.ffprobePath,
  );
  const runProcess = dependencies.runProcess ?? createSpawnProcessRunner();
  const assertReadable = dependencies.assertReadable ?? defaultAssertReadable;
  await assertReadable(input.outputPath);
  const probeResult = await runProcess(ffprobePath, buildProbeArgs(input.outputPath));

  let report: ProbeReport;
  try {
    report = JSON.parse(probeResult.stdout) as ProbeReport;
  } catch (cause) {
    throw new MediaAssemblyError("FFprobe returned invalid JSON", { cause });
  }

  return validateProbeReport(report, {
    outputPath: input.outputPath,
    totalDurationSeconds: input.expectedDurationSeconds,
    width: input.width,
    height: input.height,
    fps: input.fps,
  });
}

/**
 * Decode-level metadata validation for provider audio before it becomes a
 * completed checkpoint. This rejects HTML/error bodies accepted under a
 * missing or generic Content-Type and safely recognizes atomically downloaded
 * music after a crash.
 */
export async function validateExistingAudio(
  input: ExistingAudioValidationInput,
  dependencies: MediaDependencies = {},
): Promise<ExistingAudioValidationResult> {
  validateFilePath("inputPath", input.inputPath);
  if (!Number.isFinite(input.minimumDurationSeconds) || input.minimumDurationSeconds <= 0) {
    throw new MediaAssemblyError("minimumDurationSeconds must be a positive number");
  }
  const ffprobePath = requireBinaryPath(
    "FFprobe",
    dependencies.ffprobePath === undefined ? ffprobeStaticPath : dependencies.ffprobePath,
  );
  const runProcess = dependencies.runProcess ?? createSpawnProcessRunner();
  const assertReadable = dependencies.assertReadable ?? defaultAssertReadable;
  await assertReadable(input.inputPath);
  const probeResult = await runProcess(ffprobePath, buildProbeArgs(input.inputPath));

  let report: ProbeReport;
  try {
    report = JSON.parse(probeResult.stdout) as ProbeReport;
  } catch (cause) {
    throw new MediaAssemblyError("FFprobe returned invalid JSON for the music file", { cause });
  }

  const streams = report.streams ?? [];
  const audioStreams = streams.filter(({ codec_type }) => codec_type === "audio");
  const videoStreams = streams.filter(({ codec_type }) => codec_type === "video");
  if (audioStreams.length !== 1 || videoStreams.length !== 0) {
    throw new MediaAssemblyError(
      `Expected one audio stream and no video streams; found ${audioStreams.length} audio and ${videoStreams.length} video`,
    );
  }
  const codecName = audioStreams[0]?.codec_name;
  if (!codecName) throw new MediaAssemblyError("FFprobe reported no audio codec for the music file");
  const durationSeconds = Number(report.format?.duration);
  if (
    !Number.isFinite(durationSeconds)
    || durationSeconds + 0.1 < input.minimumDurationSeconds
  ) {
    throw new MediaAssemblyError(
      `Expected music lasting at least ${input.minimumDurationSeconds}s; ffprobe reported ${String(report.format?.duration)}`,
    );
  }
  return { inputPath: input.inputPath, durationSeconds, codecName };
}
