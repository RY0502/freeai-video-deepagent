import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import ffmpegStaticModule from "ffmpeg-static";

import {
  AUDIO_SAMPLE_RATE,
  assembleVideo,
  createSpawnProcessRunner,
} from "../src/media/index.js";

const ffmpegPath = ffmpegStaticModule as unknown as string | null;

async function synthesizeVideo(
  runProcess: ReturnType<typeof createSpawnProcessRunner>,
  color: string,
  outputPath: string,
): Promise<void> {
  assert.ok(ffmpegPath, "ffmpeg-static has no binary for this platform");
  await runProcess(ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-n",
    "-f",
    "lavfi",
    "-i",
    "color=c=" + color + ":s=320x568:r=24:d=4",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

async function synthesizeTone(
  runProcess: ReturnType<typeof createSpawnProcessRunner>,
  frequency: number,
  durationSeconds: number,
  outputPath: string,
): Promise<void> {
  assert.ok(ffmpegPath, "ffmpeg-static has no binary for this platform");
  await runProcess(ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-n",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=" +
      frequency +
      ":sample_rate=" +
      AUDIO_SAMPLE_RATE +
      ":duration=" +
      durationSeconds,
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ]);
}

async function main(): Promise<void> {
  assert.ok(ffmpegPath, "ffmpeg-static has no binary for this platform");

  const workDirectory = await mkdtemp(path.join(tmpdir(), "agnes-video-media-smoke-"));
  const runProcess = createSpawnProcessRunner({ timeoutMs: 60_000 });
  const sourceVideoPath = path.join(workDirectory, "source.mp4");
  const musicPath = path.join(workDirectory, "music.wav");
  const foleyPath = path.join(workDirectory, "foley.wav");
  const outputPath = path.join(workDirectory, "assembled.mp4");

  try {
    await Promise.all([
      synthesizeVideo(runProcess, "red", sourceVideoPath),
      synthesizeTone(runProcess, 220, 4, musicPath),
      synthesizeTone(runProcess, 440, 4, foleyPath),
    ]);

    const result = await assembleVideo(
      {
        scenes: [{
          videoPath: sourceVideoPath,
          durationSeconds: 4,
          foleyStem: { path: foleyPath, volume: 0.35 },
        }],
        musicPath,
        outputPath,
        musicVolume: 0.25,
        width: 320,
        height: 568,
        fps: 24,
      },
      {
        ffmpegPath,
        runProcess,
      },
    );

    assert.equal(result.durationSeconds.toFixed(3), "4.000");
    assert.equal(result.videoCodec, "h264");
    assert.equal(result.audioCodec, "aac");
    assert.equal(result.audioSampleRate, AUDIO_SAMPLE_RATE);
    assert.equal(result.audioChannels, 2);
    assert.equal(result.width, 320);
    assert.equal(result.height, 568);
    assert.equal(result.fps, 24);
    assert.ok((await stat(outputPath)).size > 0, "assembled output is empty");

    console.log(
      "Media smoke passed: " +
        result.durationSeconds.toFixed(3) +
        "s H.264/AAC, " +
        result.audioSampleRate +
        "Hz stereo, " +
        result.width +
        "x" +
        result.height +
        "@" +
        result.fps +
        "fps",
    );
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

await main();
