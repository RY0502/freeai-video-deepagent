import { AsyncLocalStorage } from "node:async_hooks";

import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { registerHarnessProfile, type HarnessProfileOptions } from "deepagents";
import { createMiddleware } from "langchain";

import { createVideoPlanningSystemPrompt } from "./systemPrompt.js";

let planningMiddlewareRegistered = false;

const VIDEO_RUN_STATUS_TOOL = "get_video_run_status";
const VALIDATE_VIDEO_PLAN_TOOL = "validate_video_plan";
const MAX_VIDEO_PLAN_VALIDATION_ATTEMPTS = 3;
const NEMOTRON_STRUCTURED_PLAN_MAX_TOKENS = 8_192;
const NEMOTRON_STRUCTURED_PLAN_TIMEOUT_MS = 120_000;

interface MutableStructuredPlanningModel {
  model?: unknown;
  modelName?: unknown;
  fields?: unknown;
  maxTokens?: unknown;
  timeout?: unknown;
  temperature?: unknown;
  modelKwargs?: unknown;
  invocationParams?: unknown;
  invoke?: unknown;
}

interface StructuredPlanningModelOverride {
  applied: boolean;
  model: unknown;
  maxTokens?: number;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Nemotron 3.5 enables reasoning by default. For a large forced tool call it
 * can spend the entire completion budget on hidden reasoning and return
 * `finish_reason=length` without emitting the tool call. NVIDIA recommends
 * disabling thinking for concise structured output. The framework does not
 * currently expose these constructor-level ChatOpenAI settings. ChatOpenAI
 * 1.5 also copies them into internal request clients at construction time, so
 * mutating the facade would not affect the wire request. Clone the one planning
 * model from its retained constructor fields instead; the original remains
 * untouched and concurrent runs cannot observe temporary mutations.
 */
function overrideStructuredPlanningModel(model: unknown): StructuredPlanningModelOverride {
  if (!isRecord(model)) return { applied: false, model };
  const mutable = model as MutableStructuredPlanningModel;
  const retainedFields = isRecord(mutable.fields) ? mutable.fields : undefined;
  const modelName = typeof mutable.model === "string"
    ? mutable.model
    : typeof mutable.modelName === "string"
      ? mutable.modelName
      : typeof retainedFields?.model === "string"
        ? retainedFields.model
      : "";
  if (!/nemotron-3(?:\.5)?-lightning/i.test(modelName)) {
    return { applied: false, model };
  }

  const retainedMaxTokens = retainedFields?.maxCompletionTokens
    ?? retainedFields?.maxTokens
    ?? mutable.maxTokens;
  const previousKwargs = retainedFields?.modelKwargs ?? mutable.modelKwargs;
  const previousKwargsRecord = isRecord(previousKwargs)
    ? previousKwargs
    : {};
  const previousTemplateKwargs = isRecord(previousKwargsRecord.chat_template_kwargs)
    ? previousKwargsRecord.chat_template_kwargs
    : {};
  const configuredMaxTokens = typeof retainedMaxTokens === "number"
    && Number.isFinite(retainedMaxTokens)
    ? Math.max(retainedMaxTokens, NEMOTRON_STRUCTURED_PLAN_MAX_TOKENS)
    : NEMOTRON_STRUCTURED_PLAN_MAX_TOKENS;

  const ModelConstructor = model.constructor;
  if (!retainedFields || typeof ModelConstructor !== "function") {
    return { applied: false, model };
  }

  try {
    const configuredModel = Reflect.construct(ModelConstructor, [{
      ...retainedFields,
      maxTokens: configuredMaxTokens,
      maxCompletionTokens: configuredMaxTokens,
      timeout: NEMOTRON_STRUCTURED_PLAN_TIMEOUT_MS,
      temperature: 0,
      modelKwargs: {
        ...previousKwargsRecord,
        chat_template_kwargs: {
          ...previousTemplateKwargs,
          enable_thinking: false,
        },
      },
    }]);
    if (!isRecord(configuredModel) || typeof configuredModel.invoke !== "function") {
      return { applied: false, model };
    }

    // Fail closed on unknown wrappers: log/use the override only after the
    // cloned model itself confirms the exact parameters its adapter will send.
    if (typeof configuredModel.invocationParams !== "function") {
      return { applied: false, model };
    }
    const invocationParams = Reflect.apply(
      configuredModel.invocationParams,
      configuredModel,
      [{}],
    );
    if (!isRecord(invocationParams)) return { applied: false, model };
    const effectiveMaxTokens = invocationParams.max_tokens
      ?? invocationParams.max_completion_tokens
      ?? invocationParams.max_output_tokens;
    const effectiveTemplateKwargs = isRecord(invocationParams.chat_template_kwargs)
      ? invocationParams.chat_template_kwargs
      : undefined;
    if (
      invocationParams.temperature !== 0
      || effectiveMaxTokens !== configuredMaxTokens
      || effectiveTemplateKwargs?.enable_thinking !== false
      || configuredModel.timeout !== NEMOTRON_STRUCTURED_PLAN_TIMEOUT_MS
    ) {
      return { applied: false, model };
    }

    return {
      applied: true,
      model: configuredModel,
      maxTokens: configuredMaxTokens,
      timeoutMs: NEMOTRON_STRUCTURED_PLAN_TIMEOUT_MS,
    };
  } catch {
    return { applied: false, model };
  }
}

export interface VideoPlanningAttemptBudget {
  validationAttempts: number;
  systemPrompt?: string;
}

const videoPlanningAttemptBudget = new AsyncLocalStorage<VideoPlanningAttemptBudget>();

export function createVideoPlanningAttemptBudget(systemPrompt?: string): VideoPlanningAttemptBudget {
  return { validationAttempts: 0, ...(systemPrompt ? { systemPrompt } : {}) };
}

export function withVideoPlanningAttemptBudget<T>(
  budget: VideoPlanningAttemptBudget,
  operation: () => Promise<T>,
): Promise<T> {
  return videoPlanningAttemptBudget.run(budget, operation);
}

export class VideoPlanningAttemptsExhaustedError extends Error {
  readonly code = "VIDEO_PLANNING_ATTEMPTS_EXHAUSTED";
  readonly attempts: number;
  readonly maxAttempts: number;

