import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ElevenLabsClient,
  ElevenLabsError,
  ElevenLabsSoundEffectsClient,
  loadElevenLabsApiKeys,
  type ElevenLabsFetch,
} from "../src/elevenlabs/index.js";

const BASE_URL = "https://elevenlabs.test";

function audioResponse(
  bytes = "generated-mp3",
  headers: Record<string, string> = {},
): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "audio/mpeg", ...headers },
  });
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function withTempDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "elevenlabs-client-test-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function apiKey(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("xi-api-key");
}

test("discovers numbered ElevenLabs keys in numeric order with gaps and deduplication", () => {
  assert.deepEqual(loadElevenLabsApiKeys({
    ELEVENLABS_API_KEY_10: " ten ",
    ELEVENLABS_API_KEY_2: "two",
    ELEVENLABS_API_KEY_7: "two",
    ELEVENLABS_API_KEY: "ignored-unindexed",
    ELEVENLABS_API_KEY_X: "ignored-nonnumeric",
  }), ["two", "ten"]);
});

test("posts the documented v2 MP3 request and atomically persists returned audio", async () => {
  await withTempDirectory(async (directory) => {
    const calls: Array<{ url: string; key: string | null; body: Record<string, unknown> }> = [];
    const fetch: ElevenLabsFetch = async (input, init) => {
      calls.push({
        url: String(input),
        key: apiKey(init),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      assert.equal(new Headers(init?.headers).get("accept"), "audio/mpeg");
      return audioResponse("mp3-bytes", {
        "request-id": "request-123",
        "character-cost": "120",
      });
    };
    const outputPath = join(directory, "nested", "foley.mp3");
    const client = new ElevenLabsSoundEffectsClient({
      apiKeys: ["secret-key"],
      baseUrl: BASE_URL,
      fetch,
    });

    const result = await client.generateSoundEffect({
      text: "A dinosaur roar at the instant its jaws open",
      durationSeconds: 3,
      outputPath,
      promptInfluence: 0.8,
    });

    assert.deepEqual(calls, [{
      url: `${BASE_URL}/v1/sound-generation?output_format=mp3_44100_128`,
      key: "secret-key",
      body: {
        text: "A dinosaur roar at the instant its jaws open",
        loop: false,
        duration_seconds: 3,
        prompt_influence: 0.8,
        model_id: "eleven_text_to_sound_v2",
      },
    }]);
    assert.deepEqual(result, {
      filePath: outputPath,
      contentType: "audio/mpeg",
      model: "eleven_text_to_sound_v2",
      keyLabel: "key-1",
      requestId: "request-123",
      characterCost: "120",
    });
    assert.equal(await readFile(outputPath, "utf8"), "mp3-bytes");
    assert.deepEqual(await readdir(join(directory, "nested")), ["foley.mp3"]);
  });
});

test("exports the legacy sound-effects client name as the provider-wide client", () => {
  assert.equal(ElevenLabsSoundEffectsClient, ElevenLabsClient);
});

test("composes documented instrumental music, reports attempts, and atomically persists mode-0600 MP3", async () => {
  await withTempDirectory(async (directory) => {
    const calls: Array<{
      url: string;
      method: string | undefined;
      key: string | null;
      accept: string | null;
      body: Record<string, unknown>;
    }> = [];
    const attempts: Array<{ keyLabel: string }> = [];
    const client = new ElevenLabsClient({
      apiKeys: ["music-secret"],
      baseUrl: BASE_URL,
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method,
          key: apiKey(init),
          accept: new Headers(init?.headers).get("accept"),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return audioResponse("music-mp3", {
          "song-id": "song-123",
          "request-id": "request-456",
        });
      },
    });
    const outputPath = join(directory, "nested", "music.mp3");

    const result = await client.composeMusic({
      prompt: "Warm cinematic orchestral underscore with restrained piano",
      durationSeconds: 9.125,
      outputPath,
      onAttempt: (attempt) => attempts.push(attempt),
    });

    assert.deepEqual(calls, [{
      url: `${BASE_URL}/v1/music?output_format=mp3_44100_128`,
      method: "POST",
      key: "music-secret",
      accept: "audio/mpeg",
      body: {
        prompt: "Warm cinematic orchestral underscore with restrained piano",
        music_length_ms: 9_125,
        model_id: "music_v2",
        force_instrumental: true,
      },
    }]);
    assert.deepEqual(attempts, [{ keyLabel: "key-1" }]);
    assert.deepEqual(result, {
      filePath: outputPath,
      contentType: "audio/mpeg",
      model: "music_v2",
      keyLabel: "key-1",
      songId: "song-123",
      requestId: "request-456",
    });
    assert.equal(await readFile(outputPath, "utf8"), "music-mp3");
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(directory, "nested")), ["music.mp3"]);
  });
});

