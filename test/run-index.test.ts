import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashUserPrompt } from "freetier-deepagent-framework";
import { createLocalRunIndex, loadLocalRunIndex } from "../src/run-index.js";
import { LocalFrameworkDatabase, VideoRunStateStore } from "../src/state/index.js";

test("sequential identical prompts reuse one single-writer resumable run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-run-"));
  const prompt = "A cat drives a tiny car";
  try {
    const runs = [];
    for (let invocation = 0; invocation < 8; invocation += 1) {
      runs.push(await createLocalRunIndex(root, prompt));
    }
    assert.equal(new Set(runs.map(({ runId }) => runId)).size, 1);
    assert.equal(new Set(runs.map(({ runDirectory }) => runDirectory)).size, 1);
    assert.deepEqual(new Set(runs.map(({ promptHash }) => promptHash)), new Set([
      hashUserPrompt(prompt),
    ]));

    const current = runs.at(-1)!;
    const loaded = await loadLocalRunIndex(root, current.runId);
    assert.deepEqual(loaded, current);
    const state = new VideoRunStateStore(current.runDirectory);
    const manifest = await state.ensureManifest(prompt);
    assert.equal(manifest.promptHash, current.promptHash);
    assert.equal(state.runId(prompt), current.runId);
    await assert.rejects(access(path.join(current.runDirectory, ".run.lock")), /ENOENT/);

    const frameworkDatabase = new LocalFrameworkDatabase(
      current.runDirectory,
      current.promptHash,
    );
    const frameworkRun = await frameworkDatabase.createRun(
      current.promptHash,
      prompt,
      "single-writer-thread",
      "nvidia",
    );
    assert.equal(frameworkRun.prompt_hash, current.promptHash);
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
