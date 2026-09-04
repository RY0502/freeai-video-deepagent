import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AGNES_CREATE_VIDEO_URL,
  AGNES_RETRIEVE_VIDEO_URL,
  AGNES_VIDEO_MODEL,
  AgnesError,
  AgnesVideoClient,
  DEFAULT_AGNES_REQUEST_TIMEOUT_MS,
  completedAgnesVideoUrl,
  fingerprintAgnesKey,
  isAgnesProviderCapacityRejection,
  loadAgnesApiKeys,
  type AgnesFetch,
  type AgnesVideoTask,
} from "../src/agnes/index.js";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function authorization(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

function providerTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "video-object-1",
    task_id: "task-1",
    video_id: "video-1",
    object: "video",
    model: AGNES_VIDEO_MODEL,
    status: "queued",
    progress: 0,
    created_at: 1_788_000_000,
    seconds: "8",
    size: "720P",
    ...overrides,
  };
}

function persistedTask(key: string, overrides: Partial<AgnesVideoTask> = {}): AgnesVideoTask {
  return {
    id: "video-object-1",
    task_id: "task-1",
    video_id: "video-1",
    model: AGNES_VIDEO_MODEL,
    status: "queued",
    progress: 0,
    keyLabel: "key-1",
    keyFingerprint: fingerprintAgnesKey(key),
    ...overrides,
  };
}

async function withTempDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "agnes-client-test-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("discovers numeric, gapped, deduplicated Agnes keys and falls back to singular", () => {
  assert.deepEqual(loadAgnesApiKeys({
    AGNES_API_KEY_10: " ten ",
    AGNES_API_KEY_2: "two",
    AGNES_API_KEY_7: "two",
    AGNES_API_KEY: "ignored-when-numbered-exist",
    AGNES_API_KEY_X: "ignored",
  }), ["two", "ten"]);
  assert.deepEqual(loadAgnesApiKeys({ AGNES_API_KEY: " singular " }), ["singular"]);
  assert.deepEqual(loadAgnesApiKeys({ AGNES_API_KEY_4: " ", AGNES_API_KEY: "fallback" }), [
    "fallback",
  ]);
});

test("submits the exact Agnes Video 2.5 Flash payload and returns a durable key-bound receipt", async () => {
  const secret = "agnes-secret-key";
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = new AgnesVideoClient({
    env: { AGNES_API_KEY_3: secret },
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(providerTask());
    },
  });

  const task = await client.submitVideo({
    prompt: "  A tiger crosses a rain-soaked clearing  ",
    seconds: 12,
    aspectRatio: "21:9",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, AGNES_CREATE_VIDEO_URL);
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(authorization(calls[0]?.init), `Bearer ${secret}`);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    model: "agnes-video-2.5-flash",
    prompt: "A tiger crosses a rain-soaked clearing",
    seconds: "12",
    mode: "text",
    size: "720P",
    aspect_ratio: "21:9",
    n: 1,
  });
  assert.equal(task.id, "video-object-1");
  assert.equal(task.task_id, "task-1");
  assert.equal(task.video_id, "video-1");
  assert.equal(task.status, "queued");
  assert.equal(task.progress, 0);
  assert.equal(task.keyLabel, "key-1");
  assert.equal(task.keyFingerprint, createHash("sha256").update(secret).digest("hex"));
  assert.equal(task.keyFingerprint.length, 64);
  assert.doesNotMatch(JSON.stringify(task), new RegExp(secret));
});

