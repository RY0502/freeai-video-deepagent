import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import ffmpegStaticModule from "ffmpeg-static";

import {
  AUDIO_MIX_REVISION,
  BACKGROUND_MUSIC_MIX,
  DEFAULT_BACKGROUND_MUSIC_VOLUME,
  MediaAssemblyError,
  assembleVideo,
  buildAssemblyArgs,
  createSpawnProcessRunner,
  normalizeAssemblyInput,
  validateExistingAudio,
  type ProcessRunner,
  type VideoAssemblyInput,
} from "../src/media/index.js";

const ffmpegPath = ffmpegStaticModule as unknown as string | null;

function validInput(overrides: Partial<VideoAssemblyInput> = {}): VideoAssemblyInput {
  return {
    scenes: [{
      videoPath: "/media/source.mp4",
      durationSeconds: 9,
      foleyStem: { path: "/media/foley.wav", volume: 0.9 },
    }],
    musicPath: "/media/music.mp3",
    outputPath: "/media/final.mp4",
    width: 720,
    height: 1280,
    fps: 30,
    musicVolume: 0.5,
    ...overrides,
  };
}

function validProbeJson(durationSeconds = 9): string {
  return JSON.stringify({
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 720,
        height: 1280,
        r_frame_rate: "30/1",
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
      },
    ],
    format: { duration: durationSeconds.toFixed(6) },
  });
}

test("buildAssemblyArgs mixes one continuous source with full-length Foley and background music", () => {
  const args = buildAssemblyArgs(validInput());
  const filterGraph = args[args.indexOf("-filter_complex") + 1];
  assert.ok(filterGraph);

  assert.equal(args.filter((argument) => argument === "-i").length, 3);
  assert.match(filterGraph, /\[0:v:0\][^;]+trim=start=0:duration=9[^;]+\[v0\]/);
  assert.match(filterGraph, /\[v0\]null\[video\]/);
  assert.doesNotMatch(filterGraph, /concat=/);
  assert.match(filterGraph, /\[1:a:0\][^;]+volume=0\.500\[music\]/);
  assert.match(filterGraph, /\[2:a:0\][^;]+adelay=0:all=1\[foley0\]/);
  assert.doesNotMatch(filterGraph, /amix=inputs=1/);
  assert.equal(filterGraph.match(/loudnorm=I=-18:TP=-3:LRA=7/g)?.length, 1);
  assert.doesNotMatch(filterGraph, /loudnorm=I=-16:TP=-1\.5:LRA=7/);
  assert.doesNotMatch(filterGraph, /\[2:a:0\][^;]*loudnorm=/);
  assert.match(filterGraph, /volume=0\.900,adelay=0:all=1\[foley0\];\[foley0\]anull\[effects\]/);
  assert.equal(filterGraph.match(/alimiter=/g)?.length, 1);
  assert.doesNotMatch(filterGraph, /sidechaincompress|musicducked|duckkey|asplit/);
  assert.match(filterGraph, /\[music\]\[effects\]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0/);
  assert.match(filterGraph, /atrim=start=0:duration=9/);
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-movflags") + 1], "+faststart");
  assert.equal(args[args.indexOf("-t") + 1], "9.000");
  assert.equal(args.at(-1), "/media/final.mp4");
});

test("buildAssemblyArgs supports the twelve-second maximum without scene offsets", () => {
  const input = validInput({
    scenes: [{
      videoPath: "/media/source-12s.mp4",
      durationSeconds: 12,
      foleyStem: { path: "/media/foley-12s.wav" },
    }],
  });
  const args = buildAssemblyArgs(input);
  const filterGraph = args[args.indexOf("-filter_complex") + 1];
  assert.ok(filterGraph);

  assert.equal(args.filter((argument) => argument === "-i").length, 3);
  assert.match(filterGraph, /trim=start=0:duration=12/);
  assert.match(filterGraph, /adelay=0:all=1\[foley0\]/);
  assert.doesNotMatch(filterGraph, /adelay=(?!0:)/);
  assert.equal(args[args.indexOf("-t") + 1], "12.000");
});

test("buildAssemblyArgs supports Foley-only output without a music layer", () => {
  const { musicPath: _musicPath, ...withoutMusic } = validInput();
  const args = buildAssemblyArgs(withoutMusic);
  const filterGraph = args[args.indexOf("-filter_complex") + 1];
  assert.ok(filterGraph);

  assert.equal(args.filter((argument) => argument === "-i").length, 2);
  assert.match(filterGraph, /\[1:a:0\][^;]+adelay=0:all=1\[foley0\]/);
  assert.doesNotMatch(filterGraph, /\[music\]|sidechaincompress|musicducked|duckkey/);
  assert.match(filterGraph, /\[foley0\]anull\[effects\];\[effects\]alimiter=[^;]+apad=whole_dur=9/);
  assert.equal(args[args.indexOf("-t") + 1], "9.000");
});