  constructor(attempts: number, maxAttempts = MAX_VIDEO_PLAN_VALIDATION_ATTEMPTS) {
    super(
      `Video plan validation failed ${attempts} times (maximum ${maxAttempts}); `
      + "stopped before media generation.",
    );
    this.name = "VideoPlanningAttemptsExhaustedError";
    this.attempts = attempts;
    this.maxAttempts = maxAttempts;
  }
}

function toolMessageText(message: ToolMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => typeof block === "string" ? block : JSON.stringify(block))
    .join("");
}

function hasAcceptedVideoPlan(messages: readonly BaseMessage[]): boolean {
  return [...messages].reverse().some((message) => {
    if (!ToolMessage.isInstance(message) || message.name !== VALIDATE_VIDEO_PLAN_TOOL) {
      return false;
    }
    if (message.status === "error") return false;

    const content = toolMessageText(message);
    try {
      const parsed = JSON.parse(content) as { valid?: unknown; status?: unknown };
      if (parsed.valid === false || parsed.status === "rejected") return false;
      if (parsed.valid === true || parsed.status === "stored" || parsed.status === "reused") {
        return true;
      }
    } catch {
      // Validator success is accepted only through its explicit JSON contract.
    }
    return false;
  });
}

function countVideoPlanValidationAttempts(messages: readonly BaseMessage[]): number {
  let calls = 0;
  let results = 0;

  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      calls += message.tool_calls?.filter(
        (call) => call.name === VALIDATE_VIDEO_PLAN_TOOL,
      ).length ?? 0;
    } else if (ToolMessage.isInstance(message) && message.name === VALIDATE_VIDEO_PLAN_TOOL) {
      results += 1;
    }
  }

  // A completed attempt normally appears twice in the transcript: once as an
  // AI tool call and once as its ToolMessage result. Taking the larger count
  // supports restored/compacted histories without double-counting them.
  return Math.max(calls, results);
}

function statusReportsStoredVideoPlan(messages: readonly BaseMessage[]): boolean {
  return [...messages].reverse().some((message) => {
    if (!ToolMessage.isInstance(message) || message.name !== VIDEO_RUN_STATUS_TOOL) {
      return false;
    }
    if (message.status === "error") return false;
    try {
      const parsed = JSON.parse(toolMessageText(message)) as { planStored?: unknown };
      return parsed.planStored === true;
    } catch {
      return false;
    }
  });
}

