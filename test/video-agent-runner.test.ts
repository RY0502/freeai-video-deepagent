import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { getHarnessProfile } from "deepagents";
import { hashUserPrompt } from "freetier-deepagent-framework";
import { z } from "zod";

import {
  createVideoPlanningAttemptBudget,
  ensureDeepAgentPlanningMiddleware,
  videoPlanContinuationMiddleware,
  VideoPlanningAttemptsExhaustedError,
  withVideoPlanningAttemptBudget,
} from "../src/agent/deepAgentCompatibility.js";
import {
  createVideoAgentRunner,
  EMPTY_FRAMEWORK_FINAL_TEXT,
  VideoAgentNoProgressError,
} from "../src/agent/videoAgentRunner.js";
import { LocalFrameworkDatabase } from "../src/state/localFrameworkDatabase.js";
import { VideoRunStateStore } from "../src/state/videoRunState.js";

const testRequire = createRequire(import.meta.url);

interface PinnedChatOpenAiModel {
  maxTokens?: number;
  timeout?: number;
  temperature?: number;
  modelKwargs?: Record<string, unknown>;
  invocationParams(options?: Record<string, unknown>): Record<string, unknown>;
}

function createPinnedChatOpenAi(fields: Record<string, unknown>): PinnedChatOpenAiModel {
  const frameworkEntry = testRequire.resolve("freetier-deepagent-framework");
  const openAiEntry = testRequire.resolve("@langchain/openai", {
    paths: [path.dirname(frameworkEntry)],
  });
  const module = testRequire(openAiEntry) as {
    ChatOpenAI: new (input: Record<string, unknown>) => PinnedChatOpenAiModel;
  };
  return new module.ChatOpenAI(fields);
}

function noOpTool(name: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name,
    description: `Test-only ${name} tool.`,
    schema: z.object({}).strict(),
    func: async () => JSON.stringify({ status: "unused" }),
  }) as unknown as DynamicStructuredTool;
}

interface TestChatModelFields {
  model: string;
  maxTokens?: number;
  maxCompletionTokens?: number;
  timeout?: number;
  temperature?: number;
  modelKwargs?: Record<string, unknown>;
}

/** Mirrors ChatOpenAI 1.5's facade behavior: request fields are copied at construction. */
class TestChatOpenAiFacade {
  readonly fields: TestChatModelFields;
  readonly model: string;
  readonly maxTokens: number | undefined;
  readonly timeout: number | undefined;
  readonly temperature: number | undefined;
  readonly modelKwargs: Record<string, unknown>;

  constructor(fields: TestChatModelFields) {
    this.fields = { ...fields };
    this.model = fields.model;
    this.maxTokens = fields.maxCompletionTokens ?? fields.maxTokens;
    this.timeout = fields.timeout;
    this.temperature = fields.temperature;
    this.modelKwargs = { ...(fields.modelKwargs ?? {}) };
  }

  invocationParams(): Record<string, unknown> {
    return {
      model: this.model,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      ...this.modelKwargs,
    };
  }

  async invoke(): Promise<AIMessage> {
    return new AIMessage("");
  }
}

test("installs only the bounded video planner middleware for OpenAI-compatible models", () => {
  ensureDeepAgentPlanningMiddleware();
  const profile = getHarnessProfile("openai:z-ai/glm-5.2");
  assert.ok(profile);
  const middleware = typeof profile.extraMiddleware === "function"
    ? profile.extraMiddleware()
    : profile.extraMiddleware;
  const todoMiddleware = middleware.find((candidate) => candidate.name === "todoListMiddleware");
  const continuationMiddleware = middleware.find(
    (candidate) => candidate.name === "videoPlanContinuationMiddleware",
  );
  assert.equal(todoMiddleware, undefined);
  assert.ok(continuationMiddleware);
  assert.equal(middleware.length, 1);
});

