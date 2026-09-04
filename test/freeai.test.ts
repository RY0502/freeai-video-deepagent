import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FREE_AI_MUSIC_ENDPOINT,
  FREE_AI_MUSIC_MODEL,
  FreeAiMusicClient,
  FreeAiMusicError,
  loadFreeAiMusicKeys,
  type FreeAiMusicFetch,
} from "../src/freeai/index.js";

const BASE_URL = "https://free-ai.test";
const AUDIO_URL = "https://media.free-ai.test/generated/music.wav";

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

function wavResponse(
  bytes = "RIFF-test-wave-bytes",
  headers: Record<string, string> = {},
): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "audio/wav", ...headers },
  });
}

function authorization(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

async function withTempDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "freeai-music-test-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("discovers numbered Free.ai audio keys in numeric order with gaps and deduplication", () => {
  assert.deepEqual(loadFreeAiMusicKeys({
    FREE_AI_API_AUDIO_KEY_10: " ten ",
    FREE_AI_API_AUDIO_KEY_2: "two",
    FREE_AI_API_AUDIO_KEY_7: "two",
    FREE_AI_API_AUDIO_KEY_4: "   ",
    FREE_AI_API_AUDIO_KEY_X: "ignored-nonnumeric",
    FREE_AI_API_AUDIO_KEY: "ignored-unindexed",
    FREE_AI_API_VIDEO_KEY_1: "ignored-video-key",
  }), ["two", "ten"]);
});

test("posts the exact ACE-Step request and atomically downloads the returned WAV", async () => {
  await withTempDirectory(async (directory) => {
    const secret = "free-audio-secret";
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch: FreeAiMusicFetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return calls.length === 1
        ? jsonResponse({
            url: `${BASE_URL}/jobs/music-123`,
            data: { audio_url: AUDIO_URL },
            id: "music-123",
          })
        : wavResponse();
    };
    const outputPath = join(directory, "nested", "music.wav");
    let submittedBeforeDownload = false;
    const client = new FreeAiMusicClient({
      apiKeys: [secret],
      baseUrl: `${BASE_URL}/`,
      fetch,
      retryDelayMs: 0,
    });

    const result = await client.generateMusic({
      prompt: "  Restrained cinematic piano underscore  ",
      durationSeconds: 7,
      genre: " ambient ",
      tempo: 84,
      outputPath,
      onSubmitted: async (submission) => {
        submittedBeforeDownload = true;
        assert.equal(calls.length, 1);
        assert.equal(submission.url, AUDIO_URL);
        assert.equal(submission.externalId, "music-123");
        assert.equal(submission.generationAttempts, 1);
        await assert.rejects(readFile(outputPath), { code: "ENOENT" });
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, `${BASE_URL}${FREE_AI_MUSIC_ENDPOINT}`);
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal(authorization(calls[0]?.init), `Bearer ${secret}`);
    assert.equal(new Headers(calls[0]?.init?.headers).get("accept"), "application/json");
    assert.equal(new Headers(calls[0]?.init?.headers).get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      prompt: "Restrained cinematic piano underscore",
      duration: 10,
      model: "ace-step",
      genre: "ambient",
      tempo: 84,
    });

    assert.equal(calls[1]?.url, AUDIO_URL);
    assert.equal(calls[1]?.init?.method, "GET");
    assert.equal(authorization(calls[1]?.init), null);
    assert.equal(calls[1]?.init?.body, undefined);
    assert.equal(await readFile(outputPath, "utf8"), "RIFF-test-wave-bytes");
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.equal(submittedBeforeDownload, true);
    assert.deepEqual(result, {
      filePath: outputPath,
      url: AUDIO_URL,
      model: FREE_AI_MUSIC_MODEL,
      keyLabel: "key-1",
      generationAttempts: 1,
      downloadAttempts: 1,
      providerDurationSeconds: 10,
      contentType: "audio/wav",
      externalId: "music-123",
    });
  });
});

test("requests max(10, final duration) seconds from ACE-Step", async () => {
  await withTempDirectory(async (directory) => {
    for (const [target, provider] of [[4, 10], [10, 10], [12, 12]] as const) {
      let submittedBody: Record<string, unknown> | undefined;
      const client = new FreeAiMusicClient({
        apiKeys: ["duration-key"],
        baseUrl: BASE_URL,
        retryDelayMs: 0,
        fetch: async (_input, init) => {
          if (init?.method === "POST") {
            submittedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
            return jsonResponse({ output_url: AUDIO_URL });
          }
          return wavResponse(`wav-${target}`);
        },
      });

      const result = await client.generateMusic({
        prompt: "Instrumental score",
        durationSeconds: target,
        outputPath: join(directory, `music-${target}.wav`),
      });

      assert.equal(submittedBody?.duration, provider);
      assert.equal(result.providerDurationSeconds, provider);
    }
  });
});