test("buildAssemblyArgs overlays quiet music on native source audio without reopening the video", () => {
  const input = validInput({
    scenes: [{
      videoPath: "/media/source.mp4",
      durationSeconds: 9,
      foregroundAudio: { kind: "native" },
    }],
  });
  const args = buildAssemblyArgs(input);
  const filterGraph = args[args.indexOf("-filter_complex") + 1];
  assert.ok(filterGraph);

  const inputPaths = args.flatMap((argument, index) =>
    argument === "-i" ? [args[index + 1]] : []);
  assert.deepEqual(inputPaths, ["/media/source.mp4", "/media/music.mp3"]);
  assert.match(
    filterGraph,
    /\[0:a:0\]aresample=48000:async=1:first_pts=0,[^;]+\[native0\]/,
  );
  assert.match(filterGraph, /\[1:a:0\][^;]+volume=0\.500\[music\]/);
  assert.match(filterGraph, /\[native0\]anull\[effects\]/);
  assert.match(
    filterGraph,
    /\[music\]\[effects\]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0/,
  );
  assert.equal(filterGraph.match(/loudnorm=/g)?.length, 1);
  assert.doesNotMatch(filterGraph, /\[0:a:0\][^;]*loudnorm=/);
});

test("buildAssemblyArgs supports native source audio without music", () => {
  const input = validInput({
    scenes: [{
      videoPath: "/media/source.mp4",
      durationSeconds: 9,
      foregroundAudio: { kind: "native" },
    }],
  });
  delete input.musicPath;
  const args = buildAssemblyArgs(input);
  const filterGraph = args[args.indexOf("-filter_complex") + 1];
  assert.ok(filterGraph);

  assert.equal(args.filter((argument) => argument === "-i").length, 1);
  assert.match(filterGraph, /\[0:a:0\]aresample=48000:async=1:first_pts=0/);
  assert.doesNotMatch(filterGraph, /loudnorm=|\[music\]/);
  assert.match(
    filterGraph,
    /\[native0\]anull\[effects\];\[effects\]alimiter=[^;]+apad=whole_dur=9/,
  );
});

test("normalizeAssemblyInput keeps music quiet and records one source at offset zero", () => {
  const input = validInput();
  delete input.musicVolume;
  const normalized = normalizeAssemblyInput(input);

  assert.equal(AUDIO_MIX_REVISION, 7);
  assert.equal(DEFAULT_BACKGROUND_MUSIC_VOLUME, 0.10);
  assert.deepEqual(BACKGROUND_MUSIC_MIX, {
    mode: "continuous_overlay",
    ducking: false,
  });
  assert.equal(normalized.musicVolume, 0.10);
  assert.equal(normalized.totalDurationSeconds, 9);
  assert.equal(normalized.scenes.length, 1);
  assert.equal(normalized.scenes[0]?.startSeconds, 0);
  assert.deepEqual(normalized.scenes[0]?.foregroundAudio, {
    kind: "foley",
    path: "/media/foley.wav",
    volume: 0.9,
  });
});

test("normalizeAssemblyInput enforces exactly one integer-duration 4-12 second source", () => {
  assert.throws(
    () => normalizeAssemblyInput(validInput({ scenes: [] })),
    /Between 1 and 1 ordered scenes/,
  );
  assert.throws(
    () => normalizeAssemblyInput(validInput({
      scenes: [
        validInput().scenes[0]!,
        {
          videoPath: "/media/second.mp4",
          durationSeconds: 4,
          foleyStem: { path: "/media/second-foley.wav" },
        },
      ],
    })),
    /Between 1 and 1 ordered scenes/,
  );
  for (const durationSeconds of [3, 4.5, 13]) {
    assert.throws(
      () => normalizeAssemblyInput(validInput({
        scenes: [{
          videoPath: "/media/source.mp4",
          durationSeconds,
          foleyStem: { path: "/media/foley.wav" },
        }],
      })),
      /integer from 4 through 12/,
    );
  }
});

test("normalizeAssemblyInput requires exactly one logical foreground audio source", () => {
  assert.throws(
    () => normalizeAssemblyInput(validInput({
      scenes: [{
        videoPath: "/media/source.mp4",
        durationSeconds: 9,
      }],
    })),
    /requires exactly one foreground audio source/,
  );
  assert.throws(
    () => normalizeAssemblyInput(validInput({
      scenes: [{
        videoPath: "/media/source.mp4",
        durationSeconds: 9,
        foregroundAudio: { kind: "native" },
        foleyStem: { path: "/media/foley.wav" },
      }],
    })),
    /requires exactly one foreground audio source/,
  );
});