test("forces compact plan validation on the first video planning turn", async () => {
  const middleware = videoPlanContinuationMiddleware();
  const wrapModelCall = middleware.wrapModelCall;
  assert.equal(typeof wrapModelCall, "function");

  const validatePlan = noOpTool("validate_video_plan");
  const getStatus = noOpTool("get_video_run_status");
  // Exercise the actual transitive ChatOpenAI version used by the framework.
  // No invocation occurs, so the fake endpoint can never receive network I/O.
  const nemotronModel = createPinnedChatOpenAi({
    apiKey: "test-only",
    model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    temperature: 0.7,
    modelKwargs: {},
    configuration: { baseURL: "https://example.invalid/v1" },
  });
  const messages: ToolMessage[] = [];
  const request = {
    model: nemotronModel as never,
    messages,
    systemPrompt: "test",
    systemMessage: new SystemMessage("test"),
    tools: [validatePlan, getStatus],
    state: { messages, todos: [] },
    runtime: {} as never,
  };
  let handlerCalls = 0;

  await wrapModelCall!(request as never, (async (nextRequest: typeof request) => {
    handlerCalls += 1;
    const prepared = nextRequest as typeof request & {
      toolChoice?: unknown;
      modelSettings?: Record<string, unknown>;
    };
    assert.deepEqual(nextRequest.tools.map((tool) => tool.name), ["validate_video_plan"]);
    assert.deepEqual(prepared.toolChoice, {
      type: "function",
      function: { name: "validate_video_plan" },
    });
    assert.equal(prepared.modelSettings?.parallel_tool_calls, false);
    assert.equal(prepared.modelSettings?.maxRetries, 0);
    assert.equal(prepared.systemPrompt, "test");
    assert.match(String(nextRequest.systemMessage.content), /explicitly requested vocalizations.*outrank/i);
    assert.doesNotMatch(String(nextRequest.systemMessage.content), /tavily_search|live-data-subagent/i);
    const preparedModel = nextRequest.model as unknown as PinnedChatOpenAiModel;
    assert.notEqual(preparedModel, nemotronModel);
    assert.equal(preparedModel.maxTokens, 8_192);
    assert.equal(preparedModel.timeout, 120_000);
    assert.equal(preparedModel.temperature, 0);
    assert.deepEqual(preparedModel.modelKwargs, {
      chat_template_kwargs: { enable_thinking: false },
    });
    const invocationParams = preparedModel.invocationParams();
    assert.equal(invocationParams.model, "nvidia/nemotron-3.5-lightning-30b-a3b");
    assert.equal(invocationParams.temperature, 0);
    assert.equal(invocationParams.max_tokens, 8_192);
    assert.deepEqual(invocationParams.chat_template_kwargs, { enable_thinking: false });
    return new AIMessage({
      content: "",
      tool_calls: [{
        id: "plan-1",
        name: "validate_video_plan",
        args: { plan: {} },
        type: "tool_call",
      }],
    });
  }) as never);

  assert.equal(handlerCalls, 1);
  assert.equal(nemotronModel.maxTokens, undefined);
  assert.equal(nemotronModel.timeout, undefined);
  assert.equal(nemotronModel.temperature, 0.7);
  assert.deepEqual(nemotronModel.modelKwargs, {});
  const originalInvocationParams = nemotronModel.invocationParams();
  assert.equal(originalInvocationParams.max_tokens, undefined);
  assert.equal(originalInvocationParams.chat_template_kwargs, undefined);
});