test("retries any generation failure three times and rotates keys round-robin", async () => {
  await withTempDirectory(async (directory) => {
    const generationCalls: Array<{
      authorization: string | null;
      body: string;
    }> = [];
    const attempts: Array<{
      phase: "generation" | "download";
      attemptNumber: number;
      maxAttempts: number;
      keyLabel?: string;
    }> = [];
    const sleeps: number[] = [];
    let submission = 0;
    const client = new FreeAiMusicClient({
      apiKeys: ["first-key", "second-key", "third-key"],
      baseUrl: BASE_URL,
      retryDelayMs: 0,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      fetch: async (_input, init) => {
        if (init?.method === "GET") return wavResponse("wav-after-retries");
        generationCalls.push({
          authorization: authorization(init),
          body: String(init?.body),
        });
        submission += 1;
        if (submission === 1) return jsonResponse({ error: "temporary provider error" }, 500);
        if (submission === 2) throw new Error("socket reset");
        if (submission === 3) return jsonResponse({ status: "completed but URL missing" });
        return jsonResponse({ url: AUDIO_URL });
      },
    });

    const result = await client.generateMusic({
      prompt: "Action score",
      durationSeconds: 12,
      outputPath: join(directory, "music.wav"),
      onAttempt: (attempt) => attempts.push(attempt),
    });

    assert.equal(client.maxAttempts, 4);
    assert.deepEqual(generationCalls.map(({ authorization: value }) => value), [
      "Bearer first-key",
      "Bearer second-key",
      "Bearer third-key",
      "Bearer first-key",
    ]);
    assert.equal(new Set(generationCalls.map(({ body }) => body)).size, 1);
    assert.deepEqual(sleeps, [0, 0, 0]);
    assert.deepEqual(attempts, [
      { phase: "generation", attemptNumber: 1, maxAttempts: 4, keyLabel: "key-1" },
      { phase: "generation", attemptNumber: 2, maxAttempts: 4, keyLabel: "key-2" },
      { phase: "generation", attemptNumber: 3, maxAttempts: 4, keyLabel: "key-3" },
      { phase: "generation", attemptNumber: 4, maxAttempts: 4, keyLabel: "key-1" },
      { phase: "download", attemptNumber: 1, maxAttempts: 4 },
    ]);
    assert.equal(result.generationAttempts, 4);
    assert.equal(result.keyLabel, "key-1");
  });
});

test("stops generation attempts immediately after success", async () => {
  await withTempDirectory(async (directory) => {
    let posts = 0;
    const client = new FreeAiMusicClient({
      apiKeys: ["first-key", "second-key", "third-key"],
      baseUrl: BASE_URL,
      retryDelayMs: 0,
      fetch: async (_input, init) => {
        if (init?.method === "POST") {
          posts += 1;
          return jsonResponse({ audioUrl: AUDIO_URL });
        }
        return wavResponse();
      },
    });

    const result = await client.generateMusic({
      prompt: "Soft score",
      durationSeconds: 8,
      outputPath: join(directory, "music.wav"),
    });

    assert.equal(posts, 1);
    assert.equal(result.generationAttempts, 1);
    assert.equal(result.keyLabel, "key-1");
  });
});

test("retries a successful HTTP payload that explicitly reports provider failure", async () => {
  await withTempDirectory(async (directory) => {
    let posts = 0;
    let downloads = 0;
    const client = new FreeAiMusicClient({
      apiKeys: ["first-key", "second-key"],
      baseUrl: BASE_URL,
      retryDelayMs: 0,
      fetch: async (_input, init) => {
        if (init?.method === "POST") {
          posts += 1;
          return jsonResponse({
            status: "failed",
            error: "daily credits exhausted",
            url: AUDIO_URL,
          });
        }
        downloads += 1;
        return wavResponse();
      },
    });

    await assert.rejects(client.generateMusic({
      prompt: "Quiet score",
      durationSeconds: 8,
      outputPath: join(directory, "music.wav"),
    }), (error: unknown) => {
      assert.ok(error instanceof FreeAiMusicError);
      assert.equal(error.retryExhausted, true);
      assert.match(error.message, /daily credits exhausted/i);
      return true;
    });
    assert.equal(posts, 4);
    assert.equal(downloads, 0);
  });
});