test("music rotates once per key only for definite daily-credit or explicit rate exhaustion", async () => {
  const failures = [
    jsonResponse({
      detail: { code: "daily_credits_exhausted", message: "Daily credits exhausted" },
    }, 429),
    jsonResponse({
      detail: { code: "rate_limit_exceeded", message: "Rate limit exceeded" },
    }, 429),
  ];

  for (const firstResponse of failures) {
    await withTempDirectory(async (directory) => {
      const keys: string[] = [];
      const bodies: string[] = [];
      const attempts: Array<{ keyLabel: string }> = [];
      let call = 0;
      const client = new ElevenLabsClient({
        apiKeys: ["first-key", "second-key"],
        baseUrl: BASE_URL,
        fetch: async (_input, init) => {
          keys.push(apiKey(init) ?? "");
          bodies.push(String(init?.body));
          return call++ === 0 ? firstResponse : audioResponse();
        },
      });

      const result = await client.composeMusic({
        prompt: "Instrumental action music",
        durationSeconds: 10,
        outputPath: join(directory, "music.mp3"),
        onAttempt: (attempt) => attempts.push(attempt),
      });

      assert.deepEqual(keys, ["first-key", "second-key"]);
      assert.equal(new Set(bodies).size, 1);
      assert.deepEqual(attempts, [{ keyLabel: "key-1" }, { keyLabel: "key-2" }]);
      assert.equal(result.keyLabel, "key-2");
    });
  }
});

