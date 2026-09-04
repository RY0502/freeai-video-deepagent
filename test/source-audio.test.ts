import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import ffprobeStaticModule from "@derhuerst/ffprobe-static";
import ffmpegStaticModule from "ffmpeg-static";

import {
  SOURCE_AUDIO_INSPECTION_REVISION,
  SOURCE_AUDIO_MIN_ACTIVE_SECONDS,
  SOURCE_AUDIO_MIN_MEAN_DBFS,
  SOURCE_AUDIO_MIN_PEAK_DBFS,
  SOURCE_AUDIO_SILENCE_THRESHOLD_DBFS,
  createSpawnProcessRunner,
  inspectSourceAudio,
  loadReusableSourceAudioInspection,
  parseSourceAudioAnalysisLog,
  type ProcessRunner,
} from "../src/media/index.js";
import { sha256File } from "../src/utils/files.js";

const ffmpegPath = ffmpegStaticModule as unknown as string | null;
const ffprobePath = ffprobeStaticModule as unknown as string | null;
const SOURCE_SHA = "a".repeat(64);

function probeJson(stream = true): string {
  return JSON.stringify({
    streams: stream
      ? [{
          codec_type: "audio",
          codec_name: "aac",
          sample_rate: "48000",
          channels: 2,
          duration: "6.000000",
        }]
      : [],
  });
}

function volumeLog(input: {
  mean: string | number;
  peak: string | number;
  silence?: string;
}): string {
  return [
    input.silence ?? "",
    `[Parsed_volumedetect_2] mean_volume: ${input.mean} dB`,
    `[Parsed_volumedetect_2] max_volume: ${input.peak} dB`,
  ].filter(Boolean).join("\n");
}