test("retries one returned media URL without submitting another generation", async () => {
  await withTempDirectory(async (directory) => {
    const generationUrls: string[] = [];
    const downloadUrls: string[] = [];
    const downloadAuthorizations: Array<string | null> = [];
    let downloads = 0;
    const client = new FreeAiMusicClient({
      apiKeys: ["download-key"],
      baseUrl: BASE_URL,
      retryDelayMs: 0,
      fetch: async (input, init) => {
        if (init?.method === "POST") {
          generationUrls.push(String(input));
          return jsonResponse({ data: { outputUrl: AUDIO_URL } });
        }
        downloadUrls.push(String(input));
        downloadAuthorizations.push(authorization(init));
        downloads += 1;
        return downloads === 1
          ? jsonResponse({ message: "CDN warming" }, 503)
          : wavResponse("eventual-wav");
      },
    });

    const outputPath = join(directory, "music.wav");
    const result = await client.generateMusic({
      prompt: "Coastal score",
      durationSeconds: 9,
      outputPath,
    });

    assert.deepEqual(generationUrls, [`${BASE_URL}${FREE_AI_MUSIC_ENDPOINT}`]);
    assert.deepEqual(downloadUrls, [AUDIO_URL, AUDIO_URL]);
    assert.deepEqual(downloadAuthorizations, [null, null]);
    assert.equal(result.generationAttempts, 1);
    assert.equal(result.downloadAttempts, 2);
    assert.equal(await readFile(outputPath, "utf8"), "eventual-wav");
  });
});

test("download-only resume needs no API key and rejects non-audio success bodies", async () => {
  await withTempDirectory(async (directory) => {
    let gets = 0;
    const outputPath = join(directory, "music.wav");
    const client = new FreeAiMusicClient({
      apiKeys: [],
      baseUrl: BASE_URL,
      retryDelayMs: 0,
      fetch: async (_input, init) => {
        assert.equal(init?.method, "GET");
        assert.equal(authorization(init), null);
        gets += 1;
        return new Response("<html>temporary proxy failure</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });

    await assert.rejects(client.downloadMusic({ url: AUDIO_URL, outputPath }), (error: unknown) => {
      assert.ok(error instanceof FreeAiMusicError);
      assert.equal(error.kind, "download");
      assert.equal(error.retryExhausted, true);
      return true;
    });
    assert.equal(gets, 4);
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  });
});

test("marks four exhausted generation attempts and redacts configured secrets", async () => {
  await withTempDirectory(async (directory) => {
    const firstSecret = "sk-free-first-secret";
    const secondSecret = "sk-free-second-secret";
    const bearerValues: Array<string | null> = [];
    const client = new FreeAiMusicClient({
      apiKeys: [firstSecret, secondSecret],
      baseUrl: BASE_URL,
      retryDelayMs: 0,
      fetch: async (_input, init) => {
        bearerValues.push(authorization(init));
        return jsonResponse({
          error: `quota exhausted for ${firstSecret}`,
          detail: secondSecret,
        }, 429);
      },
    });

    await assert.rejects(
      client.generateMusic({
        prompt: "Dramatic score",
        durationSeconds: 8,
        outputPath: join(directory, "music.wav"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof FreeAiMusicError);
        assert.equal(error.kind, "http");
        assert.equal(error.status, 429);
        assert.equal(error.keyLabel, "key-2");
        assert.equal(error.retryExhausted, true);
        const serialized = `${error.message} ${JSON.stringify(error.response)} ${String(error.cause ?? "")}`;
        assert.doesNotMatch(serialized, /sk-free-first-secret|sk-free-second-secret/);
        assert.match(serialized, /\[redacted\]/);
        return true;
      },
    );
    assert.deepEqual(bearerValues, [
      `Bearer ${firstSecret}`,
      `Bearer ${secondSecret}`,
      `Bearer ${firstSecret}`,
      `Bearer ${secondSecret}`,
    ]);
  });
});

test("rejects invalid requests and missing keys before calling fetch", async () => {
  await withTempDirectory(async (directory) => {
    let calls = 0;
    const fetch: FreeAiMusicFetch = async () => {
      calls += 1;
      throw new Error("fetch must not run");
    };
    const outputPath = join(directory, "music.wav");
    const client = new FreeAiMusicClient({
      apiKeys: ["configured-key"],
      fetch,
    });
    const noKeys = new FreeAiMusicClient({ apiKeys: [], fetch });

    await assert.rejects(
      client.generateMusic({ prompt: "  ", durationSeconds: 8, outputPath }),
      (error: unknown) => error instanceof FreeAiMusicError && error.kind === "validation",
    );
    await assert.rejects(
      client.generateMusic({ prompt: "Score", durationSeconds: 3, outputPath }),
      (error: unknown) => error instanceof FreeAiMusicError && error.kind === "validation",
    );
    await assert.rejects(
      client.generateMusic({ prompt: "Score", durationSeconds: 8, tempo: 301, outputPath }),
      (error: unknown) => error instanceof FreeAiMusicError && error.kind === "validation",
    );
    await assert.rejects(
      noKeys.generateMusic({ prompt: "Score", durationSeconds: 8, outputPath }),
      (error: unknown) => error instanceof FreeAiMusicError && error.kind === "configuration",
    );
    assert.equal(calls, 0);
  });
});