test("normalizeAssemblyInput accepts the explicit Foley foreground form", () => {
  const normalized = normalizeAssemblyInput(validInput({
    scenes: [{
      videoPath: "/media/source.mp4",
      durationSeconds: 9,
      foregroundAudio: {
        kind: "foley",
        path: "/media/explicit-foley.wav",
        volume: 0.75,
      },
    }],
  }));

  assert.deepEqual(normalized.scenes[0]?.foregroundAudio, {
    kind: "foley",
    path: "/media/explicit-foley.wav",
    volume: 0.75,
  });
});

test("assembleVideo validates a nine-second one-source render", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const readablePaths: string[] = [];
  const runProcess: ProcessRunner = async (executable, args) => {
    calls.push({ executable, args });
    return executable === "/deps/ffprobe"
      ? { stdout: validProbeJson(), stderr: "" }
      : { stdout: "", stderr: "" };
  };

  const result = await assembleVideo(validInput(), {
    ffmpegPath: "/deps/ffmpeg",
    ffprobePath: "/deps/ffprobe",
    runProcess,
    assertReadable: async (filePath) => {
      readablePaths.push(filePath);
    },
  });

  assert.deepEqual(calls.map(({ executable }) => executable), ["/deps/ffmpeg", "/deps/ffprobe"]);
  assert.deepEqual(readablePaths, [
    "/media/source.mp4",
    "/media/music.mp3",
    "/media/foley.wav",
    "/media/final.mp4",
  ]);
  assert.equal(result.durationSeconds, 9);
  assert.equal(result.videoCodec, "h264");
  assert.equal(result.audioCodec, "aac");
  assert.equal(result.audioSampleRate, 48_000);
});

test("assembleVideo validates the twelve-second boundary", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const runProcess: ProcessRunner = async (executable, args) => {
    calls.push({ executable, args });
    return executable === "/deps/ffprobe"
      ? { stdout: validProbeJson(12), stderr: "" }
      : { stdout: "", stderr: "" };
  };
  const input = validInput({
    scenes: [{
      videoPath: "/media/source.mp4",
      durationSeconds: 12,
      foleyStem: { path: "/media/foley.wav" },
    }],
  });

  const result = await assembleVideo(input, {
    ffmpegPath: "/deps/ffmpeg",
    ffprobePath: "/deps/ffprobe",
    runProcess,
    assertReadable: async () => {},
  });

  assert.equal(result.durationSeconds, 12);
  const ffmpegArgs = calls[0]?.args ?? [];
  assert.equal(ffmpegArgs[ffmpegArgs.indexOf("-t") + 1], "12.000");
});