test("rotates each key at most once for explicit credit, legacy quota, and rate exhaustion", async () => {
  const failures = [
    jsonResponse({ detail: { type: "payment_required", code: "insufficient_credits", message: "No credits" } }, 402),
    jsonResponse({ detail: { status: "quota_exceeded", message: "Quota exceeded" } }, 400),
    jsonResponse({ detail: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Rate limited" } }, 429),
  ];

  for (const firstResponse of failures) {
    await withTempDirectory(async (directory) => {
      const keys: string[] = [];
      const urls: string[] = [];
      const bodies: string[] = [];
      let call = 0;
      const client = new ElevenLabsSoundEffectsClient({
        apiKeys: ["first-key", "second-key"],
        baseUrl: BASE_URL,
        fetch: async (input, init) => {
          keys.push(apiKey(init) ?? "");
          urls.push(String(input));
          bodies.push(String(init?.body));
          return call++ === 0 ? firstResponse : audioResponse();
        },
      });
      const result = await client.generateSoundEffect({
        text: "Rain in a forest",
        durationSeconds: 3,
        outputPath: join(directory, "foley.mp3"),
      });
      assert.deepEqual(keys, ["first-key", "second-key"]);
      assert.equal(new Set(urls).size, 1);
      assert.equal(new Set(bodies).size, 1);
      assert.equal(result.keyLabel, "key-2");
    });
  }
});

test("marks the final rotatable rejection after trying every key exactly once", async () => {
  let calls = 0;
  const client = new ElevenLabsSoundEffectsClient({
    apiKeys: ["first-key", "second-key", "first-key"],
    baseUrl: BASE_URL,
    fetch: async () => {
      calls += 1;
      return jsonResponse(
        { detail: { code: "rate_limit_exceeded", message: "Rate limited" } },
        429,
        { "retry-after": "7" },
      );
    },
  });

  await assert.rejects(
    client.generateSoundEffect({
      text: "Ocean waves",
      durationSeconds: 2,
      outputPath: "/unused/foley.mp3",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ElevenLabsError);
      assert.equal(error.kind, "rate_limit");
      assert.equal(error.rotationExhausted, true);
      assert.equal(error.ambiguousOutcome, false);
      assert.equal(error.retryAfterMs, 7_000);
      assert.equal(error.keyLabel, "key-2");
      assert.doesNotMatch(error.message, /first-key|second-key/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("a mixed exhausted pool remains retryable when any key is rate-limited", async () => {
  let call = 0;
  const client = new ElevenLabsSoundEffectsClient({
    apiKeys: ["rate-key", "credit-key"],
    fetch: async () => call++ === 0
      ? jsonResponse(
          { detail: { code: "rate_limit_exceeded", message: "Rate limited" } },
          429,
          { "retry-after": "9" },
        )
      : jsonResponse(
          { detail: { code: "insufficient_credits", message: "No credits" } },
          402,
        ),
  });

  await assert.rejects(
    client.generateSoundEffect({
      text: "Jungle ambience",
      durationSeconds: 3,
      outputPath: "/unused/foley.mp3",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ElevenLabsError);
      assert.equal(error.kind, "rate_limit");
      assert.equal(error.retryAfterMs, 9_000);
      assert.equal(error.rotationExhausted, true);
      return true;
    },
  );
  assert.equal(call, 2);
});

test("does not rotate auth, validation, concurrency, ambiguous 429, network, 5xx, or malformed audio", async () => {
  const cases: Array<{
    expectedKind: ElevenLabsError["kind"];
    expectedAmbiguous: boolean;
    fetch: ElevenLabsFetch;
  }> = [
    {
      expectedKind: "authentication",
      expectedAmbiguous: false,
      fetch: async () => jsonResponse({ detail: { code: "invalid_api_key", message: "Invalid API key" } }, 401),
    },
    {
      expectedKind: "validation",
      expectedAmbiguous: false,
      fetch: async () => jsonResponse({ detail: { code: "validation_error", message: "Bad duration" } }, 422),
    },
    {
      expectedKind: "rate_limit",
      expectedAmbiguous: false,
      fetch: async () => jsonResponse({
        detail: { code: "concurrent_limit_exceeded", message: "Too many concurrent requests" },
      }, 429),
    },
    {
      expectedKind: "rate_limit",
      expectedAmbiguous: false,
      fetch: async () => jsonResponse({ detail: { code: "system_busy", message: "System busy" } }, 429),
    },
    {
      expectedKind: "rate_limit",
      expectedAmbiguous: false,
      fetch: async () => jsonResponse({}, 429),
    },
    {
      expectedKind: "network",
      expectedAmbiguous: true,
      fetch: async () => { throw new Error("socket reset"); },
    },
    {
      expectedKind: "rate_limit",
      expectedAmbiguous: false,
      fetch: async () => jsonResponse({ detail: { code: "system_busy", message: "Rate limited internally" } }, 503),
    },
    {
      expectedKind: "provider",
      expectedAmbiguous: true,
      fetch: async () => jsonResponse({ detail: { code: "internal_error", message: "Unexpected failure" } }, 503),
    },
    {
      expectedKind: "provider",
      expectedAmbiguous: true,
      fetch: async () => jsonResponse({ unexpected: true }, 200),
    },
  ];

  for (const entry of cases) {
    let calls = 0;
    const client = new ElevenLabsSoundEffectsClient({
      apiKeys: ["first-key", "second-key"],
      baseUrl: BASE_URL,
      fetch: async (input, init) => {
        calls += 1;
        return entry.fetch(input, init);
      },
    });
    await assert.rejects(
      client.generateSoundEffect({
        text: "A car engine",
        durationSeconds: 3,
        outputPath: "/unused/foley.mp3",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ElevenLabsError);
        assert.equal(error.kind, entry.expectedKind);
        assert.equal(error.ambiguousOutcome, entry.expectedAmbiguous);
        assert.equal(error.rotationExhausted, false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("music does not rotate subscription, permission, bad-prompt, ambiguous, or malformed outcomes", async () => {
  const cases: Array<{
    expectedKind: ElevenLabsError["kind"];
    expectedAmbiguous: boolean;
    fetch: ElevenLabsFetch;
  }> = [
    {
      expectedKind: "configuration",
      expectedAmbiguous: false,
      fetch: async () => jsonResponse({
        detail: { code: "feature_not_available", message: "Music is not available on this plan" },
      }, 403),
    },
    {
      expectedKind: "configuration",
      expectedAmbiguous: false,
      fetch: async () => jsonResponse({
        detail: { code: "subscription_required", message: "A paid subscription is required" },
      }, 403),
    },
    {
      expectedKind: "authentication",
      expectedAmbiguous: false,
      fetch: async () => jsonResponse({
        detail: { code: "missing_permissions", message: "Permission denied" },
      }, 403),
    },
    {
      expectedKind: "validation",
      expectedAmbiguous: false,
      fetch: async () => jsonResponse({
        detail: { code: "bad_prompt", message: "Bad music prompt" },
      }, 400),
    },
    {
      expectedKind: "rate_limit",
      expectedAmbiguous: false,
      fetch: async () => jsonResponse({}, 429),
    },
    {
      expectedKind: "rate_limit",
      expectedAmbiguous: false,
      fetch: async () => jsonResponse({
        detail: { code: "concurrent_limit_exceeded", message: "Too many concurrent requests" },
      }, 429),
    },
    {
      expectedKind: "network",
      expectedAmbiguous: true,
      fetch: async () => { throw new Error("socket reset"); },
    },
    {
      expectedKind: "provider",
      expectedAmbiguous: true,
      fetch: async () => jsonResponse({
        detail: { code: "internal_error", message: "Provider failed" },
      }, 503),
    },
    {
      expectedKind: "provider",
      expectedAmbiguous: true,
      fetch: async () => jsonResponse({
        detail: { code: "insufficient_credits", message: "Credits exhausted" },
      }, 503),
    },
    {
      expectedKind: "provider",
      expectedAmbiguous: true,
      fetch: async () => jsonResponse({ unexpected: true }, 200),
    },
    {
      expectedKind: "download",
      expectedAmbiguous: true,
      fetch: async () => audioResponse(""),
    },
  ];

  for (const entry of cases) {
    let calls = 0;
    const client = new ElevenLabsClient({
      apiKeys: ["first-key", "second-key"],
      baseUrl: BASE_URL,
      fetch: async (input, init) => {
        calls += 1;
        return entry.fetch(input, init);
      },
    });
    await assert.rejects(
      client.composeMusic({
        prompt: "Instrumental ambient music",
        durationSeconds: 10,
        outputPath: "/unused/music.mp3",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ElevenLabsError);
        assert.equal(error.kind, entry.expectedKind);
        assert.equal(error.ambiguousOutcome, entry.expectedAmbiguous);
        assert.equal(error.rotationExhausted, false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("music timeout aborts the request and does not consume another key", async () => {
  let calls = 0;
  let observedSignal: AbortSignal | undefined;
  const client = new ElevenLabsClient({
    apiKeys: ["first-key", "second-key"],
    requestTimeoutMs: 10,
    fetch: (_input, init) => {
      calls += 1;
      const signal = init?.signal;
      assert.ok(signal);
      observedSignal = signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    },
  });

  await assert.rejects(
    client.composeMusic({
      prompt: "Instrumental ambient music",
      durationSeconds: 10,
      outputPath: "/unused/music.mp3",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ElevenLabsError);
      assert.equal(error.kind, "network");
      assert.equal(error.code, "request_timeout");
      assert.equal(error.ambiguousOutcome, true);
      assert.equal(error.rotationExhausted, false);
      assert.equal(error.keyLabel, "key-1");
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(observedSignal?.aborted, true);
});

test("serializes concurrent generations on one client", async () => {
  await withTempDirectory(async (directory) => {
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = new ElevenLabsSoundEffectsClient({
      apiKeys: ["key"],
      fetch: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (calls === 1) await firstMayFinish;
        active -= 1;
        return audioResponse(`audio-${calls}`);
      },
    });

    const first = client.generateSoundEffect({
      text: "first",
      durationSeconds: 1,
      outputPath: join(directory, "first.mp3"),
    });
    const second = client.generateSoundEffect({
      text: "second",
      durationSeconds: 1,
      outputPath: join(directory, "second.mp3"),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    releaseFirst?.();
    await Promise.all([first, second]);

    assert.equal(calls, 2);
    assert.equal(maximumActive, 1);
  });
});

test("serializes sound effects and music through one provider-wide gate", async () => {
  await withTempDirectory(async (directory) => {
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = new ElevenLabsClient({
      apiKeys: ["key"],
      fetch: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (calls === 1) await firstMayFinish;
        active -= 1;
        return audioResponse(`audio-${calls}`);
      },
    });

    const foley = client.generateSoundEffect({
      text: "first",
      durationSeconds: 3,
      outputPath: join(directory, "foley.mp3"),
    });
    const music = client.composeMusic({
      prompt: "second instrumental track",
      durationSeconds: 3,
      outputPath: join(directory, "music.mp3"),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    releaseFirst?.();
    await Promise.all([foley, music]);

    assert.equal(calls, 2);
    assert.equal(maximumActive, 1);
  });
});

test("rejects invalid local input before making a provider request", async () => {
  let calls = 0;
  const client = new ElevenLabsSoundEffectsClient({
    apiKeys: ["key"],
    fetch: async () => {
      calls += 1;
      return audioResponse();
    },
  });

  for (const request of [
    { text: "", durationSeconds: 3, outputPath: "/unused/a.mp3" },
    { text: "x".repeat(451), durationSeconds: 3, outputPath: "/unused/a.mp3" },
    { text: "rain", durationSeconds: 0.49, outputPath: "/unused/a.mp3" },
    { text: "rain", durationSeconds: 30.01, outputPath: "/unused/a.mp3" },
    { text: "rain", durationSeconds: 3, outputPath: "/unused/a.mp3", promptInfluence: 1.01 },
  ]) {
    await assert.rejects(client.generateSoundEffect(request), (error: unknown) => {
      assert.ok(error instanceof ElevenLabsError);
      assert.equal(error.kind, "validation");
      return true;
    });
  }
  assert.equal(calls, 0);
});

test("rejects invalid music input and timeout configuration before provider I/O", async () => {
  let calls = 0;
  const client = new ElevenLabsClient({
    apiKeys: ["key"],
    fetch: async () => {
      calls += 1;
      return audioResponse();
    },
  });

  for (const request of [
    { prompt: "", durationSeconds: 3, outputPath: "/unused/music.mp3" },
    { prompt: "x".repeat(4_101), durationSeconds: 3, outputPath: "/unused/music.mp3" },
    { prompt: "music", durationSeconds: 2.999, outputPath: "/unused/music.mp3" },
    { prompt: "music", durationSeconds: 600.001, outputPath: "/unused/music.mp3" },
    { prompt: "music", durationSeconds: 3.0001, outputPath: "/unused/music.mp3" },
    { prompt: "music", durationSeconds: 3, outputPath: "" },
  ]) {
    await assert.rejects(client.composeMusic(request), (error: unknown) => {
      assert.ok(error instanceof ElevenLabsError);
      assert.equal(error.kind, "validation");
      return true;
    });
  }
  assert.equal(calls, 0);

  assert.throws(
    () => new ElevenLabsClient({ apiKeys: ["key"], requestTimeoutMs: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof ElevenLabsError);
      assert.equal(error.kind, "configuration");
      return true;
    },
  );
});

test("does not rotate or leave a partial file when a successful response is empty", async () => {
  await withTempDirectory(async (directory) => {
    let calls = 0;
    const outputPath = join(directory, "foley.mp3");
    const client = new ElevenLabsSoundEffectsClient({
      apiKeys: ["first-key", "second-key"],
      fetch: async () => {
        calls += 1;
        return audioResponse("");
      },
    });
    await assert.rejects(
      client.generateSoundEffect({ text: "wind", durationSeconds: 3, outputPath }),
      (error: unknown) => {
        assert.ok(error instanceof ElevenLabsError);
        assert.equal(error.kind, "download");
        assert.equal(error.ambiguousOutcome, true);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(directory), []);
  });
});
