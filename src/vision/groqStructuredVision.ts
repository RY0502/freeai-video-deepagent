import {
  ErrorKind,
  HttpError,
  type LlmInput,
  type Provider,
} from "@freetier/orchestrator";

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const INDEXED_GROQ_KEY = /^GROQ_API_KEY_(\d+)$/;

interface GroqChatResponse {
  error?: string | { message?: string };
  choices?: Array<{ message?: { content?: string } }>;
}

export interface GroqStructuredVisionProviderOptions {
  apiKey: string;
  model: string;
  requestTimeoutMs: number;
  maxCompletionTokens: number;
  providerName?: string;
  maxRateLimitRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function normalizeGroqVisionApiKeys(values: readonly (string | undefined)[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const candidate of values) {
    const key = candidate?.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** Discover numbered Groq keys in numeric order, with the singular key as fallback. */
export function loadGroqVisionApiKeys(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const indexed = normalizeGroqVisionApiKeys(Object.entries(env)
    .map(([name, value]) => {
      const match = INDEXED_GROQ_KEY.exec(name);
      return match ? { index: Number(match[1]), value } : undefined;
    })
    .filter((entry): entry is { index: number; value: string | undefined } => Boolean(entry))
    .sort((left, right) => left.index - right.index)
    .map(({ value }) => value));
  return indexed.length > 0 ? indexed : normalizeGroqVisionApiKeys([env.GROQ_API_KEY]);
}

const defaultSleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

/**
 * The generic orchestrator adapter cannot set Groq's reasoning or JSON modes.
 * This narrow provider uses Groq's documented non-thinking JSON-object options,
 * preventing Qwen reasoning traces from consuming the response before the cue
 * object is emitted.
 */
export function createGroqStructuredVisionProvider(
  options: GroqStructuredVisionProviderOptions,
): Provider<LlmInput, string> {
  const apiKey = options.apiKey.trim();
  const model = options.model.trim();
  if (!apiKey) throw new Error("A Groq API key is required for structured vision.");
  if (!model) throw new Error("A Groq vision model is required for structured vision.");
  if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1_000) {
    throw new Error("Groq structured-vision timeout must be at least 1000ms.");
  }
  if (!Number.isInteger(options.maxCompletionTokens) || options.maxCompletionTokens < 256) {
    throw new Error("Groq structured-vision maxCompletionTokens must be at least 256.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const providerName = options.providerName?.trim() || "Groq";
  const maxRateLimitRetries = options.maxRateLimitRetries ?? 2;
  if (!Number.isInteger(maxRateLimitRetries) || maxRateLimitRetries < 0 || maxRateLimitRetries > 5) {
    throw new Error("Groq structured-vision maxRateLimitRetries must be between 0 and 5.");
  }
  return {
    name: providerName,
    getModelConfig: () => ({ textModel: model, visionModel: model }),
    classifyError(error) {
      return error instanceof HttpError && error.status === 429
        ? ErrorKind.Retryable
        : undefined;
    },
    async invoke(input) {
      if (!input.imageBase64) throw new Error("Groq structured vision requires an image.");
      const mimeType = input.mimeType?.trim() || "image/jpeg";
      const body = JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: options.maxCompletionTokens,
        stream: false,
        reasoning_effort: "none",
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `${input.system}\n\n${input.prompt}` },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${input.imageBase64}` },
            },
          ],
        }],
      });
      for (let attempt = 0; attempt <= maxRateLimitRetries; attempt += 1) {
        const response = await fetchImpl(GROQ_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(options.requestTimeoutMs),
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 2_000);
          const retryAfterText = /try again in\s+([\d.]+)s/i.exec(detail)?.[1];
          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfterSeconds = Number.parseFloat(retryAfterText ?? retryAfterHeader ?? "");
          if (
            response.status === 429
            && Number.isFinite(retryAfterSeconds)
            && retryAfterSeconds > 0
            && retryAfterSeconds <= 60
            && attempt < maxRateLimitRetries
          ) {
            await sleep((Math.ceil(retryAfterSeconds) + 1) * 1_000);
            continue;
          }
          const errorCode = /"code"\s*:\s*"([^"]+)"/i.exec(detail)?.[1];
          throw new HttpError(
            response.status,
            `Groq API error (${response.status})`
              + (errorCode ? `: ${errorCode}` : "")
              + (Number.isFinite(retryAfterSeconds) ? `; provider retry after ${retryAfterSeconds}s` : ""),
          );
        }
        const payload = await response.json() as GroqChatResponse;
        if (payload.error) {
          const message = typeof payload.error === "string"
            ? payload.error
            : payload.error.message ?? "Unknown Groq error";
          throw new Error(`Groq API error: ${message}`);
        }
        const content = payload.choices?.[0]?.message?.content?.trim();
        if (!content) throw new Error(`Groq returned an empty response (model: ${model}).`);
        return content;
      }
      throw new Error("Groq structured vision exhausted its bounded retry cycle.");
    },
  };
}