test("real continuous-overlay assembly reaches EOF when music is shorter than Foley", {
  timeout: 20_000,
}, async (context) => {
  if (!ffmpegPath) {
    context.skip("ffmpeg-static is unavailable on this platform");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "continuous-overlay-eof-regression-"));
  const sourcePath = path.join(root, "source.mp4");
  const musicPath = path.join(root, "music.wav");
  const foleyPath = path.join(root, "foley.wav");
  const outputPath = path.join(root, "output.mp4");
  const setupRunner = createSpawnProcessRunner({ timeoutMs: 10_000 });
  try {
    // Exercise unequal source endpoints while the continuous layers are mixed.
    await Promise.all([
      setupRunner(ffmpegPath, [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-n",
        "-f", "lavfi", "-i", "color=c=navy:s=320x176:r=24:d=10",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", sourcePath,
      ]),
      setupRunner(ffmpegPath, [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-n",
        "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=9.938146",
        "-ac", "2", "-c:a", "pcm_s16le", musicPath,
      ]),
      setupRunner(ffmpegPath, [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-n",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=10",
        "-ac", "2", "-c:a", "pcm_s16le", foleyPath,
      ]),
    ]);

    const result = await assembleVideo({
      scenes: [{
        videoPath: sourcePath,
        durationSeconds: 10,
        foleyStem: { path: foleyPath, volume: 1 },
      }],
      musicPath,
      outputPath,
      musicVolume: 0.2,
      width: 320,
      height: 176,
      fps: 24,
    }, {
      ffmpegPath,
      runProcess: createSpawnProcessRunner({ timeoutMs: 5_000 }),
    });

    assert.equal(result.durationSeconds, 10);
    assert.equal(result.audioCodec, "aac");
    assert.ok((await stat(outputPath)).size > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real native-audio assembly renders both music-overlay and native-only outputs", {
  timeout: 20_000,
}, async (context) => {
  if (!ffmpegPath) {
    context.skip("ffmpeg-static is unavailable on this platform");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "native-audio-assembly-"));
  const sourcePath = path.join(root, "source-with-audio.mp4");
  const musicPath = path.join(root, "music.wav");
  const overlayOutputPath = path.join(root, "native-plus-music.mp4");
  const nativeOnlyOutputPath = path.join(root, "native-only.mp4");
  const setupRunner = createSpawnProcessRunner({ timeoutMs: 10_000 });
  try {
    await Promise.all([
      setupRunner(ffmpegPath, [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-n",
        "-f", "lavfi", "-i", "color=c=teal:s=320x176:r=24:d=4",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=4",
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", sourcePath,
      ]),
      setupRunner(ffmpegPath, [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-n",
        "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=4",
        "-ac", "2", "-c:a", "pcm_s16le", musicPath,
      ]),
    ]);

    const common = {
      scenes: [{
        videoPath: sourcePath,
        durationSeconds: 4,
        foregroundAudio: { kind: "native" as const },
      }],
      width: 320,
      height: 176,
      fps: 24,
    };
    const dependencies = {
      ffmpegPath,
      runProcess: createSpawnProcessRunner({ timeoutMs: 5_000 }),
    };
    const overlayResult = await assembleVideo({
      ...common,
      musicPath,
      musicVolume: 0.12,
      outputPath: overlayOutputPath,
    }, dependencies);
    const nativeOnlyResult = await assembleVideo({
      ...common,
      outputPath: nativeOnlyOutputPath,
    }, dependencies);

    assert.equal(overlayResult.durationSeconds, 4);
    assert.equal(nativeOnlyResult.durationSeconds, 4);
    assert.equal(overlayResult.audioSampleRate, 48_000);
    assert.equal(nativeOnlyResult.audioSampleRate, 48_000);
    assert.ok((await stat(overlayOutputPath)).size > 0);
    assert.ok((await stat(nativeOnlyOutputPath)).size > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assembleVideo rejects probe duration that does not match the source timeline", async () => {
  const runProcess: ProcessRunner = async (executable) => ({
    stdout: executable === "/deps/ffprobe" ? validProbeJson(8.4) : "",
    stderr: "",
  });

  await assert.rejects(
    assembleVideo(validInput(), {
      ffmpegPath: "/deps/ffmpeg",
      ffprobePath: "/deps/ffprobe",
      runProcess,
      assertReadable: async () => {},
    }),
    /Expected a 9s output/,
  );
});

test("assembleVideo rejects a technically invalid rendered file", async () => {
  const runProcess: ProcessRunner = async (executable) => ({
    stdout:
      executable === "/deps/ffprobe"
        ? JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 720, height: 1280, r_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
            ],
            format: { duration: "8.400000" },
          })
        : "",
    stderr: "",
  });

  await assert.rejects(
    assembleVideo(validInput(), {
      ffmpegPath: "/deps/ffmpeg",
      ffprobePath: "/deps/ffprobe",
      runProcess,
      assertReadable: async () => {},
    }),
    MediaAssemblyError,
  );
});

test("validateExistingAudio accepts one sufficiently long audio stream", async () => {
  const result = await validateExistingAudio({
    inputPath: "/media/music.wav",
    minimumDurationSeconds: 9,
  }, {
    ffprobePath: "/deps/ffprobe",
    assertReadable: async () => {},
    runProcess: async () => ({
      stdout: JSON.stringify({
        streams: [{ codec_type: "audio", codec_name: "pcm_s16le" }],
        format: { duration: "10.000000" },
      }),
      stderr: "",
    }),
  });

  assert.equal(result.durationSeconds, 10);
  assert.equal(result.codecName, "pcm_s16le");
});

test("validateExistingAudio rejects a malformed generic-content response", async () => {
  await assert.rejects(
    validateExistingAudio({
      inputPath: "/media/music.wav",
      minimumDurationSeconds: 9,
    }, {
      ffprobePath: "/deps/ffprobe",
      assertReadable: async () => {},
      runProcess: async () => ({
        stdout: JSON.stringify({ streams: [], format: {} }),
        stderr: "",
      }),
    }),
    /Expected one audio stream and no video streams/,
  );
});

test("the production process runner always uses shell:false", async () => {
  let observedOptions: Record<string, unknown> | undefined;
  const fakeSpawn = ((_command: string, _args: readonly string[], options: Record<string, unknown>) => {
    observedOptions = options;
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as unknown as typeof spawn;

  const run = createSpawnProcessRunner({ spawnImpl: fakeSpawn, timeoutMs: 1_000 });
  await run("/deps/ffmpeg", ["-version"]);

  assert.equal(observedOptions?.shell, false);
  assert.deepEqual(observedOptions?.stdio, ["ignore", "pipe", "pipe"]);
});