test("does not spend a model turn re-reading run status before validation", async () => {
  const middleware = videoPlanContinuationMiddleware();
  const wrapModelCall = middleware.wrapModelCall;
  assert.equal(typeof wrapModelCall, "function");

  const validatePlan = noOpTool("validate_video_plan");
  const getStatus = noOpTool("get_video_run_status");
  const generateVideo = noOpTool("generate_video");
  const messages = [new ToolMessage({
    content: "Updated todo list",
    name: "write_todos",
    tool_call_id: "todos-1",
  })];
  const observedRequests: Array<{
    tools: Array<{ name: string }>;
    toolChoice?: unknown;
    modelSettings?: Record<string, unknown>;
    systemMessage: SystemMessage;
  }> = [];

  const request = {
    model: {} as never,
    messages,
    systemPrompt: "test",
    systemMessage: new SystemMessage("test"),
    tools: [validatePlan, getStatus, generateVideo],
    state: {
      messages,
      todos: [{ content: "Create video plan", status: "in_progress" }],
    },
    runtime: {} as never,
  };
  const handler = async (nextRequest: typeof request) => {
    observedRequests.push(nextRequest);
    return new AIMessage({
      content: "",
      tool_calls: [{
        id: "plan-1",
        name: "validate_video_plan",
        args: { plan: {} },
        type: "tool_call",
      }],
    });
  };

  const result = await wrapModelCall!(request as never, handler as never);
  assert.equal(observedRequests.length, 1);
  for (const observed of observedRequests) {
    assert.deepEqual(observed.tools.map((tool) => tool.name), ["validate_video_plan"]);
    assert.deepEqual(observed.toolChoice, {
      type: "function",
      function: { name: "validate_video_plan" },
    });
    assert.equal(observed.modelSettings?.parallel_tool_calls, false);
    assert.match(String(observed.systemMessage.content), /must be exactly one validate_video_plan tool call/i);
  }
  assert.ok(AIMessage.isInstance(result));
  assert.equal(result.tool_calls?.[0]?.name, "validate_video_plan");
});

test("requires plan validation after status without a hidden provider retry", async () => {
  const middleware = videoPlanContinuationMiddleware();
  const wrapModelCall = middleware.wrapModelCall;
  assert.equal(typeof wrapModelCall, "function");

  const validatePlan = noOpTool("validate_video_plan");
  const getStatus = noOpTool("get_video_run_status");
  const generateVideo = noOpTool("generate_video");
  const messages = [
    new ToolMessage({
      content: "Updated todo list",
      name: "write_todos",
      tool_call_id: "todos-1",
    }),
    new ToolMessage({
      content: JSON.stringify({ status: "planning", planStored: false }),
      name: "get_video_run_status",
      tool_call_id: "status-1",
    }),
  ];
  const observedRequests: Array<{
    tools: Array<{ name: string }>;
    toolChoice?: unknown;
    modelSettings?: Record<string, unknown>;
    systemMessage: SystemMessage;
  }> = [];
  const nemotronModel = new TestChatOpenAiFacade({
    model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    maxTokens: 1_024,
    temperature: 0.7,
    modelKwargs: { seed: 42 },
  });
  const request = {
    model: nemotronModel as never,
    messages,
    systemPrompt: "test",
    systemMessage: new SystemMessage("test"),
    tools: [validatePlan, getStatus, generateVideo],
    state: {
      messages,
      todos: [{ content: "Create video plan", status: "in_progress" }],
    },
    runtime: {} as never,
  };
  const handler = async (nextRequest: typeof request) => {
    observedRequests.push(nextRequest);
    const preparedModel = nextRequest.model as unknown as TestChatOpenAiFacade;
    assert.notEqual(preparedModel, nemotronModel);
    assert.equal(preparedModel.maxTokens, 8_192);
    assert.equal(preparedModel.timeout, 120_000);
    assert.equal(preparedModel.temperature, 0);
    assert.deepEqual(preparedModel.modelKwargs, {
      seed: 42,
      chat_template_kwargs: { enable_thinking: false },
    });
    return new AIMessage("I will create the plan next.");
  };

  const result = await wrapModelCall!(request as never, handler as never);
  assert.equal(observedRequests.length, 1);
  for (const observed of observedRequests) {
    assert.deepEqual(observed.tools.map((tool) => tool.name), ["validate_video_plan"]);
    assert.deepEqual(observed.toolChoice, {
      type: "function",
      function: { name: "validate_video_plan" },
    });
    assert.equal(observed.modelSettings?.parallel_tool_calls, false);
    assert.equal(observed.modelSettings?.maxRetries, 0);
  }
  assert.equal(nemotronModel.maxTokens, 1_024);
  assert.equal(nemotronModel.temperature, 0.7);
  assert.deepEqual(nemotronModel.modelKwargs, { seed: 42 });
  assert.ok(AIMessage.isInstance(result));
  if (AIMessage.isInstance(result)) {
    assert.equal(result.content, "I will create the plan next.");
  }
});

