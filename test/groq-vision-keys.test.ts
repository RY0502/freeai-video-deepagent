import assert from "node:assert/strict";
import test from "node:test";

import {
  createFoleyVisionClient,
  createGroqStructuredVisionProvider,
  loadGroqVisionApiKeys,
} from "../src/vision/index.js";

test("discovers numbered Groq vision keys numerically with gaps and deduplication", () => {
  assert.deepEqual(loadGroqVisionApiKeys({
    GROQ_API_KEY: "singular-is-only-a-fallback",
    GROQ_API_KEY_8: "third",
    GROQ_API_KEY_2: "second",
    GROQ_API_KEY_1: "first",
    GROQ_API_KEY_5: "second",
    GROQ_API_KEY_BAD: "ignored",
  }), ["first", "second", "third"]);
  assert.deepEqual(loadGroqVisionApiKeys({ GROQ_API_KEY: " singular " }), ["singular"]);
});

test("structured Groq vision advances to the next numbered key after bounded 429 retries", async () => {
  let firstCalls = 0;
  let secondCalls = 0;
  const first = createGroqStructuredVisionProvider({
    apiKey: "first-key",
    model: "qwen/qwen3.6-27b",
    providerName: "Groq key-1",
    requestTimeoutMs: 5_000,
    maxCompletionTokens: 512,
    maxRateLimitRetries: 0,
    fetchImpl: (async () => {
      firstCalls += 1;
      return new Response(JSON.stringify({
        error: { message: "Rate limit exhausted", code: "rate_limit_exceeded" },
      }), { status: 429, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const second = createGroqStructuredVisionProvider({
    apiKey: "second-key",
    model: "qwen/qwen3.6-27b",
    providerName: "Groq key-2",
    requestTimeoutMs: 5_000,
    maxCompletionTokens: 512,
    maxRateLimitRetries: 0,
    fetchImpl: (async () => {
      secondCalls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"cues":[]}' } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const client = createFoleyVisionClient([first, second]);
  const result = await client.analyze({
    system: "Return JSON.",
    prompt: "Inspect.",
    imageBase64: "ZmFrZS1qcGVn",
    mimeType: "image/jpeg",
  }, (text) => { assert.deepEqual(JSON.parse(text), { cues: [] }); });

  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
  assert.equal(result.provider, "Groq key-2");
});
