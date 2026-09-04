import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashUserPrompt } from "freetier-deepagent-framework";
import { createLocalRunIndex, loadLocalRunIndex } from "../src/run-index.js";
import { LocalFrameworkDatabase, VideoRunStateStore } from "../src/state/index.js";

test("simultaneous identical prompts create isolated resumable run IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-run-"));
  const prompt = "A cat drives a tiny car";
  try {
    const runs = await Promise.all(Array.from(
      { length: 8 },
      async () => await createLocalRunIndex(root, prompt),
    ));
    assert.equal(new Set(runs.map(({ runId }) => runId)).size, runs.length);
    assert.equal(new Set(runs.map(({ runDirectory }) => runDirectory)).size, runs.length);
    assert.deepEqual(new Set(runs.map(({ promptHash }) => promptHash)), new Set([
      hashUserPrompt(prompt),
    ]));

    for (const created of runs) {
      const loaded = await loadLocalRunIndex(root, created.runId);
      assert.deepEqual(loaded, created);
      const state = new VideoRunStateStore(created.runDirectory);
      const manifest = await state.ensureManifest(prompt);
      assert.equal(manifest.promptHash, created.promptHash);
      assert.equal(state.runId(prompt), created.runId);
      await assert.rejects(access(path.join(created.runDirectory, ".run.lock")), /ENOENT/);
    }

    const frameworkDatabase = new LocalFrameworkDatabase(
      runs[0]!.runDirectory,
      runs[0]!.promptHash,
    );
    const frameworkRun = await frameworkDatabase.createRun(
      runs[0]!.promptHash,
      prompt,
      "isolated-thread",
      "nvidia",
    );
    assert.equal(frameworkRun.prompt_hash, runs[0]!.promptHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads a legacy prompt-hash run without a separate promptHash field", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-legacy-run-"));
  const prompt = "A lighthouse above stormy water";
  const runId = hashUserPrompt(prompt);
  const runDirectory = path.join(root, runId);
  const now = new Date().toISOString();
  try {
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "run.json"), `${JSON.stringify({
      schemaVersion: 2,
      runId,
      originalPrompt: prompt,
      runDirectory,
      createdAt: now,
      updatedAt: now,
    }, null, 2)}\n`);
    const loaded = await loadLocalRunIndex(root, runId);
    assert.equal(loaded.runId, runId);
    assert.equal(loaded.promptHash, runId);
    assert.equal(loaded.originalPrompt, prompt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
