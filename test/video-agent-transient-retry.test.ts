import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { hashUserPrompt } from "freetier-deepagent-framework";
import { z } from "zod";

import { VideoPlanningAttemptsExhaustedError } from "../src/agent/deepAgentCompatibility.js";
import {
  createVideoAgentRunner,
  isRetryablePlanningProviderError,
  VideoAgentUnsafePlanningRetryError,
} from "../src/agent/videoAgentRunner.js";
import { LocalFrameworkDatabase } from "../src/state/localFrameworkDatabase.js";
import { VideoRunStateStore } from "../src/state/videoRunState.js";

interface ModelInvocationTracker {
  count: number;
}

function failingHttpModel(
  tracker: ModelInvocationTracker,
  status: number,
  message: string,
): FakeStreamingChatModel {
  const model = new FakeStreamingChatModel({ sleep: 0 });
  const instrumented = model as unknown as {
    bindTools: (...args: unknown[]) => FakeStreamingChatModel;
    _generate: (...args: unknown[]) => Promise<never>;
    _streamResponseChunks: (...args: unknown[]) => AsyncGenerator<never>;
  };

  // The production failure happens in a bound model. Keep one shared instance
  // so retries can be counted even though createDeepAgent binds tools each run.
  instrumented.bindTools = () => model;
  const fail = (): never => {
    tracker.count += 1;
    const error = Object.assign(new Error(message), {
      status,
      code: status >= 500 ? "internal_server_error" : "invalid_request_error",
    });
    throw error;
  };
  instrumented._generate = async () => fail();
  instrumented._streamResponseChunks = async function* () {
    fail();
  };
  return model;
}

function transientHttp500Model(tracker: ModelInvocationTracker): FakeStreamingChatModel {
  return failingHttpModel(tracker, 500, "500 Internal server error");
}

function planningBudgetFailureModel(
  tracker: ModelInvocationTracker,
): FakeStreamingChatModel {
  const model = new FakeStreamingChatModel({ sleep: 0 });
  const instrumented = model as unknown as {
    bindTools: (...args: unknown[]) => FakeStreamingChatModel;
    _generate: (...args: unknown[]) => Promise<never>;
    _streamResponseChunks: (...args: unknown[]) => AsyncGenerator<never>;
  };
  instrumented.bindTools = () => model;
  const fail = (): never => {
    tracker.count += 1;
    throw Object.assign(
      new Error("500 Internal server error", {
        cause: new VideoPlanningAttemptsExhaustedError(3),
      }),
      { status: 500 },
    );
  };
  instrumented._generate = async () => fail();
  instrumented._streamResponseChunks = async function* () {
    fail();
  };
  return model;
}

function testTool(
  name: string,
  status: string,
  calls?: string[],
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name,
    description: `Test-only ${name} tool.`,
    schema: z.object({}).strict(),
    func: async () => {
      calls?.push(name);
      return JSON.stringify({ status });
    },
  }) as unknown as DynamicStructuredTool;
}

test("classifies only genuine transient planning-provider failures", () => {
  assert.equal(isRetryablePlanningProviderError(
    Object.assign(new Error("provider request failed"), { status: 503 }),
  ), true);
  assert.equal(isRetryablePlanningProviderError(
    new Error("middleware failed", {
      cause: Object.assign(new Error("upstream failed"), { statusCode: 500 }),
    }),
  ), true);
  assert.equal(isRetryablePlanningProviderError(new Error("500 Internal server error")), true);
  assert.equal(isRetryablePlanningProviderError(new Error("fetch failed")), true);
  assert.equal(isRetryablePlanningProviderError(
    Object.assign(
      new Error("500 Internal server error", {
        cause: new VideoPlanningAttemptsExhaustedError(3),
      }),
      { status: 500 },
    ),
  ), false, "the local draft circuit must win over an outer transient marker");

  assert.equal(isRetryablePlanningProviderError(
    new SyntaxError("Expected ',' or '}' after property value at position 500123"),
  ), false);
  assert.equal(isRetryablePlanningProviderError(
    Object.assign(new Error("invalid tool schema"), { status: 400 }),
  ), false);
  assert.equal(isRetryablePlanningProviderError(
    Object.assign(new Error("rate limited"), { status: 429 }),
  ), false, "quota rotation remains owned by the framework");
  assert.equal(isRetryablePlanningProviderError(
    Object.assign(new Error("service unavailable while rate limited"), { status: 429 }),
  ), false, "an explicit quota status must override ambiguous provider prose");
});

