import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MediaAssemblyError, type ProcessRunner } from "../src/media/assemble.js";
import {
  FOLEY_CUE_MAX_NORMALIZATION_GAIN_DB,
  FOLEY_CUE_MIN_USABLE_PEAK_DBFS,
  FOLEY_TRANSIENT_ONSET_TRIM_FILTER,
  analyzeFoleyCueAudio,
  buildFoleyStemArgs,
  buildFoleyStemFilterGraph,
  normalizeFoleyStemInput,
  renderFoleyStem,
} from "../src/media/foley.js";

test("builds sample-exact cue delays over the continuous render timeline", () => {
  const args = buildFoleyStemArgs({
    sceneDurationSeconds: 9,
    cues: [
      {
        path: "/audio/bat-hit.mp3",
        atSeconds: 1,
        durationSeconds: 0.5,
        volume: 1.2,
        spatialPosition: "left",
      },
      {
        path: "/audio/crowd-roar.mp3",
        atSeconds: 6.25,
        durationSeconds: 1.5,
        volume: 0.8,
        spatialPosition: "moving",
        continuous: true,
      },
    ],
    outputPath: "/audio/scene-foley.wav",
  });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.ok(graph);

  assert.equal(args.filter((argument) => argument === "-i").length, 2);
  assert.match(graph, /anullsrc=r=48000:cl=stereo/);
  assert.match(graph, /atrim=start_sample=0:end_sample=432000/);
  assert.match(graph, /apad=whole_len=24000/);
  assert.equal(graph.match(/silenceremove=/g)?.length, 1);
  assert.match(
    graph,
    /\[0:a:0\]aresample=48000,[^;]*silenceremove=[^,]+,[^;]*atrim=start_sample=0:end_sample=24000,asetpts=N\/SR\/TB,volume=0\.000dB,stereotools=balance_out=-0\.65:bmode_out=power,afade=t=out:st=0\.440:d=0\.060:curve=tri,volume=1\.200,adelay=48000S:all=1\[cue0\]/,
  );
  assert.match(graph, /adelay=48000S:all=1\[cue0\]/);
  assert.match(graph, /apad=whole_len=72000/);
  assert.match(
    graph,
    /\[1:a:0\]aresample=48000,[^;]*atrim=start_sample=0:end_sample=72000,asetpts=N\/SR\/TB,volume=0\.000dB,apulsator=[^,]+,afade=t=in:st=0:d=0\.080:curve=tri,afade=t=out:st=1\.420:d=0\.080:curve=tri,volume=0\.800,adelay=300000S:all=1\[cue1\]/,
  );
  const continuousChain = graph.match(/\[1:a:0\]([^;]+)\[cue1\]/)?.[1] ?? "";
  assert.doesNotMatch(continuousChain, /silenceremove=/);
  assert.match(graph, new RegExp(FOLEY_TRANSIENT_ONSET_TRIM_FILTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(graph, /adelay=300000S:all=1\[cue1\]/);
  assert.doesNotMatch(graph, /loudnorm=/);
  assert.equal(graph.match(/aresample=48000/g)?.length, 2);
  assert.match(graph, /amix=inputs=3:duration=first:dropout_transition=0:normalize=0/);
  assert.equal(args[args.indexOf("-c:a") + 1], "pcm_s16le");
  assert.equal(args[args.indexOf("-ar") + 1], "48000");
  assert.equal(args[args.indexOf("-ac") + 1], "2");
  assert.equal(args[args.indexOf("-t") + 1], "9.000");
  assert.equal(args.at(-1), "/audio/scene-foley.wav");
});

test("zero cues produces exact digital silence for a maximum-length render", () => {
  const input = {
    sceneDurationSeconds: 12,
    cues: [],
    outputPath: "/audio/silent-scene.wav",
  };
  const args = buildFoleyStemArgs(input);
  const graph = buildFoleyStemFilterGraph(input);

  assert.equal(args.filter((argument) => argument === "-i").length, 0);
  assert.match(graph, /anullsrc=r=48000:cl=stereo/);
  assert.match(graph, /end_sample=576000/);
  assert.match(graph, /\[silence\]anull\[foley\]/);
  assert.doesNotMatch(graph, /amix=/);
  assert.doesNotMatch(graph, /loudnorm=/);
  assert.equal(args[args.indexOf("-t") + 1], "12.000");
});

test("rejects durations outside 4-12 seconds, out-of-window cues, and unsafe gains", () => {
  assert.throws(
    () => normalizeFoleyStemInput({
      sceneDurationSeconds: 3,
      cues: [],
      outputPath: "/audio/out.wav",
    }),
    /integer from 4 through 12/,
  );
  assert.throws(
    () => normalizeFoleyStemInput({
      sceneDurationSeconds: 13,
      cues: [],
      outputPath: "/audio/out.wav",
    }),
    /integer from 4 through 12/,
  );
  assert.throws(
    () => normalizeFoleyStemInput({
      sceneDurationSeconds: 4,
      cues: [{ path: "/audio/hit.mp3", atSeconds: 3.75, durationSeconds: 0.5 }],
      outputPath: "/audio/out.wav",
    }),
    /end by the end of the scene/,
  );
  assert.throws(
    () => normalizeFoleyStemInput({
      sceneDurationSeconds: 4,
      cues: [{ path: "/audio/hit.mp3", atSeconds: 1, durationSeconds: 0.5, volume: 4.1 }],
      outputPath: "/audio/out.wav",
    }),
    MediaAssemblyError,
  );
});

test("render checks cue inputs and atomically publishes the FFmpeg WAV", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "foley-composer-"));
  try {
    const cuePath = path.join(directory, "cue.mp3");
    const outputPath = path.join(directory, "nested", "stem.wav");
    await writeFile(cuePath, "cue-bytes");
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const readable: string[] = [];
    const runProcess: ProcessRunner = async (executable, args) => {
      calls.push({ executable, args });
      await writeFile(String(args.at(-1)), "rendered-wav");
      return { stdout: "", stderr: "" };
    };

    const result = await renderFoleyStem({
      sceneDurationSeconds: 4,
      cues: [{ path: cuePath, atSeconds: 1, durationSeconds: 0.5 }],
      outputPath,
    }, {
      ffmpegPath: "/deps/ffmpeg",
      runProcess,
      assertReadable: async (filePath) => { readable.push(filePath); },
      analyzeCue: async () => ({
        usable: true,
        meanVolumeDbfs: -27,
        maxVolumeDbfs: -8,
        normalizationGainDb: 5,
      }),
    });

    assert.deepEqual(readable, [cuePath]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.executable, "/deps/ffmpeg");
    assert.match(String(calls[0]?.args.at(-1)), /stem\.wav\.part-[0-9a-f-]+\.wav$/);
    assert.equal(await readFile(outputPath, "utf8"), "rendered-wav");
    assert.deepEqual(await readdir(path.dirname(outputPath)), ["stem.wav"]);
    assert.deepEqual(result, {
      outputPath,
      durationSeconds: 4,
      cueCount: 1,
      inputCueCount: 1,
      omittedCueCount: 0,
      sampleRate: 48_000,
      channels: 2,
      codec: "pcm_s16le",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("analyzes cue loudness with capped gain and identifies effectively silent provider output", async () => {
  const measured = await analyzeFoleyCueAudio(
    "/audio/quiet-effect.mp3",
    "/deps/ffmpeg",
    async () => ({
      stdout: "",
      stderr: "[Parsed_volumedetect] mean_volume: -38.0 dB\n[Parsed_volumedetect] max_volume: -29.8 dB",
    }),
  );
  assert.deepEqual(measured, {
    usable: true,
    meanVolumeDbfs: -38,
    maxVolumeDbfs: -29.8,
    normalizationGainDb: FOLEY_CUE_MAX_NORMALIZATION_GAIN_DB,
  });

  const lowEnergyNoise = await analyzeFoleyCueAudio(
    "/audio/low-energy-noise.mp3",
    "/deps/ffmpeg",
    async () => ({
      stdout: "",
      stderr: "[Parsed_volumedetect] mean_volume: -46.3 dB\n[Parsed_volumedetect] max_volume: -29.8 dB",
    }),
  );
  assert.equal(lowEnergyNoise.usable, false);
  assert.match(lowEnergyNoise.reason ?? "", /effectively silent/);

  const silent = await analyzeFoleyCueAudio(
    "/audio/silence.mp3",
    "/deps/ffmpeg",
    async () => ({
      stdout: "",
      stderr: "[Parsed_volumedetect] mean_volume: -70.0 dB\n"
        + `[Parsed_volumedetect] max_volume: ${FOLEY_CUE_MIN_USABLE_PEAK_DBFS.toFixed(1)} dB`,
    }),
  );
  assert.equal(silent.usable, false);
  assert.equal(silent.normalizationGainDb, 0);
  assert.match(silent.reason ?? "", /effectively silent/);
});

test("omits an effectively silent cue instead of amplifying it into the mix", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "foley-composer-omit-"));
  try {
    const usablePath = path.join(directory, "usable.mp3");
    const silentPath = path.join(directory, "silent.mp3");
    const outputPath = path.join(directory, "stem.wav");
    await Promise.all([writeFile(usablePath, "usable"), writeFile(silentPath, "silent")]);
    let renderGraph = "";
    const result = await renderFoleyStem({
      sceneDurationSeconds: 4,
      cues: [
        { path: usablePath, atSeconds: 0.5, durationSeconds: 0.65 },
        { path: silentPath, atSeconds: 1.5, durationSeconds: 0.65 },
      ],
      outputPath,
    }, {
      ffmpegPath: "/deps/ffmpeg",
      analyzeCue: async (filePath) => filePath === usablePath
        ? { usable: true, meanVolumeDbfs: -28, maxVolumeDbfs: -10, normalizationGainDb: 8 }
        : {
            usable: false,
            meanVolumeDbfs: -70,
            maxVolumeDbfs: -50,
            normalizationGainDb: 0,
            reason: "effectively silent",
          },
      runProcess: async (_executable, args) => {
        renderGraph = String(args[args.indexOf("-filter_complex") + 1]);
        await writeFile(String(args.at(-1)), "rendered");
        return { stdout: "", stderr: "" };
      },
    });

    assert.equal(result.inputCueCount, 2);
    assert.equal(result.cueCount, 1);
    assert.equal(result.omittedCueCount, 1);
    assert.match(renderGraph, /volume=8\.000dB/);
    assert.doesNotMatch(renderGraph, /\[1:a:0\]/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("render removes a partial WAV when FFmpeg fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "foley-composer-failure-"));
  try {
    const outputPath = path.join(directory, "stem.wav");
    const runProcess: ProcessRunner = async (_executable, args) => {
      await writeFile(String(args.at(-1)), "partial");
      throw new Error("render failed");
    };

    await assert.rejects(
      renderFoleyStem({ sceneDurationSeconds: 4, cues: [], outputPath }, {
        ffmpegPath: "/deps/ffmpeg",
        runProcess,
      }),
      /render failed/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
