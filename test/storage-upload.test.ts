import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { uploadVideoToStorage } from "../src/storage/index.js";
import { loadConfig } from "../src/config.js";

test("uploadVideoToStorage fails if file does not exist", async () => {
  const config = loadConfig({
    SUPABASE_SERVICE_ROLE_KEY: "secret-key",
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_STORAGE_BUCKET: "shared",
  });

  await assert.rejects(
    uploadVideoToStorage("c:/non-existent-video.mp4", config),
    (err: unknown) => err instanceof Error && err.message.includes("not found"),
  );
});

test("uploadVideoToStorage uploads to Supabase storage under 'shorts' directory", async () => {
  const testDir = path.join(tmpdir(), `storage-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  const videoFile = path.join(testDir, "test-output.mp4");
  await writeFile(videoFile, Buffer.from("dummy-video-content-bytes"));

  const config = loadConfig({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_STORAGE_BUCKET: "shared",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  });

  const calls: Array<{ url: string; headers: Headers; method: string }> = [];

  const mockFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      method: init?.method || "GET",
    });
    return new Response(JSON.stringify({ Key: "shared/shorts/test-output.mp4" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await uploadVideoToStorage(videoFile, config, { fetch: mockFetch });

    assert.equal(result.provider, "supabase");
    assert.equal(result.bucket, "shared");
    assert.equal(result.objectKey, "shorts/test-output.mp4");
    assert.equal(
      result.publicUrl,
      "https://example.supabase.co/storage/v1/object/public/shared/shorts/test-output.mp4",
    );
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://example.supabase.co/storage/v1/object/shared/shorts/test-output.mp4",
    );
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.get("apikey"), "service-role-secret");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer service-role-secret");
    assert.equal(calls[0]?.headers.get("content-type"), "video/mp4");
    assert.equal(calls[0]?.headers.get("x-upsert"), "true");
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