test("stops after three rejected video plan validation attempts", async () => {
  const middleware = videoPlanContinuationMiddleware();
  const wrapModelCall = middleware.wrapModelCall;
  assert.equal(typeof wrapModelCall, "function");

  const validatePlan = noOpTool("validate_video_plan");
  const getStatus = noOpTool("get_video_run_status");
  const messages = [
    new ToolMessage({
      content: "Updated todo list",
      name: "write_todos",
      tool_call_id: "todos-1",
    }),
    new ToolMessage({
      content: JSON.stringify({ status: "planning", planStored: false }),
      name: "get_video_run_status",
      tool_call_id: "status-1",
    }),
    ...[1, 2, 3].flatMap((attempt) => [
      new AIMessage({
        content: "",
        tool_calls: [{
          id: `plan-${attempt}`,
          name: "validate_video_plan",
          args: { plan: {} },
          type: "tool_call",
        }],
      }),
      new ToolMessage({
        content: JSON.stringify({ status: "rejected", valid: false }),
        name: "validate_video_plan",
        tool_call_id: `plan-${attempt}`,
      }),
    ]),
  ];
  const request = {
    model: {} as never,
    messages,
    systemPrompt: "test",
    systemMessage: new SystemMessage("test"),
    tools: [validatePlan, getStatus],
    state: {
      messages,
      todos: [{ content: "Create video plan", status: "in_progress" }],
    },
    runtime: {} as never,
  };
  let handlerCalls = 0;

  await assert.rejects(
    async () => await wrapModelCall!(request as never, (async () => {
      handlerCalls += 1;
      return new AIMessage("unexpected");
    }) as never),
    (error: unknown) => error instanceof VideoPlanningAttemptsExhaustedError
      && error.code === "VIDEO_PLANNING_ATTEMPTS_EXHAUSTED"
      && error.attempts === 3
      && error.maxAttempts === 3
      && /stopped before media generation/.test(error.message),
  );
  assert.equal(handlerCalls, 0);
});

test("keeps the three-validation ceiling across cleared planning transcripts", async () => {
  const middleware = videoPlanContinuationMiddleware();
  const wrapModelCall = middleware.wrapModelCall;
  assert.equal(typeof wrapModelCall, "function");

  const validatePlan = noOpTool("validate_video_plan");
  const getStatus = noOpTool("get_video_run_status");
  const messages = [
    new ToolMessage({
      content: "Updated todo list",
      name: "write_todos",
      tool_call_id: "todos-1",
    }),
    new ToolMessage({
      content: JSON.stringify({ status: "planning", planStored: false }),
      name: "get_video_run_status",
      tool_call_id: "status-1",
    }),
  ];
  const request = {
    model: {} as never,
    messages,
    systemPrompt: "test",
    systemMessage: new SystemMessage("test"),
    tools: [validatePlan, getStatus],
    state: {
      messages,
      todos: [{ content: "Create video plan", status: "in_progress" }],
    },
    runtime: {} as never,
  };
  const budget = createVideoPlanningAttemptBudget();
  let handlerCalls = 0;
  const modelToolCall = async () => {
    handlerCalls += 1;
    return new AIMessage({
      content: "",
      tool_calls: [{
        id: `plan-${handlerCalls}`,
        name: "validate_video_plan",
        args: { plan: {} },
        type: "tool_call",
      }],
    });
  };

  // Reuse the short transcript to model a host retry after it has discarded
  // a completed, no-progress graph. The invocation budget must not reset.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await withVideoPlanningAttemptBudget(
      budget,
      async () => await wrapModelCall!(request as never, modelToolCall as never),
    );
  }
  await assert.rejects(
    () => withVideoPlanningAttemptBudget(
      budget,
      async () => await wrapModelCall!(request as never, modelToolCall as never),
    ),
    (error: unknown) => error instanceof VideoPlanningAttemptsExhaustedError
      && error.attempts === 3,
  );
  assert.equal(handlerCalls, 3);
});