test("derives create and retrieval endpoints from an optional origin or documented v1 base", async () => {
  for (const baseUrl of ["https://agnes.proxy.test", "https://agnes.proxy.test/v1/"]) {
    const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
    const client = new AgnesVideoClient({
      apiKeys: ["custom-host-key"],
      baseUrl,
      fetch: async (input, init) => {
        calls.push({ url: String(input), signal: init?.signal });
        return calls.length === 1
          ? jsonResponse(providerTask())
          : jsonResponse(providerTask({ status: "in_progress", progress: 10 }));
      },
    });
    const submitted = await client.submitVideo({
      prompt: "Night train",
      seconds: 6,
      aspectRatio: "16:9",
    });
    await client.retrieveVideo(submitted);

    assert.deepEqual(calls.map(({ url }) => url), [
      "https://agnes.proxy.test/v1/videos",
      "https://agnes.proxy.test/agnesapi?video_id=video-1&model_name=agnes-video-2.5-flash",
    ]);
    assert.equal(calls.every(({ signal }) => signal instanceof AbortSignal), true);
    assert.equal(calls.every(({ signal }) => signal?.aborted === false), true);
  }
  assert.equal(DEFAULT_AGNES_REQUEST_TIMEOUT_MS, 60_000);
});

test("rotates each deduplicated key once for definite credit, quota, daily, and rate rejection", async () => {
  const rotatableResponses: Array<{ body: unknown; status: number }> = [
    { body: { error: { code: "insufficient_credits", message: "Insufficient credits" } }, status: 402 },
    { body: { code: "quota_exceeded", message: "Quota exceeded" }, status: 400 },
    { body: { detail: { code: "daily_limit", message: "Daily credit limit reached" } }, status: 400 },
    { body: { code: "rate_limit", message: "Rate limited" }, status: 400 },
    { body: { message: "Try later" }, status: 429 },
    {
      body: providerTask({
        status: "failed",
        progress: 0,
        error: { code: "credits_exhausted", message: "Credits exhausted" },
      }),
      status: 200,
    },
  ];

  for (const rejected of rotatableResponses) {
    const bearerValues: Array<string | null> = [];
    const bodies: string[] = [];
    const labels: string[] = [];
    let call = 0;
    const client = new AgnesVideoClient({
      apiKeys: ["first-key", "first-key", "second-key"],
      fetch: async (_input, init) => {
        bearerValues.push(authorization(init));
        bodies.push(String(init?.body));
        return call++ === 0
          ? jsonResponse(rejected.body, rejected.status)
          : jsonResponse(providerTask());
      },
    });

    const task = await client.submitVideo({
      prompt: "Coastal drive",
      seconds: 4,
      aspectRatio: "16:9",
      onAttempt: ({ keyLabel }) => labels.push(keyLabel),
    });
    assert.deepEqual(bearerValues, ["Bearer first-key", "Bearer second-key"]);
    assert.deepEqual(labels, ["key-1", "key-2"]);
    assert.equal(new Set(bodies).size, 1);
    assert.equal(task.keyLabel, "key-2");
    assert.equal(task.keyFingerprint, fingerprintAgnesKey("second-key"));
  }
});