test("source audio inspection durably classifies a video without an audio stream", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "source-audio-no-stream-"));
  const outputPath = path.join(root, "analysis", "source-audio.json");
  const calls: string[] = [];
  const runProcess: ProcessRunner = async (executable) => {
    calls.push(executable);
    return { stdout: probeJson(false), stderr: "" };
  };
  try {
    const document = await inspectSourceAudio({
      sourceVideoPath: path.join(root, "source.mp4"),
      sourceVideoSha256: SOURCE_SHA,
      durationSeconds: 6,
      outputPath,
    }, {
      ffprobePath: "/deps/ffprobe",
      ffmpegPath: "/deps/ffmpeg",
      runProcess,
      assertReadable: async () => {},
    });

    assert.deepEqual(calls, ["/deps/ffprobe"]);
    assert.equal(document.schemaVersion, 2);
    assert.equal(document.inspectionRevision, SOURCE_AUDIO_INSPECTION_REVISION);
    assert.equal(document.audioStream, null);
    assert.equal(document.usable, false);
    assert.equal(document.activeDurationSeconds, 0);
    assert.equal(document.silentDurationSeconds, 6);
    assert.match(document.reason, /no embedded audio stream/i);
    assert.deepEqual(
      JSON.parse(await readFile(outputPath, "utf8")),
      document,
    );

    const fileSha256 = await sha256File(outputPath);
    assert.deepEqual(await loadReusableSourceAudioInspection({
      filePath: outputPath,
      expectedFileSha256: fileSha256,
      sourceVideoSha256: SOURCE_SHA,
      durationSeconds: 6,
    }), document);
    assert.equal(await loadReusableSourceAudioInspection({
      filePath: outputPath,
      expectedFileSha256: fileSha256,
      sourceVideoSha256: "b".repeat(64),
      durationSeconds: 6,
    }), null);
    assert.equal(await loadReusableSourceAudioInspection({
      filePath: outputPath,
      expectedFileSha256: fileSha256,
      sourceVideoSha256: SOURCE_SHA,
      durationSeconds: 7,
    }), null);
    assert.equal(await loadReusableSourceAudioInspection({
      filePath: outputPath,
      expectedFileSha256: "c".repeat(64),
      sourceVideoSha256: SOURCE_SHA,
      durationSeconds: 6,
    }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source audio inspection measures silence intervals and accepts meaningful signal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "source-audio-meaningful-"));
  const outputPath = path.join(root, "source-audio.json");
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const runProcess: ProcessRunner = async (executable, args) => {
    calls.push({ executable, args });
    if (executable === "/deps/ffprobe") return { stdout: probeJson(), stderr: "" };
    return {
      stdout: "",
      stderr: volumeLog({
        mean: -24.5,
        peak: -2.1,
        silence: [
          "[silencedetect] silence_start: 0",
          "[silencedetect] silence_end: 1 | silence_duration: 1",
          "[silencedetect] silence_start: 5.5",
          "[silencedetect] silence_end: 6 | silence_duration: 0.5",
        ].join("\n"),
      }),
    };
  };
  try {
    const document = await inspectSourceAudio({
      sourceVideoPath: path.join(root, "source.mp4"),
      sourceVideoSha256: SOURCE_SHA,
      durationSeconds: 6,
      outputPath,
    }, {
      ffprobePath: "/deps/ffprobe",
      ffmpegPath: "/deps/ffmpeg",
      runProcess,
      assertReadable: async () => {},
    });

    assert.equal(document.usable, true);
    assert.equal(document.peakVolumeDbfs, -2.1);
    assert.equal(document.meanVolumeDbfs, -24.5);
    assert.equal(document.silentDurationSeconds, 1.5);
    assert.equal(document.activeDurationSeconds, 4.5);
    assert.equal(document.audioStream?.codecName, "aac");
    assert.equal(document.audioStream?.sampleRate, 48_000);
    assert.equal(document.audioStream?.channels, 2);
    assert.equal(calls.length, 2);
    const analysisArgs = calls[1]?.args.join(" ") ?? "";
    assert.match(analysisArgs, /-map 0:a:0/);
    assert.match(analysisArgs, /apad=whole_dur=6\.000/);
    assert.match(analysisArgs, /silencedetect=noise=-50dB:d=0\.1/);
    assert.match(analysisArgs, /volumedetect/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analysis log parsing merges silence and closes a trailing interval at EOF", () => {
  const parsed = parseSourceAudioAnalysisLog(volumeLog({
    mean: -20,
    peak: -1,
    silence: [
      "silence_start: -0.5",
      "silence_end: 1.25 | silence_duration: 1.75",
      "silence_start: 1",
      "silence_end: 2",
      "silence_start: 5.75",
    ].join("\n"),
  }), 6);

  assert.equal(parsed.silentDurationSeconds, 2.25);
  assert.equal(parsed.activeDurationSeconds, 3.75);
  assert.equal(parsed.peakVolumeDbfs, -1);
  assert.equal(parsed.meanVolumeDbfs, -20);
});

test("source audio thresholds are strict and require at least 0.12 active seconds", async () => {
  assert.equal(SOURCE_AUDIO_MIN_PEAK_DBFS, -45);
  assert.equal(SOURCE_AUDIO_MIN_MEAN_DBFS, -60);
  assert.equal(SOURCE_AUDIO_MIN_ACTIVE_SECONDS, 0.12);
  assert.equal(SOURCE_AUDIO_SILENCE_THRESHOLD_DBFS, -50);

  const cases = [
    { name: "peak equality", mean: -20, peak: -45, silenceEnd: 3, usable: false },
    { name: "mean equality", mean: -60, peak: -2, silenceEnd: 3, usable: false },
    { name: "too little active signal", mean: -20, peak: -2, silenceEnd: 3.881, usable: false },
    { name: "minimum active signal", mean: -20, peak: -2, silenceEnd: 3.88, usable: true },
    { name: "digital silence", mean: "-inf", peak: "-inf", silenceEnd: 4, usable: false },
  ] as const;

  for (const current of cases) {
    const root = await mkdtemp(path.join(tmpdir(), `source-audio-${current.name.replaceAll(" ", "-")}-`));
    try {
      const document = await inspectSourceAudio({
        sourceVideoPath: path.join(root, "source.mp4"),
        sourceVideoSha256: SOURCE_SHA,
        durationSeconds: 4,
        outputPath: path.join(root, "analysis.json"),
      }, {
        ffprobePath: "/deps/ffprobe",
        ffmpegPath: "/deps/ffmpeg",
        assertReadable: async () => {},
        runProcess: async (executable) => executable === "/deps/ffprobe"
          ? { stdout: probeJson(), stderr: "" }
          : {
              stdout: "",
              stderr: volumeLog({
                mean: current.mean,
                peak: current.peak,
                silence: `silence_start: 0\nsilence_end: ${current.silenceEnd}`,
              }),
            },
      });
      assert.equal(document.usable, current.usable, current.name);
      if (current.name === "digital silence") {
        assert.equal(document.peakVolumeDbfs, null);
        assert.equal(document.meanVolumeDbfs, null);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("source audio inspection propagates probe, decode, and malformed-log failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "source-audio-errors-"));
  const common = {
    sourceVideoPath: path.join(root, "source.mp4"),
    sourceVideoSha256: SOURCE_SHA,
    durationSeconds: 6,
    outputPath: path.join(root, "analysis.json"),
  } as const;
  try {
    await assert.rejects(inspectSourceAudio(common, {
      ffprobePath: "/deps/ffprobe",
      ffmpegPath: "/deps/ffmpeg",
      assertReadable: async () => {},
      runProcess: async () => { throw new Error("probe failed"); },
    }), /probe failed/);

    await assert.rejects(inspectSourceAudio(common, {
      ffprobePath: "/deps/ffprobe",
      ffmpegPath: "/deps/ffmpeg",
      assertReadable: async () => {},
      runProcess: async (executable) => {
        if (executable === "/deps/ffprobe") return { stdout: probeJson(), stderr: "" };
        throw new Error("decoder failed");
      },
    }), /decoder failed/);

    await assert.rejects(inspectSourceAudio(common, {
      ffprobePath: "/deps/ffprobe",
      ffmpegPath: "/deps/ffmpeg",
      assertReadable: async () => {},
      runProcess: async (executable) => executable === "/deps/ffprobe"
        ? { stdout: probeJson(), stderr: "" }
        : { stdout: "", stderr: "no volume filters here" },
    }), /did not report max volume/i);
    await assert.rejects(access(common.outputPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled FFmpeg classifies no-stream, silent, and sparse source audio", {
  timeout: 30_000,
}, async (context) => {
  if (!ffmpegPath || !ffprobePath) {
    context.skip("Bundled FFmpeg/FFprobe binaries are unavailable on this platform.");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "source-audio-real-"));
  const noAudioPath = path.join(root, "no-audio.mp4");
  const silentPath = path.join(root, "silent.mp4");
  const sparsePath = path.join(root, "sparse.mp4");
  const runner = createSpawnProcessRunner({ timeoutMs: 10_000 });
  try {
    await runner(ffmpegPath, [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=160x90:r=12:d=4",
      "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "4", noAudioPath,
    ]);
    await runner(ffmpegPath, [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=160x90:r=12:d=4",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=4",
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-t", "4", silentPath,
    ]);
    await runner(ffmpegPath, [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=160x90:r=12:d=4",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=0.2",
      "-filter_complex", "[1:a:0]adelay=1000:all=1,apad=whole_dur=4,atrim=duration=4[audio]",
      "-map", "0:v:0", "-map", "[audio]", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-t", "4", sparsePath,
    ]);

    const documents = await Promise.all([noAudioPath, silentPath, sparsePath].map(async (sourceVideoPath, index) =>
      await inspectSourceAudio({
        sourceVideoPath,
        sourceVideoSha256: await sha256File(sourceVideoPath),
        durationSeconds: 4,
        outputPath: path.join(root, `analysis-${index}.json`),
      }, { timeoutMs: 10_000 }),
    ));

    assert.equal(documents[0]?.audioStream, null);
    assert.equal(documents[0]?.usable, false);
    assert.notEqual(documents[1]?.audioStream, null);
    assert.equal(documents[1]?.usable, false);
    assert.equal(documents[2]?.usable, true);
    assert.ok((documents[2]?.activeDurationSeconds ?? 0) >= 0.12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