test("counts parallel validator calls and rejects a response that would exceed the ceiling", async () => {
  const middleware = videoPlanContinuationMiddleware();
  const wrapModelCall = middleware.wrapModelCall;
  assert.equal(typeof wrapModelCall, "function");

  const validatePlan = noOpTool("validate_video_plan");
  const getStatus = noOpTool("get_video_run_status");
  const messages = [
    new ToolMessage({
      content: "Updated todo list",
      name: "write_todos",
      tool_call_id: "todos-1",
    }),
    new ToolMessage({
      content: JSON.stringify({ status: "planning", planStored: false }),
      name: "get_video_run_status",
      tool_call_id: "status-1",
    }),
  ];
  const request = {
    model: {} as never,
    messages,
    systemPrompt: "test",
    systemMessage: new SystemMessage("test"),
    tools: [validatePlan, getStatus],
    state: {
      messages,
      todos: [{ content: "Create video plan", status: "in_progress" }],
    },
    runtime: {} as never,
  };
  const budget = createVideoPlanningAttemptBudget();
  let handlerCalls = 0;
  const twoDraftResponse = async () => {
    handlerCalls += 1;
    return new AIMessage({
      content: "",
      tool_calls: [1, 2].map((index) => ({
        id: `response-${handlerCalls}-plan-${index}`,
        name: "validate_video_plan",
        args: { plan: {} },
        type: "tool_call" as const,
      })),
    });
  };

  await withVideoPlanningAttemptBudget(
    budget,
    async () => await wrapModelCall!(request as never, twoDraftResponse as never),
  );
  assert.equal(budget.validationAttempts, 2);

  await assert.rejects(
    () => withVideoPlanningAttemptBudget(
      budget,
      async () => await wrapModelCall!(request as never, twoDraftResponse as never),
    ),
    (error: unknown) => error instanceof VideoPlanningAttemptsExhaustedError
      && error.attempts === 3,
  );
  assert.equal(handlerCalls, 2);
  assert.equal(budget.validationAttempts, 3);
});

test("ends model orchestration after the video plan is accepted", async () => {
  const middleware = videoPlanContinuationMiddleware();
  const wrapModelCall = middleware.wrapModelCall;
  assert.equal(typeof wrapModelCall, "function");

  const validatePlan = noOpTool("validate_video_plan");
  const getStatus = noOpTool("get_video_run_status");
  const generateVideo = noOpTool("generate_video");
  const messages = [
    new ToolMessage({
      content: "Updated todo list",
      name: "write_todos",
      tool_call_id: "todos-1",
    }),
    new ToolMessage({
      content: JSON.stringify({ status: "planning", planStored: false }),
      name: "get_video_run_status",
      tool_call_id: "status-1",
    }),
    new ToolMessage({
      content: JSON.stringify({ status: "stored", valid: true }),
      name: "validate_video_plan",
      tool_call_id: "plan-1",
    }),
  ];
  const request = {
    model: {} as never,
    messages,
    systemPrompt: "test",
    systemMessage: new SystemMessage("test"),
    tools: [validatePlan, getStatus, generateVideo],
    state: {
      messages,
      todos: [{ content: "Generate video", status: "in_progress" }],
    },
    runtime: {} as never,
  };
  let handlerCalls = 0;

  const result = await wrapModelCall!(request as never, (async () => {
    handlerCalls += 1;
    return new AIMessage("continue");
  }) as never);

  assert.equal(handlerCalls, 0);
  assert.ok(AIMessage.isInstance(result));
  assert.match(String(result.content), /host will continue/i);
});

