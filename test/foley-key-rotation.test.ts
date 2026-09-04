import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ElevenLabsClient, type ElevenLabsFetch } from "../src/elevenlabs/index.js";

test("Foley rotates the numbered ElevenLabs pool only after definite key exhaustion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "foley-rotation-"));
  const outputPath = path.join(directory, "effect.mp3");
  const attempts: string[] = [];
  const labels: string[] = [];
  const fetch: ElevenLabsFetch = async (_input, init) => {
    const key = String((init?.headers as Record<string, string> | undefined)?.["xi-api-key"]);
    attempts.push(key);
    if (key === "eleven-one") {
      return new Response(JSON.stringify({
        detail: { code: "quota_exceeded", message: "Daily credits exhausted" },
      }), { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response(Buffer.from("audio-bytes"), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  };
  try {
    const client = new ElevenLabsClient({
      apiKeys: ["eleven-one", "eleven-two"],
      fetch,
    });
    const result = await client.generateSoundEffect({
      text: "One isolated wooden bat impact, no music.",
      durationSeconds: 0.5,
      outputPath,
      onAttempt: ({ keyLabel }) => labels.push(keyLabel),
    });
    assert.deepEqual(attempts, ["eleven-one", "eleven-two"]);
    assert.deepEqual(labels, ["key-1", "key-2"]);
    assert.equal(result.keyLabel, "key-2");
    assert.equal(await readFile(outputPath, "utf8"), "audio-bytes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Foley does not rotate on an ambiguous provider failure", async () => {
  let calls = 0;
  const client = new ElevenLabsClient({
    apiKeys: ["eleven-one", "eleven-two"],
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "temporary backend failure" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await assert.rejects(client.generateSoundEffect({
    text: "A clean isolated impact.",
    durationSeconds: 1,
    outputPath: path.join(tmpdir(), `unused-${process.pid}.mp3`),
  }));
  assert.equal(calls, 1);
});
