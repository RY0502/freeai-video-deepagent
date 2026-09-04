import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  YOUTUBE_UPLOAD_SCOPE,
  YouTubeUploadAuthorizationError,
  YouTubeUploadDisabledError,
  YouTubeUploadError,
  applyYouTubeOAuthTokens,
  createYouTubeAuthorizationUrl,
  createYouTubeOAuthClient,
  createYouTubeUploader,
  exchangeYouTubeAuthorizationCode,
  type YouTubeApiClient,
  type YouTubeOAuthClient,
  type YouTubeOAuthTokens,
} from "../src/youtube/index.js";

const AUTHORIZATION_TOKEN = "approved-upload-123456789";

function uploadInput() {
  return {
    filePath: "/media/final.mp4",
    title: "  A nine-second story  ",
    description: "Generated test video",
    tags: ["ai", "short"],
    categoryId: "24",
    selfDeclaredMadeForKids: false,
    authorization: {
      confirmed: true,
      token: AUTHORIZATION_TOKEN,
    },
  } as const;
}

test("YouTube uploads are disabled by default before any I/O", async () => {
  let touchedFile = false;
  const uploader = createYouTubeUploader(
    {},
    {
      assertReadable: async () => {
        touchedFile = true;
      },
    },
  );

  await assert.rejects(uploader.upload(uploadInput()), YouTubeUploadDisabledError);
  assert.equal(touchedFile, false);
});

test("YouTube upload requires both an explicit boolean and matching capability token", async () => {
  const uploader = createYouTubeUploader({
    enabled: true,
    requiredAuthorizationToken: AUTHORIZATION_TOKEN,
  });

  await assert.rejects(
    uploader.upload({
      ...uploadInput(),
      authorization: { confirmed: false, token: AUTHORIZATION_TOKEN },
    }),
    YouTubeUploadAuthorizationError,
  );
  await assert.rejects(
    uploader.upload({
      ...uploadInput(),
      authorization: { confirmed: true, token: "incorrect-token-1234567" },
    }),
    YouTubeUploadAuthorizationError,
  );
});

test("YouTube uploader defaults to private and sends disclosure metadata", async () => {
  let capturedRequest: Parameters<YouTubeApiClient["videos"]["insert"]>[0] | undefined;
  const youtubeClient: YouTubeApiClient = {
    videos: {
      insert: async (request) => {
        capturedRequest = request;
        return { data: { id: "video-id-123", status: { privacyStatus: "private" } } };
      },
    },
  };
  const uploader = createYouTubeUploader(
    {
      enabled: true,
      requiredAuthorizationToken: AUTHORIZATION_TOKEN,
    },
    {
      youtubeClient,
      assertReadable: async () => {},
      openFile: () => Readable.from(Buffer.from("not-a-real-video")),
    },
  );

  const result = await uploader.upload(uploadInput());

  assert.equal(result.videoId, "video-id-123");
  assert.equal(result.privacyStatus, "private");
  assert.equal(result.url, "https://youtu.be/video-id-123");
  assert.deepEqual(capturedRequest?.part, ["snippet", "status"]);
  assert.equal(capturedRequest?.notifySubscribers, false);
  assert.equal(capturedRequest?.requestBody.snippet.title, "A nine-second story");
  assert.equal(capturedRequest?.requestBody.snippet.description, "Generated test video");
  assert.deepEqual(capturedRequest?.requestBody.snippet.tags, ["ai", "short"]);
  assert.equal(capturedRequest?.requestBody.snippet.categoryId, "24");
  assert.equal(capturedRequest?.requestBody.status.privacyStatus, "private");
  assert.equal(capturedRequest?.requestBody.status.selfDeclaredMadeForKids, false);
  assert.equal(capturedRequest?.requestBody.status.containsSyntheticMedia, true);
});

test("YouTube uploader rejects metadata that the API would reject before file I/O", async () => {
  let touchedFile = false;
  const uploader = createYouTubeUploader(
    { enabled: true, requiredAuthorizationToken: AUTHORIZATION_TOKEN },
    { assertReadable: async () => { touchedFile = true; } },
  );

  for (const invalid of [
    { title: "Bad <title>" },
    { description: "😀".repeat(1_251) },
    { tags: ["same", "SAME"] },
    { tags: Array.from({ length: 6 }, (_, index) => `${index}-${"x".repeat(90)}`) },
  ]) {
    await assert.rejects(uploader.upload({ ...uploadInput(), ...invalid }), /title|description|tags/i);
  }
  assert.equal(touchedFile, false);
});