test("ends model orchestration when trusted status says a plan is stored", async () => {
  const middleware = videoPlanContinuationMiddleware();
  const wrapModelCall = middleware.wrapModelCall;
  assert.equal(typeof wrapModelCall, "function");

  const validatePlan = noOpTool("validate_video_plan");
  const getStatus = noOpTool("get_video_run_status");
  const generateVideo = noOpTool("generate_video");
  const messages = [
    new ToolMessage({
      content: "Updated todo list",
      name: "write_todos",
      tool_call_id: "todos-1",
    }),
    new ToolMessage({
      content: JSON.stringify({ status: "generating", planStored: true }),
      name: "get_video_run_status",
      tool_call_id: "status-1",
    }),
  ];
  const request = {
    model: {} as never,
    messages,
    systemPrompt: "test",
    systemMessage: new SystemMessage("test"),
    tools: [validatePlan, getStatus, generateVideo],
    state: {
      messages,
      todos: [{ content: "Generate video", status: "in_progress" }],
    },
    runtime: {} as never,
  };
  let handlerCalls = 0;

  const result = await wrapModelCall!(request as never, (async () => {
    handlerCalls += 1;
    return new AIMessage("continue");
  }) as never);

  assert.equal(handlerCalls, 0);
  assert.ok(AIMessage.isInstance(result));
  assert.match(String(result.content), /host will continue/i);
});

