import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AIMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { hashUserPrompt } from "freetier-deepagent-framework";
import { z } from "zod";

import {
  createVideoAgentRunner,
  VideoAgentNoProgressError,
} from "../src/agent/videoAgentRunner.js";
import { LocalFrameworkDatabase } from "../src/state/localFrameworkDatabase.js";
import {
  VideoRunStateStore,
  videoCheckpointKeys,
} from "../src/state/videoRunState.js";

function noOpTool(name: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name,
    description: `Test-only ${name} tool.`,
    schema: z.object({}).strict(),
    func: async () => JSON.stringify({ status: "unexpected" }),
  }) as unknown as DynamicStructuredTool;
}

test("restarts an interrupted pre-media graph without retaining its transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-planning-restart-"));
  const prompt = "Create a twelve-second animated chicken crossing a road.";
  const promptHash = hashUserPrompt(prompt);
  const threadId = `run-${promptHash.slice(0, 16)}`;
  const database = new LocalFrameworkDatabase(root, promptHash);

  try {
    await database.createRun(promptHash, prompt, threadId, "nvidia");
    await database.replaceTodos(promptHash, [
      { content: "Create a plan", status: "in_progress" },
      { content: "Generate the video", status: "pending" },
    ]);
    await database.saveCheckpoint(threadId, "checkpoint-poisoned", {
      messages: ["large rejected validator payload"],
    }, {});
    await database.saveCheckpointWrite(
      threadId,
      "",
      "checkpoint-poisoned",
      "task-1",
      0,
      "messages",
      { error: "rejected plan" },
    );
    await database.saveCheckpoint("unrelated-thread", "checkpoint-keep", { keep: true }, {});
    await database.setCurrentProvider(promptHash, "huggingface");

    const observed = await database.getRun(promptHash);
    assert.ok(observed);

    const stale = await database.restartPreMediaPlanningState(promptHash, {
      ...observed,
      updated_at: "2000-01-01T00:00:00.000Z",
    }, "stale reset", "nvidia");
    assert.equal(stale.restarted, false);
    assert.ok(await database.getLatestCheckpoint(threadId));

    const restarted = await database.restartPreMediaPlanningState(
      promptHash,
      observed,
      "new invocation after cancellation",
      "nvidia",
    );
    assert.deepEqual(restarted, {
      restarted: true,
      clearedTodos: 2,
      clearedCheckpoints: 1,
      clearedWrites: 1,
    });
    assert.equal((await database.getRun(promptHash))?.status, "in_progress");
    assert.equal((await database.getRun(promptHash))?.final_result, null);
    assert.equal((await database.getRun(promptHash))?.error_message, null);
    assert.equal((await database.getRun(promptHash))?.current_provider, "nvidia");
    assert.deepEqual(await database.getTodos(promptHash), []);
    assert.equal(await database.getLatestCheckpoint(threadId), null);
    assert.ok(
      await database.getLatestCheckpoint("unrelated-thread"),
      "the reset is scoped to the run's own LangGraph thread",
    );

    const document = JSON.parse(
      await readFile(path.join(root, "agent-state.json"), "utf8"),
    ) as {
      events: Array<{ event_type: string; details: Record<string, unknown> }>;
      writes: Record<string, unknown>;
    };
    assert.equal(document.events.at(-1)?.event_type, "pre_media_planning_state_restarted");
    assert.equal(document.events.at(-1)?.details.clearedCheckpoints, 1);
    assert.equal(document.events.at(-1)?.details.resetProvider, "nvidia");
    assert.equal(Object.keys(document.writes).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reopens only a failed manifest that has no plan or media checkpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-manifest-reopen-"));
  const prompt = "Create a cinematic video of a lighthouse.";
  const state = new VideoRunStateStore(root);

  try {
    await state.ensureManifest(prompt);
    await state.updateStatus(prompt, "failed");
    assert.equal(await state.reopenFailedPlanning(prompt), true);
    assert.equal((await state.loadManifest(prompt))?.status, "planning");
    assert.equal(await state.reopenFailedPlanning(prompt), false);

    await state.startCheckpoint(prompt, videoCheckpointKeys.sourceVideo, {
      provider: "agnes",
      model: "agnes-video-2.5-flash",
    });
    await state.updateStatus(prompt, "failed");
    assert.equal(
      await state.reopenFailedPlanning(prompt),
      false,
      "an accepted or started media operation must retain its failed status and receipt",
    );
    assert.equal((await state.loadManifest(prompt))?.status, "failed");
    assert.equal(
      (await state.loadCheckpoint(prompt, videoCheckpointKeys.sourceVideo))?.status,
      "in_progress",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed pre-media graph restarts from the invocation's initial provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-planning-provider-reset-"));
  const prompt = "Create a twelve-second animation of a lighthouse.";
  const promptHash = hashUserPrompt(prompt);
  const threadId = `run-${promptHash.slice(0, 16)}`;
  const database = new LocalFrameworkDatabase(root, promptHash);

  try {
    await database.createRun(promptHash, prompt, threadId, "nvidia");
    await database.setCurrentProvider(promptHash, "huggingface");
    await database.updateRunStatus(promptHash, "failed", "provider failed");
    const failed = await database.getRun(promptHash);
    assert.ok(failed);

    const restarted = await database.restartPreMediaPlanningState(
      promptHash,
      failed,
      "fresh invocation",
      "nvidia",
    );
    assert.equal(restarted.restarted, true);
    assert.equal((await database.getRun(promptHash))?.status, "in_progress");
    assert.equal((await database.getRun(promptHash))?.current_provider, "nvidia");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a same-prompt rerun discards cancelled planning history before invoking the model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-cancelled-rerun-"));
  const prompt = "Create a funny twelve-second animated chicken crossing a road.";
  const promptHash = hashUserPrompt(prompt);
  const runDirectory = path.join(root, promptHash);
  const threadId = `run-${promptHash.slice(0, 16)}`;
  const state = new VideoRunStateStore(runDirectory);
  const database = new LocalFrameworkDatabase(runDirectory, promptHash);
  const restartPlanning = database.restartPreMediaPlanningState.bind(database);
  let entryRecovery: Awaited<ReturnType<typeof restartPlanning>> | undefined;
  database.restartPreMediaPlanningState = async (...arguments_) => {
    entryRecovery = await restartPlanning(...arguments_);
    return entryRecovery;
  };

  try {
    await state.ensureManifest(prompt);
    await state.updateStatus(prompt, "failed");
    await database.createRun(promptHash, prompt, threadId, "nvidia");
    await database.replaceTodos(promptHash, [
      { content: "Create an oversized rejected plan", status: "in_progress" },
    ]);
    await database.saveCheckpoint(threadId, "cancelled-checkpoint", {
      messages: ["an oversized rejected plan and stack trace"],
    }, {});
    await database.saveCheckpointWrite(
      threadId,
      "",
      "cancelled-checkpoint",
      "task-cancelled",
      0,
      "messages",
      { huge: "validator response" },
    );

    const runner = createVideoAgentRunner({
      runDirectory,
      stateStore: state,
      frameworkDatabase: database,
      tools: {
        validatePlan: noOpTool("validate_video_plan"),
        generateVideo: noOpTool("generate_video"),
        generateFoley: noOpTool("generate_foley_track"),
        generateMusic: noOpTool("generate_music_track"),
        assembleVideo: noOpTool("assemble_final_video"),
        additionalTools: [noOpTool("get_video_run_status")],
      },
      frameworkOptions: {
        model: new FakeStreamingChatModel({ responses: [new AIMessage("")], sleep: 0 }),
        recursionLimit: 10,
      },
    });

    await assert.rejects(
      () => runner.run(prompt),
      (error: unknown) => error instanceof VideoAgentNoProgressError,
    );

    const document = JSON.parse(
      await readFile(path.join(runDirectory, "agent-state.json"), "utf8"),
    ) as {
      events: Array<{ event_type: string; details: Record<string, unknown> }>;
      checkpoints: Record<string, unknown>;
      writes: Record<string, unknown>;
    };
    assert.deepEqual(entryRecovery, {
      restarted: true,
      clearedTodos: 1,
      clearedCheckpoints: 1,
      clearedWrites: 1,
    });
    assert.equal(Object.keys(document.checkpoints).length, 0);
    assert.equal(Object.keys(document.writes).length, 0);
    assert.equal((await state.loadManifest(prompt))?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
