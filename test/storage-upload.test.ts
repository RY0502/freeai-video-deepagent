import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { uploadVideoToStorage } from "../src/storage/index.js";
import { loadConfig } from "../src/config.js";

test("uploadVideoToStorage fails if file does not exist", async () => {
  const config = loadConfig({
    CONVEX_DEPLOY_KEY: "secret-key",
    CONVEX_URL: "https://test.convex.cloud",
    CONVEX_STORAGE_BUCKET: "shared",
  });

  await assert.rejects(
    uploadVideoToStorage("c:/non-existent-video.mp4", config),
    (err: unknown) => err instanceof Error && err.message.includes("not found"),
  );
});

test("uploadVideoToStorage uploads to Convex storage under 'shorts' directory and database", async () => {
  const testDir = path.join(tmpdir(), `storage-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  const videoFile = path.join(testDir, "test-output.mp4");
  await writeFile(videoFile, Buffer.from("dummy-video-content-bytes"));

  const config = loadConfig({
    CONVEX_URL: "https://example.convex.cloud",
    CONVEX_STORAGE_BUCKET: "shared",
    CONVEX_DEPLOY_KEY: "deploy-key-secret",
  });

  const calls: Array<{ url: string; headers: Headers; method: string }> = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const urlStr = String(input);
    calls.push({
      url: urlStr,
      headers: new Headers(init?.headers),
      method: init?.method || "GET",
    });

    if (urlStr.endsWith("/api/mutation")) {
      const body = JSON.parse(String(init?.body)) as { path: string };
      if (body.path === "files:generateUploadUrl") {
        return new Response(JSON.stringify({
          status: "success",
          value: "https://example.convex.cloud/api/storage/upload?token=abc",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body.path === "files:saveFile") {
        return new Response(JSON.stringify({
          status: "success",
          value: {
            storageId: "stored_vid_123",
            url: "https://example.convex.cloud/api/storage/stored_vid_123",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }

    if (urlStr.includes("/api/storage/upload")) {
      return new Response(JSON.stringify({ storageId: "stored_vid_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  };

  try {
    const result = await uploadVideoToStorage(videoFile, config, { fetch: mockFetch });

    assert.equal(result.provider, "convex");
    assert.equal(result.bucket, "shared");
    assert.equal(result.objectKey, "shorts/test-output.mp4");
    assert.equal(
      result.publicUrl,
      "https://example.convex.cloud/api/storage/stored_vid_123",
    );
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.url, "https://example.convex.cloud/api/mutation");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer deploy-key-secret");
    assert.equal(calls[1]?.url, "https://example.convex.cloud/api/storage/upload?token=abc");
    assert.equal(calls[1]?.headers.get("content-type"), "video/mp4");
    assert.equal(calls[2]?.url, "https://example.convex.cloud/api/mutation");
    assert.equal(calls[2]?.headers.get("authorization"), "Bearer deploy-key-secret");
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("uploadVideoToStorage uploads to Appwrite storage under 'shorts' directory when configured", async () => {
  const testDir = path.join(tmpdir(), `storage-test-appwrite-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  const videoFile = path.join(testDir, "cat-video.mp4");
  await writeFile(videoFile, Buffer.from("dummy-video-content-bytes"));

  const config = loadConfig({
    APPWRITE_ENDPOINT: "https://cloud.appwrite.io/v1",
    APPWRITE_PROJECT_ID: "proj-123",
    APPWRITE_API_KEY: "appwrite-secret-key",
    APPWRITE_BUCKET_ID: "videos",
  });

  const calls: Array<{ url: string; headers: Headers; method: string }> = [];

  const mockFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      method: init?.method || "GET",
    });
    return new Response(JSON.stringify({ $id: "file-xyz", bucketId: "videos" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await uploadVideoToStorage(videoFile, config, { fetch: mockFetch });

    assert.equal(result.provider, "appwrite");
    assert.equal(result.bucket, "videos");
    assert.equal(result.objectKey, "shorts/file-xyz");
    assert.equal(
      result.publicUrl,
      "https://cloud.appwrite.io/v1/storage/buckets/videos/files/file-xyz/view?project=proj-123",
    );
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://cloud.appwrite.io/v1/storage/buckets/videos/files",
    );
    assert.equal(calls[0]?.headers.get("x-appwrite-project"), "proj-123");
    assert.equal(calls[0]?.headers.get("x-appwrite-key"), "appwrite-secret-key");
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
