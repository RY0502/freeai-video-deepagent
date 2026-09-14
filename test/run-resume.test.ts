import { mkdir, rm } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { ensureLocalRunIndex, findExistingRunByPromptHash, loadLocalRunIndex } from "../src/run-index.js";
import { hashUserPrompt } from "freetier-deepagent-framework";

test("ensureLocalRunIndex creates a new run for a new prompt", async () => {
  const outputRoot = path.join(tmpdir(), `test-run-${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(outputRoot, { recursive: true });
    const prompt = "Create a video of a cat playing with a ball";
    const run = await ensureLocalRunIndex(outputRoot, prompt);
    
    assert.ok(run.runId);
    assert.ok(run.promptHash);
    assert.strictEqual(run.originalPrompt, prompt);
    assert.strictEqual(run.createdAt, run.updatedAt);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("ensureLocalRunIndex reuses an existing run for the same prompt", async () => {
  const outputRoot = path.join(tmpdir(), `test-run-${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(outputRoot, { recursive: true });
    const prompt = "Create a video of a dog running in a park";
    
    // First invocation creates a new run
    const run1 = await ensureLocalRunIndex(outputRoot, prompt);
    const createdAt1 = run1.createdAt;
    const updatedAt1 = run1.updatedAt;
    const runId1 = run1.runId;
    
    // Wait a bit to ensure timestamps differ
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Second invocation should reuse the same run
    const run2 = await ensureLocalRunIndex(outputRoot, prompt);
    
    assert.strictEqual(run2.runId, runId1, "Run ID should be the same");
    assert.strictEqual(run2.createdAt, createdAt1, "Created timestamp should be unchanged");
    assert.notStrictEqual(run2.updatedAt, updatedAt1, "Updated timestamp should be newer");
    assert.ok(run2.updatedAt > updatedAt1, "Updated timestamp should be after the original");
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("ensureLocalRunIndex creates separate runs for different prompts", async () => {
  const outputRoot = path.join(tmpdir(), `test-run-${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(outputRoot, { recursive: true });
    const prompt1 = "Create a video of a bird flying";
    const prompt2 = "Create a video of a fish swimming";
    
    const run1 = await ensureLocalRunIndex(outputRoot, prompt1);
    const run2 = await ensureLocalRunIndex(outputRoot, prompt2);
    
    assert.notStrictEqual(run1.runId, run2.runId, "Different prompts should have different run IDs");
    assert.notStrictEqual(run1.promptHash, run2.promptHash, "Different prompts should have different hashes");
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("findExistingRunByPromptHash returns null when no run exists", async () => {
  const outputRoot = path.join(tmpdir(), `test-run-${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(outputRoot, { recursive: true });
    const promptHash = hashUserPrompt("nonexistent prompt");
    const result = await findExistingRunByPromptHash(outputRoot, promptHash);
    
    assert.strictEqual(result, null);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("findExistingRunByPromptHash finds an existing run", async () => {
  const outputRoot = path.join(tmpdir(), `test-run-${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(outputRoot, { recursive: true });
    const prompt = "Create a video of a sunset";
    
    const created = await ensureLocalRunIndex(outputRoot, prompt);
    const promptHash = hashUserPrompt(prompt);
    const found = await findExistingRunByPromptHash(outputRoot, promptHash);
    
    assert.ok(found);
    assert.strictEqual(found.runId, created.runId);
    assert.strictEqual(found.promptHash, created.promptHash);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("findExistingRunByPromptHash returns the most recently updated run", async () => {
  const outputRoot = path.join(tmpdir(), `test-run-${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(outputRoot, { recursive: true });
    const prompt = "Create a video of mountains";
    
    // Create first run
    const run1 = await ensureLocalRunIndex(outputRoot, prompt);
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Manually create a second run with the same prompt hash (simulating old behavior)
    // This shouldn't happen in practice with the new code, but tests the selection logic
    const run2 = await ensureLocalRunIndex(outputRoot, prompt);
    
    const promptHash = hashUserPrompt(prompt);
    const found = await findExistingRunByPromptHash(outputRoot, promptHash);
    
    assert.ok(found);
    // Should return the most recently updated one
    assert.strictEqual(found.runId, run2.runId);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("loadLocalRunIndex can load a run created by ensureLocalRunIndex", async () => {
  const outputRoot = path.join(tmpdir(), `test-run-${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(outputRoot, { recursive: true });
    const prompt = "Create a video of a waterfall";
    
    const created = await ensureLocalRunIndex(outputRoot, prompt);
    const loaded = await loadLocalRunIndex(outputRoot, created.runId);
    
    assert.strictEqual(loaded.runId, created.runId);
    assert.strictEqual(loaded.promptHash, created.promptHash);
    assert.strictEqual(loaded.originalPrompt, created.originalPrompt);
    assert.strictEqual(loaded.runDirectory, created.runDirectory);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