function latestVideoPlanRejection(messages: readonly BaseMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (!ToolMessage.isInstance(message) || message.name !== VALIDATE_VIDEO_PLAN_TOOL) continue;
    try {
      const parsed = JSON.parse(toolMessageText(message)) as {
        status?: unknown;
        code?: unknown;
        message?: unknown;
        issues?: unknown;
      };
      if (parsed.status !== "rejected") continue;
      const feedback = {
        ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
        ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
        ...(Array.isArray(parsed.issues) ? { issues: parsed.issues.slice(0, 6) } : {}),
      };
      return JSON.stringify(feedback).slice(0, 1_500);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const FALLBACK_VIDEO_PLANNING_PROMPT = createVideoPlanningSystemPrompt({
  tools: {
    validatePlan: VALIDATE_VIDEO_PLAN_TOOL,
    generateVideo: "generate_video",
    generateMusic: "generate_music_track",
    generateFoley: "generate_foley_track",
    assembleVideo: "assemble_final_video",
  },
  youtubeUploadRequested: false,
  youtubeUploadAuthorized: false,
});

/**
 * This bounded workflow needs one creative decision: the compact video plan.
 * Force that exact tool from the first model turn rather than spending remote
 * calls on generic todo/status choreography. Once the plan is durable, return
 * control to the host, which executes every receipt-aware media stage.
 */
export function videoPlanContinuationMiddleware() {
  return createMiddleware({
    name: "videoPlanContinuationMiddleware",
    wrapModelCall: async (request, handler) => {
      const validatePlanTool = request.tools.find(
        (tool) => tool.name === VALIDATE_VIDEO_PLAN_TOOL,
      );
      const messages = request.messages;
      const acceptedPlan = hasAcceptedVideoPlan(messages);
      const storedPlanReported = statusReportsStoredVideoPlan(messages);

      // Planning is now the model's only responsibility. Once local state says
      // the plan exists, stop asking the remote model to choose more tools;
      // the host advances every receipt-aware media stage deterministically.
      if (acceptedPlan || storedPlanReported) {
        return new AIMessage(
          "The validated video plan is stored. The host will continue the media workflow from durable local state.",
        );
      }
      if (!validatePlanTool) return handler(request);

      const invocationBudget = videoPlanningAttemptBudget.getStore();
      const validationAttempts = Math.max(
        countVideoPlanValidationAttempts(messages),
        invocationBudget?.validationAttempts ?? 0,
      );

      const requiredTool = validatePlanTool;
      const requiredToolName = VALIDATE_VIDEO_PLAN_TOOL;
      if (
        requiredToolName === VALIDATE_VIDEO_PLAN_TOOL
        && validationAttempts >= MAX_VIDEO_PLAN_VALIDATION_ATTEMPTS
      ) {
        console.error(`[video-agent] ${JSON.stringify({
          event: "video_plan_validation_attempts_exhausted",
          attempts: validationAttempts,
          maxAttempts: MAX_VIDEO_PLAN_VALIDATION_ATTEMPTS,
          reason: "no_plan_accepted",
        })}`);
        throw new VideoPlanningAttemptsExhaustedError(validationAttempts);
      }

      const requirement = `Your next response must be exactly one ${VALIDATE_VIDEO_PLAN_TOOL} tool call containing the compact creative director draft as a real object. `
        + "Do not stringify it or add host-derived IDs, exact timestamps, delivery settings, or music windows. ";
      const priorRejection = latestVideoPlanRejection(messages);
      const planningSystemPrompt = invocationBudget?.systemPrompt
        ?? FALLBACK_VIDEO_PLANNING_PROMPT;
      const boundedSystemPrompt = planningSystemPrompt
        + "\n\nRequired response: "
        + requirement
        + "Do not narrate the plan, update todos, delegate it, or end the task."
        + (priorRejection
          ? `\nCorrect this exact validator feedback in the next draft: ${priorRejection}`
          : "");

      const planOnlyRequest = {
        ...request,
        tools: [requiredTool],
        // The validator now exposes only the compact creative-draft schema;
        // host code derives the former deeply nested timing/delivery fields.
        // Always force the concrete function by name. NVIDIA NIM currently
        // accepts this form for the status tool but can return HTTP 500 for
        // the generic `required` value when the remaining tool has a nested
        // JSON schema. A named choice has the same one-tool guarantee without
        // relying on that provider-sensitive mode.
        toolChoice: {
          type: "function" as const,
          function: { name: requiredToolName },
        },
        modelSettings: {
          ...(request.modelSettings ?? {}),
          // ChatOpenAI otherwise retries a single 5xx up to six times before
          // the host sees it. The bounded host loop owns provider retries so
          // each visible attempt must correspond to exactly one HTTP request.
          maxRetries: 0,
          parallel_tool_calls: false,
        },
        // Replace DeepAgent's general-purpose research/todo prompt on the
        // actual model request. The host needs one bounded creative object,
        // not the generic agent's tools, subagents, and execution policy.
        systemMessage: new SystemMessage(boundedSystemPrompt),
      };

      const modelOverride = overrideStructuredPlanningModel(request.model);
      planOnlyRequest.model = modelOverride.model as typeof request.model;
      console.log(`[video-agent] ${JSON.stringify({
        event: "video_plan_continuation_enforced",
        tool: requiredToolName,
        toolChoice: "named",
        parallelToolCalls: false,
        sdkRetries: 0,
        systemPromptChars: boundedSystemPrompt.length,
        ...(modelOverride.applied
          ? {
              thinkingEnabled: false,
              maxOutputTokens: modelOverride.maxTokens,
              requestTimeoutMs: modelOverride.timeoutMs,
            }
          : {}),
        ...(requiredToolName === VALIDATE_VIDEO_PLAN_TOOL
          ? {
              attemptNumber: validationAttempts + 1,
              maxAttempts: MAX_VIDEO_PLAN_VALIDATION_ATTEMPTS,
            }
          : {}),
        reason: "validated_plan_missing",
      })}`);

      const requestStartedAt = Date.now();
      let response: Awaited<ReturnType<typeof handler>>;
      try {
        response = await handler(planOnlyRequest);
      } catch (error) {
        console.error(`[video-agent] ${JSON.stringify({
          event: "video_plan_model_request_failed",
          elapsedMs: Date.now() - requestStartedAt,
          attemptNumber: validationAttempts + 1,
          reason: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
        })}`);
        throw error;
      }
      const responseMetadata = AIMessage.isInstance(response)
        && isRecord(response.response_metadata)
        ? response.response_metadata
        : undefined;
      const rawUsageMetadata = AIMessage.isInstance(response)
        ? (response as unknown as { usage_metadata?: unknown }).usage_metadata
        : undefined;
      const usageMetadata = isRecord(rawUsageMetadata) ? rawUsageMetadata : undefined;
      console.log(`[video-agent] ${JSON.stringify({
        event: "video_plan_model_response",
        elapsedMs: Date.now() - requestStartedAt,
        attemptNumber: validationAttempts + 1,
        toolCallCount: AIMessage.isInstance(response) ? response.tool_calls?.length ?? 0 : 0,
        invalidToolCallCount: AIMessage.isInstance(response) ? response.invalid_tool_calls?.length ?? 0 : 0,
        ...(typeof responseMetadata?.finish_reason === "string"
          ? { finishReason: responseMetadata.finish_reason }
          : {}),
        ...(usageMetadata
          ? {
              inputTokens: usageMetadata.input_tokens,
              outputTokens: usageMetadata.output_tokens,
              totalTokens: usageMetadata.total_tokens,
            }
          : {}),
      })}`);
      const responseValidationCalls = requiredToolName === VALIDATE_VIDEO_PLAN_TOOL
        && AIMessage.isInstance(response)
        ? response.tool_calls?.filter(
          (call) => call.name === VALIDATE_VIDEO_PLAN_TOOL,
        ).length ?? 0
        : 0;
      if (
        responseValidationCalls > 0
        && validationAttempts + responseValidationCalls > MAX_VIDEO_PLAN_VALIDATION_ATTEMPTS
      ) {
        // Do not let ToolNode execute beyond the invocation ceiling. Treat the
        // remaining slot as consumed rather than execute an arbitrary subset of
        // parallel drafts from one model response.
        if (invocationBudget) {
          invocationBudget.validationAttempts = MAX_VIDEO_PLAN_VALIDATION_ATTEMPTS;
        }
        console.error(`[video-agent] ${JSON.stringify({
          event: "video_plan_validation_attempts_exhausted",
          attempts: MAX_VIDEO_PLAN_VALIDATION_ATTEMPTS,
          maxAttempts: MAX_VIDEO_PLAN_VALIDATION_ATTEMPTS,
          proposedToolCalls: responseValidationCalls,
          reason: "response_would_exceed_attempt_limit",
        })}`);
        throw new VideoPlanningAttemptsExhaustedError(
          MAX_VIDEO_PLAN_VALIDATION_ATTEMPTS,
        );
      }
      if (responseValidationCalls > 0 && invocationBudget) {
        // Keep the ceiling invocation-wide even when the host discards a
        // completed no-progress LangGraph transcript and retries planning.
        invocationBudget.validationAttempts = Math.max(
          invocationBudget.validationAttempts,
          validationAttempts + responseValidationCalls,
        );
      }
      return response;
    },
  });
}

/**
 * Register the video-specific planning boundary for every OpenAI-compatible
 * model that the framework constructs. The generic DeepAgent todo middleware
 * is intentionally not duplicated here: this workflow has one forced planning
 * tool call, followed by deterministic host execution.
 */
export function ensureDeepAgentPlanningMiddleware(): void {
  if (planningMiddlewareRegistered) return;
  // LangChain's concrete middleware tool tuple is narrower than Deep Agents'
  // public profile type across their dual Zod v3/v4 declarations. Both packages
  // share one deduplicated runtime; keep the compatibility cast at this seam.
  const extraMiddleware = (() => [
    videoPlanContinuationMiddleware(),
  ]) as unknown as NonNullable<
    HarnessProfileOptions["extraMiddleware"]
  >;
  registerHarnessProfile("openai", {
    extraMiddleware,
  });
  planningMiddlewareRegistered = true;
}