test("does not rotate authentication, validation, network, 5xx, or ambiguous success responses", async () => {
  const cases: Array<{
    expectedKind: AgnesError["kind"];
    expectedAmbiguous: boolean;
    response?: () => Response;
    networkError?: Error;
  }> = [
    {
      expectedKind: "authentication",
      expectedAmbiguous: false,
      response: () => jsonResponse({ error: { code: "invalid_api_key", message: "Invalid key" } }, 401),
    },
    {
      expectedKind: "authentication",
      expectedAmbiguous: false,
      response: () => jsonResponse({ error: "Invalid key; video queue is full" }, 401),
    },
    {
      expectedKind: "validation",
      expectedAmbiguous: false,
      response: () => jsonResponse({ error: { code: "validation_error", message: "Bad prompt" } }, 422),
    },
    {
      expectedKind: "network",
      expectedAmbiguous: true,
      networkError: new Error("socket reset while using first-secret"),
    },
    {
      expectedKind: "provider",
      expectedAmbiguous: true,
      response: () => jsonResponse({ code: "rate_limit", message: "Internal rate limiter failed" }, 503),
    },
    {
      expectedKind: "provider",
      expectedAmbiguous: true,
      response: () => jsonResponse({ code: "queue_full", message: "Video queue is full" }, 503),
    },
    {
      expectedKind: "ambiguous_submission",
      expectedAmbiguous: true,
      response: () => jsonResponse({ status: "accepted maybe", message: "Please check later" }),
    },
  ];

  for (const scenario of cases) {
    let calls = 0;
    const client = new AgnesVideoClient({
      apiKeys: ["first-secret", "second-secret"],
      fetch: async () => {
        calls += 1;
        if (scenario.networkError) throw scenario.networkError;
        return scenario.response?.() ?? jsonResponse({}, 500);
      },
    });
    await assert.rejects(
      client.submitVideo({ prompt: "Forest rain", seconds: 8, aspectRatio: "9:16" }),
      (error: unknown) => {
        assert.ok(error instanceof AgnesError);
        assert.equal(error.kind, scenario.expectedKind);
        assert.equal(error.ambiguousOutcome, scenario.expectedAmbiguous);
        assert.doesNotMatch(error.message, /first-secret|second-secret/);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("treats an explicit queue-full response without a task ID as a safe later resubmission", async () => {
  assert.equal(isAgnesProviderCapacityRejection("video queue is full, please retry later"), true);
  assert.equal(isAgnesProviderCapacityRejection("temporarily unavailable, please retry later"), false);
  let calls = 0;
  const client = new AgnesVideoClient({
    apiKeys: ["first-secret", "second-secret"],
    fetch: async () => {
      calls += 1;
      return jsonResponse({
        code: "queue_full",
        error: "video queue is full, please retry later",
        retry_after: 30,
      });
    },
  });

  await assert.rejects(
    client.submitVideo({ prompt: "Factory robots", seconds: 11, aspectRatio: "16:9" }),
    (error: unknown) => {
      assert.ok(error instanceof AgnesError);
      assert.equal(error.kind, "provider_capacity");
      assert.equal(error.ambiguousOutcome, false);
      assert.equal(error.mayTryAnotherKey, false);
      assert.equal(error.rotationExhausted, false);
      assert.equal(error.retryAfterMs, 30_000);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("aborts timed-out submissions without rotating and marks their outcome ambiguous", async () => {
  let calls = 0;
  let capturedSignal: AbortSignal | null | undefined;
  const client = new AgnesVideoClient({
    apiKeys: ["timeout-secret-one", "timeout-secret-two"],
    requestTimeoutMs: 5,
    fetch: async (_input, init) => {
      calls += 1;
      capturedSignal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted timeout-secret-one"));
        }, { once: true });
      });
    },
  });

  await assert.rejects(
    client.submitVideo({ prompt: "Long shot", seconds: 8, aspectRatio: "16:9" }),
    (error: unknown) => {
      assert.ok(error instanceof AgnesError);
      assert.equal(error.kind, "timeout");
      assert.equal(error.ambiguousOutcome, true);
      assert.equal(error.mayTryAnotherKey, false);
      assert.equal(error.keyLabel, "key-1");
      assert.doesNotMatch(error.message, /timeout-secret/);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(capturedSignal?.aborted, true);
});

test("aborts timed-out retrieval with the persisted key and never switches keys", async () => {
  const bearerValues: Array<string | null> = [];
  let capturedSignal: AbortSignal | null | undefined;
  const client = new AgnesVideoClient({
    apiKeys: ["first-key", "resume-secret", "third-key"],
    requestTimeoutMs: 5,
    fetch: async (_input, init) => {
      bearerValues.push(authorization(init));
      capturedSignal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("timed out")), {
          once: true,
        });
      });
    },
  });

  await assert.rejects(
    client.retrieveVideo(persistedTask("resume-secret")),
    (error: unknown) => {
      assert.ok(error instanceof AgnesError);
      assert.equal(error.kind, "timeout");
      assert.equal(error.ambiguousOutcome, false);
      assert.equal(error.keyLabel, "key-2");
      return true;
    },
  );
  assert.deepEqual(bearerValues, ["Bearer resume-secret"]);
  assert.equal(capturedSignal?.aborted, true);
});

test("marks exhaustion only after every configured key rejected once", async () => {
  let calls = 0;
  const client = new AgnesVideoClient({
    apiKeys: ["one", "two", "one"],
    fetch: async () => {
      calls += 1;
      return jsonResponse({ code: "rate_limit", message: "Rate limited", retry_after: 30 }, 429);
    },
  });
  await assert.rejects(
    client.submitVideo({ prompt: "Aerial city", seconds: 6, aspectRatio: "4:3" }),
    (error: unknown) => {
      assert.ok(error instanceof AgnesError);
      assert.equal(error.kind, "rate_limit");
      assert.equal(error.rotationExhausted, true);
      assert.equal(error.retryAfterMs, 30_000);
      assert.equal(error.keyLabel, "key-2");
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("retrieval resolves the persisted fingerprint to the exact original key and never switches", async () => {
  const calls: Array<{ url: string; bearer: string | null }> = [];
  const client = new AgnesVideoClient({
    apiKeys: ["first-key", "submission-key", "third-key"],
    fetch: async (input, init) => {
      calls.push({ url: String(input), bearer: authorization(init) });
      return jsonResponse(providerTask({ status: "in_progress", progress: 45 }));
    },
  });
  const resumed = await client.retrieveVideo(persistedTask("submission-key", {
    keyLabel: "old-local-label",
  }));

  assert.deepEqual(calls, [{
    url: `${AGNES_RETRIEVE_VIDEO_URL}?video_id=video-1&model_name=agnes-video-2.5-flash`,
    bearer: "Bearer submission-key",
  }]);
  assert.equal(resumed.keyLabel, "key-2");
  assert.equal(resumed.keyFingerprint, fingerprintAgnesKey("submission-key"));
  assert.equal(resumed.status, "in_progress");

  let failedCalls = 0;
  const rateLimited = new AgnesVideoClient({
    apiKeys: ["first-key", "submission-key", "third-key"],
    fetch: async () => {
      failedCalls += 1;
      return jsonResponse({ message: "Rate limited" }, 429);
    },
  });
  await assert.rejects(
    rateLimited.retrieveVideo(persistedTask("submission-key")),
    (error: unknown) => error instanceof AgnesError && error.kind === "rate_limit",
  );
  assert.equal(failedCalls, 1);
});

test("polls immediately at 30-second intervals through the inclusive eight-minute window", async () => {
  let instant = 0;
  const sleeps: number[] = [];
  const polls: number[] = [];
  let retrievals = 0;
  const client = new AgnesVideoClient({
    apiKeys: ["poll-key"],
    now: () => instant,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      instant += milliseconds;
    },
    fetch: async () => {
      retrievals += 1;
      return jsonResponse(providerTask({ status: "in_progress", progress: retrievals }));
    },
  });

  const result = await client.pollUntilTerminal(persistedTask("poll-key"), {
    onPoll: async (task) => {
      await Promise.resolve();
      polls.push(task.progress);
    },
  });

  assert.equal(result.outcome, "timed_out");
  assert.equal(result.task.progress, 17);
  assert.equal(retrievals, 17);
  assert.deepEqual(sleeps, Array.from({ length: 16 }, () => 30_000));
  assert.deepEqual(polls, Array.from({ length: 17 }, (_, index) => index + 1));
  assert.equal(instant, 480_000);
});

test("transient retrieval failures are logged and retried inside the same polling window", async () => {
  let instant = 0;
  let retrievals = 0;
  const failures: string[] = [];
  const client = new AgnesVideoClient({
    apiKeys: ["poll-key"],
    now: () => instant,
    sleep: async (milliseconds) => { instant += milliseconds; },
    pollIntervalMs: 30_000,
    pollWindowMs: 60_000,
    fetch: async () => {
      retrievals += 1;
      if (retrievals < 3) throw new Error("temporary connection loss");
      return jsonResponse(providerTask({
        status: "completed",
        progress: 100,
        metadata: { url: "https://cdn.agnes.test/final.mp4" },
      }));
    },
  });
  const result = await client.pollUntilTerminal(persistedTask("poll-key"), {
    onPollError: (error) => { failures.push(error.kind); },
  });
  assert.equal(result.outcome, "completed");
  assert.equal(retrievals, 3);
  assert.deepEqual(failures, ["network", "network"]);
  assert.equal(instant, 60_000);
});

test("keeps polling completed responses until the output URL materializes", async () => {
  let instant = 0;
  let retrievals = 0;
  const completedSnapshots: Array<string | undefined> = [];
  const finalUrl = "https://cdn.agnes.test/delayed-output.mp4";
  const client = new AgnesVideoClient({
    apiKeys: ["poll-key"],
    now: () => instant,
    sleep: async (milliseconds) => { instant += milliseconds; },
    pollIntervalMs: 30_000,
    pollWindowMs: 60_000,
    fetch: async () => {
      retrievals += 1;
      return jsonResponse(providerTask({
        status: "completed",
        progress: 100,
        ...(retrievals === 1 ? {} : { url: finalUrl }),
      }));
    },
  });

  const result = await client.pollUntilTerminal(persistedTask("poll-key"), {
    onPoll: (task) => { completedSnapshots.push(task.metadata?.url); },
  });
  assert.equal(result.outcome, "completed");
  assert.equal(retrievals, 2);
  assert.equal(instant, 30_000);
  assert.deepEqual(completedSnapshots, [undefined, finalUrl]);
  assert.equal(completedAgnesVideoUrl(result.task), finalUrl);
});

test("returns resumable timeout when completed output URL stays unavailable", async () => {
  let instant = 0;
  let retrievals = 0;
  const client = new AgnesVideoClient({
    apiKeys: ["poll-key"],
    now: () => instant,
    sleep: async (milliseconds) => { instant += milliseconds; },
    pollIntervalMs: 30_000,
    pollWindowMs: 60_000,
    fetch: async () => {
      retrievals += 1;
      return jsonResponse(providerTask({ status: "completed", progress: 100 }));
    },
  });

  const result = await client.pollUntilTerminal(persistedTask("poll-key"));
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.task.status, "completed");
  assert.equal(result.task.metadata?.url, undefined);
  assert.equal(retrievals, 3);
  assert.equal(instant, 60_000);
});

test("poll accepts documented metadata.url and the live top-level completed url", async () => {
  let calls = 0;
  const finalUrl = "https://cdn.agnes.test/final.mp4?token=capability";
  const client = new AgnesVideoClient({
    apiKeys: ["poll-key"],
    sleep: async () => undefined,
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(providerTask({ status: "in_progress", progress: 70 }))
        : jsonResponse(providerTask({
            status: "completed",
            progress: 100,
            url: "https://wrong.example/top-level.mp4",
            output_url: "https://wrong.example/output.mp4",
            metadata: { url: finalUrl },
          }));
    },
  });
  let clock = 0;
  const result = await client.pollUntilTerminal(persistedTask("poll-key"), {
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });
  assert.equal(result.outcome, "completed");
  assert.equal(completedAgnesVideoUrl(result.task), finalUrl);

  const liveResponseUrl = "https://cdn.agnes.test/live-response.mp4?token=capability";
  const liveShapeClient = new AgnesVideoClient({
    apiKeys: ["poll-key"],
    fetch: async () => jsonResponse(providerTask({
      status: "completed",
      progress: 100,
      url: liveResponseUrl,
    })),
  });
  const liveShape = await liveShapeClient.retrieveVideo(persistedTask("poll-key"));
  assert.equal(completedAgnesVideoUrl(liveShape), liveResponseUrl);

  const unsupportedAliasClient = new AgnesVideoClient({
    apiKeys: ["poll-key"],
    fetch: async () => jsonResponse(providerTask({
      status: "completed",
      progress: 100,
      output_url: "https://wrong.example/output.mp4",
    })),
  });
  const unsupportedAlias = await unsupportedAliasClient.retrieveVideo(persistedTask("poll-key"));
  assert.throws(
    () => completedAgnesVideoUrl(unsupportedAlias),
    (error: unknown) => error instanceof AgnesError && /output URL/.test(error.message),
  );
  assert.throws(
    () => completedAgnesVideoUrl(persistedTask("poll-key", {
      status: "completed",
      progress: 100,
      metadata: { url: "http://cdn.agnes.test/insecure.mp4" },
    })),
    (error: unknown) => error instanceof AgnesError && /HTTPS/.test(error.message),
  );
});

test("atomically downloads bounded completed media without forwarding API authorization", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = join(directory, "nested", "video.mp4");
    const media = Buffer.from("finished-agnes-video");
    const mediaUrl = "https://cdn.agnes.test/video.mp4?signed=secret-capability";
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const client = new AgnesVideoClient({
      apiKeys: ["agnes-api-secret"],
      fetch: async (input, init) => {
        calls.push({ url: String(input), authorization: authorization(init) });
        return new Response(media, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      },
    });
    const task = persistedTask("agnes-api-secret", {
      status: "completed",
      progress: 100,
      metadata: { url: mediaUrl },
    });

    const result = await client.downloadCompletedVideo(task, outputPath, { maxBytes: 128 });

    assert.deepEqual(calls, [{ url: mediaUrl, authorization: null }]);
    assert.equal(await readFile(outputPath, "utf8"), media.toString());
    assert.deepEqual(await readdir(join(directory, "nested")), ["video.mp4"]);
    assert.equal(result.outputPath, outputPath);
    assert.equal(result.bytes, media.byteLength);
    assert.equal(result.sha256, createHash("sha256").update(media).digest("hex"));
    assert.equal(result.contentType, "video/mp4");

    await writeFile(outputPath, "keep-existing");
    const oversizedClient = new AgnesVideoClient({
      apiKeys: ["agnes-api-secret"],
      fetch: async () => new Response("too-large", {
        status: 200,
        // Deliberately omit Content-Length so the streaming byte counter, not
        // merely the header preflight, must enforce the bound.
        headers: { "content-type": "video/mp4" },
      }),
    });
    await assert.rejects(
      oversizedClient.downloadCompletedVideo(task, outputPath, { maxBytes: 4 }),
      (error: unknown) => error instanceof AgnesError && error.kind === "download",
    );
    assert.equal(await readFile(outputPath, "utf8"), "keep-existing");
    assert.deepEqual(await readdir(join(directory, "nested")), ["video.mp4"]);
  });
});

test("validates the documented four-to-twelve-second duration and six aspect ratios", async () => {
  let calls = 0;
  const fetch: AgnesFetch = async () => {
    calls += 1;
    return jsonResponse(providerTask());
  };
  const client = new AgnesVideoClient({ apiKeys: ["key"], fetch });
  for (const seconds of [3, 4.5, 13]) {
    await assert.rejects(
      client.submitVideo({ prompt: "x", seconds, aspectRatio: "16:9" }),
      (error: unknown) => error instanceof AgnesError && error.kind === "validation",
    );
  }
  await assert.rejects(
    client.submitVideo({
      prompt: "x",
      seconds: 4,
      aspectRatio: "4:5" as never,
    }),
    (error: unknown) => error instanceof AgnesError && error.kind === "validation",
  );
  assert.equal(calls, 0);
});