test("YouTube uploader reports effective privacy returned by the API", async () => {
  const uploader = createYouTubeUploader(
    {
      enabled: true,
      requiredAuthorizationToken: AUTHORIZATION_TOKEN,
      defaultPrivacyStatus: "public",
    },
    {
      youtubeClient: {
        videos: {
          insert: async () => ({
            data: { id: "forced-private", status: { privacyStatus: "private" } },
          }),
        },
      },
      assertReadable: async () => {},
      openFile: () => Readable.from(Buffer.from("not-a-real-video")),
    },
  );

  const result = await uploader.upload({ ...uploadInput(), privacyStatus: "public" });
  assert.equal(result.privacyStatus, "private");
});

test("YouTube uploader distinguishes definite API rejection from ambiguous acceptance", async () => {
  for (const scenario of [
    {
      error: Object.assign(new Error("invalid metadata"), { response: { status: 400 } }),
      ambiguousOutcome: false,
      status: 400,
    },
    {
      error: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
      ambiguousOutcome: true,
      status: undefined,
    },
    {
      error: Object.assign(new Error("upstream unavailable"), { response: { status: 503 } }),
      ambiguousOutcome: true,
      status: 503,
    },
  ] as const) {
    const uploader = createYouTubeUploader(
      { enabled: true, requiredAuthorizationToken: AUTHORIZATION_TOKEN },
      {
        youtubeClient: {
          videos: { insert: async () => { throw scenario.error; } },
        },
        assertReadable: async () => {},
        openFile: () => Readable.from(Buffer.from("not-a-real-video")),
      },
    );
    await assert.rejects(uploader.upload(uploadInput()), (error: unknown) => {
      assert.ok(error instanceof YouTubeUploadError);
      assert.equal(error.ambiguousOutcome, scenario.ambiguousOutcome);
      assert.equal(error.status, scenario.status);
      return true;
    });
  }
});

test("a successful YouTube response without a video ID is ambiguous", async () => {
  const uploader = createYouTubeUploader(
    { enabled: true, requiredAuthorizationToken: AUTHORIZATION_TOKEN },
    {
      youtubeClient: { videos: { insert: async () => ({ data: {} }) } },
      assertReadable: async () => {},
      openFile: () => Readable.from(Buffer.from("not-a-real-video")),
    },
  );

  await assert.rejects(uploader.upload(uploadInput()), (error: unknown) => {
    assert.ok(error instanceof YouTubeUploadError);
    assert.equal(error.ambiguousOutcome, true);
    return true;
  });
});

test("OAuth helper requests only offline YouTube upload access and exchanges the code", async () => {
  let generatedOptions: Record<string, unknown> | undefined;
  let credentials: YouTubeOAuthTokens | undefined;
  const fakeClient: YouTubeOAuthClient = {
    generateAuthUrl: (options) => {
      generatedOptions = options;
      return "https://accounts.example/authorize";
    },
    getToken: async (code) => {
      assert.equal(code, "authorization-code");
      return { tokens: { access_token: "access", refresh_token: "refresh" } };
    },
    setCredentials: (tokens) => {
      credentials = tokens;
    },
  };
  const client = createYouTubeOAuthClient(
    { clientId: "client-id", clientSecret: "client-secret", redirectUri: "http://localhost/callback" },
    { createClient: () => fakeClient },
  );

  const url = createYouTubeAuthorizationUrl(client, { state: "random-state-123456789" });
  const tokens = await exchangeYouTubeAuthorizationCode(client, "authorization-code");

  assert.equal(url, "https://accounts.example/authorize");
  assert.deepEqual(generatedOptions?.scope, [YOUTUBE_UPLOAD_SCOPE]);
  assert.equal(generatedOptions?.access_type, "offline");
  assert.equal(generatedOptions?.prompt, "consent");
  assert.deepEqual(tokens, { access_token: "access", refresh_token: "refresh" });
  assert.deepEqual(credentials, tokens);

  applyYouTubeOAuthTokens(client, { refresh_token: "stored-refresh" });
  assert.deepEqual(credentials, { refresh_token: "stored-refresh" });
});