test("retryable-failure reopen is compare-and-set guarded and clears only agent graph state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-transient-cas-"));
  const prompt = "Create a twelve-second animation of a lighthouse.";
  const promptHash = hashUserPrompt(prompt);
  const database = new LocalFrameworkDatabase(root, promptHash);
  const threadId = `run-${promptHash.slice(0, 16)}`;

  try {
    await database.createRun(promptHash, prompt, threadId, "nvidia");
    await database.replaceTodos(promptHash, [{ content: "Create plan", status: "in_progress" }]);
    await database.saveCheckpoint(threadId, "checkpoint-1", { state: "old" }, {});
    await database.saveCheckpointWrite(threadId, "", "checkpoint-1", "task-1", 0, "messages", {});
    await database.updateRunStatus(promptHash, "failed", "500 Internal server error");
    const firstFailure = await database.getRun(promptHash);
    assert.ok(firstFailure);

    assert.equal(await database.reopenRetryableFailure(
      promptHash,
      "different error",
      firstFailure.updated_at,
      "stale caller",
    ), false);
    assert.equal((await database.getRun(promptHash))?.status, "failed");
    assert.equal((await database.getTodos(promptHash)).length, 1);
    assert.ok(await database.getLatestCheckpoint(threadId));

    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    await database.updateRunStatus(promptHash, "failed", "500 Internal server error");
    const newerFailure = await database.getRun(promptHash);
    assert.ok(newerFailure);
    assert.notEqual(newerFailure.updated_at, firstFailure.updated_at);
    assert.equal(await database.reopenRetryableFailure(
      promptHash,
      "500 Internal server error",
      firstFailure.updated_at,
      "stale failure generation",
    ), false);

    assert.equal(await database.reopenRetryableFailure(
      promptHash,
      "500 Internal server error",
      newerFailure.updated_at,
      "bounded planning retry",
    ), true);
    assert.equal((await database.getRun(promptHash))?.status, "in_progress");
    assert.equal((await database.getRun(promptHash))?.current_provider, "nvidia");
    assert.equal((await database.getTodos(promptHash)).length, 0);
    assert.equal(await database.getLatestCheckpoint(threadId), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds transient planning HTTP 500 retries without submitting media", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-transient-500-"));
  const prompt = "Create a twelve-second animated story about a brave chicken.";
  const promptHash = hashUserPrompt(prompt);
  const runDirectory = path.join(root, promptHash);
  const state = new VideoRunStateStore(runDirectory);
  const frameworkDatabase = new LocalFrameworkDatabase(runDirectory, promptHash);
  const tracker = { count: 0 };
  let mediaCalls = 0;
  const unexpectedMediaTool = (name: string): DynamicStructuredTool => new DynamicStructuredTool({
    name,
    description: `Test-only ${name} tool.`,
    schema: z.object({}).strict(),
    func: async () => {
      mediaCalls += 1;
      return JSON.stringify({ status: "unexpected" });
    },
  }) as unknown as DynamicStructuredTool;

  try {
    await state.ensureManifest(prompt);
    const runner = createVideoAgentRunner({
      runDirectory,
      stateStore: state,
      frameworkDatabase,
      tools: {
        validatePlan: unexpectedMediaTool("validate_video_plan"),
        generateVideo: unexpectedMediaTool("generate_video"),
        generateFoley: unexpectedMediaTool("generate_foley_track"),
        generateMusic: unexpectedMediaTool("generate_music_track"),
        assembleVideo: unexpectedMediaTool("assemble_final_video"),
        additionalTools: [testTool("get_video_run_status", "planning")],
      },
      frameworkOptions: {
        model: transientHttp500Model(tracker),
        recursionLimit: 10,
      },
    });

    await assert.rejects(
      () => runner.run(prompt),
      (error: unknown) => error instanceof Error
        && /500 Internal server error|transient planning/i.test(error.message),
    );

    assert.equal(tracker.count, 3, "the existing three-attempt bound must also cap HTTP 500 retries");
    assert.equal(mediaCalls, 0, "a planning retry must not submit Agnes or any downstream media work");
    assert.equal(await state.loadPlan(prompt), null);
    assert.equal((await state.loadManifest(prompt))?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks the pipeline failed when the planning draft ceiling is exhausted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-plan-budget-"));
  const prompt = "Create a twelve-second animated story about a brave chicken.";
  const promptHash = hashUserPrompt(prompt);
  const runDirectory = path.join(root, promptHash);
  const state = new VideoRunStateStore(runDirectory);
  const frameworkDatabase = new LocalFrameworkDatabase(runDirectory, promptHash);
  const tracker = { count: 0 };

  try {
    await state.ensureManifest(prompt);
    const runner = createVideoAgentRunner({
      runDirectory,
      stateStore: state,
      frameworkDatabase,
      tools: {
        validatePlan: testTool("validate_video_plan", "rejected"),
        generateVideo: testTool("generate_video", "unexpected"),
        generateFoley: testTool("generate_foley_track", "unexpected"),
        generateMusic: testTool("generate_music_track", "unexpected"),
        assembleVideo: testTool("assemble_final_video", "unexpected"),
        additionalTools: [testTool("get_video_run_status", "planning")],
      },
      frameworkOptions: {
        model: planningBudgetFailureModel(tracker),
        recursionLimit: 10,
      },
    });

    await assert.rejects(
      () => runner.run(prompt),
      (error: unknown) => error instanceof Error
        && error.message === "500 Internal server error",
    );
    assert.equal(tracker.count, 1, "the draft circuit breaker is fatal, not a provider retry");
    assert.equal((await state.loadManifest(prompt))?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not retry a fatal planning 400 or invoke media tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-fatal-400-"));
  const prompt = "Create a twelve-second animation about a paper airplane.";
  const promptHash = hashUserPrompt(prompt);
  const runDirectory = path.join(root, promptHash);
  const state = new VideoRunStateStore(runDirectory);
  const frameworkDatabase = new LocalFrameworkDatabase(runDirectory, promptHash);
  const tracker = { count: 0 };
  const calls: string[] = [];

  try {
    await state.ensureManifest(prompt);
    const runner = createVideoAgentRunner({
      runDirectory,
      stateStore: state,
      frameworkDatabase,
      tools: {
        validatePlan: testTool("validate_video_plan", "stored", calls),
        generateVideo: testTool("generate_video", "completed", calls),
        generateFoley: testTool("generate_foley_track", "completed", calls),
        generateMusic: testTool("generate_music_track", "completed", calls),
        assembleVideo: testTool("assemble_final_video", "completed", calls),
        additionalTools: [testTool("get_video_run_status", "planning", calls)],
      },
      frameworkOptions: {
        model: failingHttpModel(tracker, 400, "invalid tool schema"),
        recursionLimit: 10,
      },
    });

    await assert.rejects(() => runner.run(prompt), /invalid tool schema/);
    assert.equal(tracker.count, 1);
    assert.deepEqual(calls, []);
    assert.equal((await frameworkDatabase.getRun(promptHash))?.status, "failed");
    assert.equal((await state.loadManifest(prompt))?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses automatic replanning when media state exists without a valid plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-unsafe-replan-"));
  const prompt = "Create a twelve-second animation about a paper airplane.";
  const promptHash = hashUserPrompt(prompt);
  const frameworkDatabase = new LocalFrameworkDatabase(root, promptHash);
  const tracker = { count: 0 };
  const calls: string[] = [];
  const state = {
    promptHash: () => promptHash,
    loadPlan: async () => null,
    listCheckpoints: async () => [{ key: "video:checkpoint:source", value: { status: "unknown" } }],
    updateStatus: async () => undefined,
  } as unknown as VideoRunStateStore;

  try {
    const runner = createVideoAgentRunner({
      runDirectory: root,
      stateStore: state,
      frameworkDatabase,
      tools: {
        validatePlan: testTool("validate_video_plan", "stored", calls),
        generateVideo: testTool("generate_video", "completed", calls),
        generateFoley: testTool("generate_foley_track", "completed", calls),
        generateMusic: testTool("generate_music_track", "completed", calls),
        assembleVideo: testTool("assemble_final_video", "completed", calls),
        additionalTools: [testTool("get_video_run_status", "planning", calls)],
      },
      frameworkOptions: {
        model: transientHttp500Model(tracker),
        recursionLimit: 10,
      },
    });

    await assert.rejects(
      () => runner.run(prompt),
      (error: unknown) => error instanceof VideoAgentUnsafePlanningRetryError,
    );
    assert.equal(tracker.count, 1);
    assert.deepEqual(calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continues a durable plan without invoking the planning model again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-transient-resume-"));
  const prompt = "Create a twelve-second animated story about a brave chicken.";
  const promptHash = hashUserPrompt(prompt);
  const frameworkDatabase = new LocalFrameworkDatabase(root, promptHash);
  const tracker = { count: 0 };
  const calls: string[] = [];
  const state = {
    promptHash: () => promptHash,
    loadPlan: async () => ({ music: { enabled: true } }),
    listCheckpoints: async () => [{ status: "completed" }],
    updateStatus: async () => undefined,
  } as unknown as VideoRunStateStore;

  try {
    const runner = createVideoAgentRunner({
      runDirectory: root,
      stateStore: state,
      frameworkDatabase,
      tools: {
        validatePlan: testTool("validate_video_plan", "stored", calls),
        generateVideo: testTool("generate_video", "reused", calls),
        generateFoley: testTool("generate_foley_track", "native_audio_selected", calls),
        generateMusic: testTool("generate_music_track", "reused", calls),
        assembleVideo: testTool("assemble_final_video", "reused", calls),
        additionalTools: [testTool("get_video_run_status", "generating", calls)],
      },
      frameworkOptions: {
        model: transientHttp500Model(tracker),
        recursionLimit: 10,
      },
    });

    const result = await runner.run(prompt);

    assert.equal(tracker.count, 0, "durable local work must bypass every planning-model attempt");
    assert.deepEqual(calls, [
      "generate_video",
      "generate_foley_track",
      "generate_music_track",
      "assemble_final_video",
    ]);
    assert.ok(result.finalText.trim());
    assert.equal(await frameworkDatabase.getRun(promptHash), null);
    assert.equal((await frameworkDatabase.getTodos(promptHash)).length, 0);
    assert.equal(
      await frameworkDatabase.getLatestCheckpoint(`run-${promptHash.slice(0, 16)}`),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