test("host deterministically advances every media stage, including recovered music", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-host-continuation-"));
  const prompt = "Create a ten-second abstract color animation.";
  const promptHash = hashUserPrompt(prompt);
  const frameworkDatabase = new LocalFrameworkDatabase(root, promptHash);
  const model = new FakeStreamingChatModel({
    responses: [new AIMessage("The plan is ready.")],
    sleep: 0,
  });
  const calls: string[] = [];
  const readyTool = (name: string, status: string): DynamicStructuredTool =>
    new DynamicStructuredTool({
      name,
      description: `Test-only ${name} tool.`,
      schema: z.object({}).strict(),
      func: async () => {
        calls.push(name);
        return JSON.stringify({ status });
      },
    }) as unknown as DynamicStructuredTool;
  const state = {
    promptHash: () => promptHash,
    loadPlan: async () => ({ music: { enabled: true } }),
    listCheckpoints: async () => [],
    updateStatus: async () => undefined,
  } as unknown as VideoRunStateStore;

  try {
    const runner = createVideoAgentRunner({
      runDirectory: root,
      stateStore: state,
      frameworkDatabase,
      tools: {
        validatePlan: noOpTool("validate_video_plan"),
        generateVideo: readyTool("generate_video", "completed"),
        generateFoley: readyTool("generate_foley_track", "native_audio_selected"),
        generateMusic: readyTool("generate_music_track", "recovered"),
        assembleVideo: readyTool("assemble_final_video", "completed"),
        additionalTools: [noOpTool("get_video_run_status")],
      },
      frameworkOptions: { model, recursionLimit: 10 },
    });

    await runner.run(prompt);
    assert.deepEqual(calls, [
      "generate_video",
      "generate_foley_track",
      // "generate_music_track", // Commented out for now
      "assemble_final_video",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host continuation stops after a pending Agnes result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-host-pending-"));
  const prompt = "Create a ten-second abstract color animation.";
  const promptHash = hashUserPrompt(prompt);
  const frameworkDatabase = new LocalFrameworkDatabase(root, promptHash);
  const model = new FakeStreamingChatModel({
    responses: [new AIMessage("The plan is ready.")],
    sleep: 0,
  });
  const calls: string[] = [];
  const outcomeTool = (name: string, status: string): DynamicStructuredTool =>
    new DynamicStructuredTool({
      name,
      description: `Test-only ${name} tool.`,
      schema: z.object({}).strict(),
      func: async () => {
        calls.push(name);
        return JSON.stringify({ status });
      },
    }) as unknown as DynamicStructuredTool;
  const state = {
    promptHash: () => promptHash,
    loadPlan: async () => ({ music: { enabled: true } }),
    listCheckpoints: async () => [],
    updateStatus: async () => undefined,
  } as unknown as VideoRunStateStore;

  try {
    const runner = createVideoAgentRunner({
      runDirectory: root,
      stateStore: state,
      frameworkDatabase,
      tools: {
        validatePlan: noOpTool("validate_video_plan"),
        generateVideo: outcomeTool("generate_video", "pending"),
        generateFoley: outcomeTool("generate_foley_track", "completed"),
        generateMusic: outcomeTool("generate_music_track", "completed"),
        assembleVideo: outcomeTool("assemble_final_video", "completed"),
        additionalTools: [noOpTool("get_video_run_status")],
      },
      frameworkOptions: { model, recursionLimit: 10 },
    });

    await runner.run(prompt);
    assert.deepEqual(calls, ["generate_video"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retries and rejects empty framework completions without submitting media", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-empty-output-"));
  const prompt = "Create a video of a lighthouse during a storm.";
  const promptHash = hashUserPrompt(prompt);
  const runDirectory = path.join(root, promptHash);
  const state = new VideoRunStateStore(runDirectory);
  const frameworkDatabase = new LocalFrameworkDatabase(runDirectory, promptHash);
  const model = new FakeStreamingChatModel({
    responses: [new AIMessage("")],
    sleep: 0,
  });
  let mediaCalls = 0;
  const countedTool = (name: string): DynamicStructuredTool => new DynamicStructuredTool({
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
        validatePlan: countedTool("validate_video_plan"),
        generateVideo: countedTool("generate_video"),
        generateMusic: countedTool("generate_music_track"),
        generateFoley: countedTool("generate_foley_track"),
        assembleVideo: countedTool("assemble_final_video"),
        additionalTools: [noOpTool("get_video_run_status")],
      },
      frameworkOptions: { model, recursionLimit: 10 },
    });

    await assert.rejects(
      () => runner.run(prompt),
      (error: unknown) => error instanceof VideoAgentNoProgressError
        && /within 3 total attempt/.test(error.message)
        && /No Agnes request was submitted/.test(error.message),
    );

    assert.equal(mediaCalls, 0);
    assert.equal(await state.loadPlan(prompt), null);
    assert.equal((await state.loadManifest(prompt))?.status, "failed");

    const agentState = JSON.parse(
      await readFile(path.join(runDirectory, "agent-state.json"), "utf8"),
    ) as {
      run: { status: string; final_result: string | null; error_message: string | null };
      events: Array<{ event_type: string }>;
    };
    assert.equal(agentState.run.status, "failed");
    assert.equal(agentState.run.final_result, null);
    assert.notEqual(agentState.run.final_result, EMPTY_FRAMEWORK_FINAL_TEXT);
    assert.match(agentState.run.error_message ?? "", /without creating a validated video plan/i);
    assert.equal(agentState.events.at(-1)?.event_type, "agent_completion_rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejected-completion reset is compare-and-set guarded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-agent-completion-cas-"));
  const prompt = "Create a video of ocean waves.";
  const promptHash = hashUserPrompt(prompt);
  const runDirectory = path.join(root, promptHash);
  const database = new LocalFrameworkDatabase(runDirectory, promptHash);

  try {
    await database.createRun(promptHash, prompt, `run-${promptHash.slice(0, 16)}`, "nvidia");
    await database.setFinalResult(promptHash, "newer successful result");

    assert.equal(await database.reopenRejectedCompletion(
      promptHash,
      EMPTY_FRAMEWORK_FINAL_TEXT,
      "stale process",
    ), false);
    assert.equal((await database.getRun(promptHash))?.final_result, "newer successful result");

    assert.equal(await database.reopenRejectedCompletion(
      promptHash,
      "newer successful result",
      "host postcondition rejected it",
    ), true);
    assert.equal((await database.getRun(promptHash))?.status, "in_progress");
    assert.equal((await database.getRun(promptHash))?.final_result, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
