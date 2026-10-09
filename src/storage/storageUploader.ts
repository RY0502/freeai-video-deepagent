import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";

export interface StorageUploadResult {
  provider: "convex" | "appwrite";
  bucket: string;
  objectKey: string;
  publicUrl: string;
  bytes: number;
  sha256: string;
  storageId?: string;
}

function formatAuthHeader(key: string): string {
  const trimmed = key.trim();
  if (trimmed.startsWith("Bearer ") || trimmed.startsWith("Convex ")) {
    return trimmed;
  }
  if (trimmed.startsWith("dev:") || trimmed.startsWith("prod:") || trimmed.includes("|")) {
    return `Convex ${trimmed}`;
  }
  return `Bearer ${trimmed}`;
}

export interface StorageUploaderOptions {
  fetch?: typeof fetch;
}

/**
 * Uploads a video file to the 'shorts' directory in the configured storage bucket
 * (Convex File Storage or Appwrite Storage).
 * In Convex, the file is uploaded to file storage and its metadata (storageId, bucket, virtual path,
 * public URL) is recorded in the Convex database `storedFiles` table for segregation.
 */
export async function uploadVideoToStorage(
  videoFilePath: string,
  config: AppConfig,
  options: StorageUploaderOptions = {},
): Promise<StorageUploadResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const resolvedPath = path.resolve(videoFilePath);

  let fileStats;
  try {
    fileStats = await stat(resolvedPath);
  } catch (error) {
    throw new Error(`Video file not found for storage upload: ${resolvedPath}`);
  }

  if (!fileStats.isFile() || fileStats.size === 0) {
    throw new Error(`Video file is empty or not a regular file: ${resolvedPath}`);
  }

  const bytes = await readFile(resolvedPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const fileName = path.basename(resolvedPath);
  const objectKey = `shorts/${fileName}`;

  // Check Convex configuration first
  const convexUrl = (config.CONVEX_URL || "").trim().replace(/\/+$/, "");
  const convexBucket = (config.CONVEX_STORAGE_BUCKET || "shared").trim();
  const convexDeployKey = (config.CONVEX_DEPLOY_KEY || "").trim();

  if (convexUrl) {
    // 1. Generate upload URL via Convex mutation files:generateUploadUrl
    const mutationUrl = `${convexUrl}/api/mutation`;
    const authHeaders: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (convexDeployKey) {
      authHeaders.authorization = formatAuthHeader(convexDeployKey);
    }

    const genUrlResponse = await fetchImpl(mutationUrl, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        path: "files:generateUploadUrl",
        args: {},
        format: "json",
      }),
    });

    if (!genUrlResponse.ok) {
      let detail = "";
      try { detail = await genUrlResponse.text(); } catch {}
      throw new Error(`Failed to generate Convex upload URL (HTTP ${genUrlResponse.status})${detail ? `: ${detail}` : ""}`);
    }

    const genUrlResult = await genUrlResponse.json() as { status?: string; value?: string; errorMessage?: string };
    if (genUrlResult.status === "error" || !genUrlResult.value) {
      throw new Error(`Failed to generate Convex upload URL: ${genUrlResult.errorMessage || "No upload URL returned"}`);
    }
    const uploadUrl = genUrlResult.value;

    // 2. Upload video bytes to the upload URL
    const uploadResponse = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        "content-type": "video/mp4",
      },
      body: new Uint8Array(bytes),
    });

    if (!uploadResponse.ok) {
      let detail = "";
      try { detail = await uploadResponse.text(); } catch {}
      throw new Error(`Failed to upload video to Convex Storage (HTTP ${uploadResponse.status})${detail ? `: ${detail}` : ""}`);
    }

    const uploadResult = await uploadResponse.json() as { storageId?: string };
    const storageId = uploadResult.storageId;
    if (!storageId) {
      throw new Error("Convex upload succeeded but returned no storageId.");
    }

    // 3. Save file metadata in Convex database storedFiles table
    const saveResponse = await fetchImpl(mutationUrl, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        path: "files:saveFile",
        args: {
          storageId,
          bucket: convexBucket,
          path: objectKey,
          fileName,
          contentType: "video/mp4",
          size: bytes.length,
          sha256,
        },
        format: "json",
      }),
    });

    if (!saveResponse.ok) {
      let detail = "";
      try { detail = await saveResponse.text(); } catch {}
      throw new Error(`Failed to save video metadata in Convex database (HTTP ${saveResponse.status})${detail ? `: ${detail}` : ""}`);
    }

    const saveResult = await saveResponse.json() as {
      status?: string;
      value?: { url?: string; storageId?: string };
      errorMessage?: string;
    };
    if (saveResult.status === "error" || !saveResult.value) {
      throw new Error(`Failed to save video metadata in Convex: ${saveResult.errorMessage || "Unknown error"}`);
    }

    const publicUrl = saveResult.value.url ?? `${convexUrl}/api/storage/${storageId}`;

    return {
      provider: "convex",
      bucket: convexBucket,
      objectKey,
      publicUrl,
      bytes: bytes.length,
      sha256,
      storageId,
    };
  }

  // Appwrite REST storage fallback if configured
  const appwriteEndpoint = (config.APPWRITE_ENDPOINT || "").trim().replace(/\/+$/, "");
  const appwriteProject = (config.APPWRITE_PROJECT_ID || "").trim();
  const appwriteKey = (config.APPWRITE_API_KEY || "").trim();
  const appwriteBucket = (config.APPWRITE_BUCKET_ID || "shorts").trim();

  if (appwriteEndpoint && appwriteProject && appwriteKey) {
    const formData = new FormData();
    formData.append("fileId", "unique()");
    const fileBlob = new Blob([new Uint8Array(bytes)], { type: "video/mp4" });
    formData.append("file", fileBlob, fileName);

    const uploadUrl = `${appwriteEndpoint}/storage/buckets/${encodeURIComponent(appwriteBucket)}/files`;
    const response = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        "X-Appwrite-Project": appwriteProject,
        "X-Appwrite-Key": appwriteKey,
      },
      body: formData,
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      throw new Error(
        `Failed to upload video to Appwrite Storage (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }

    let fileId = "";
    try {
      const json = await response.json() as Record<string, unknown>;
      fileId = String(json.$id || "");
    } catch {
      // ignore
    }

    const publicUrl = `${appwriteEndpoint}/storage/buckets/${encodeURIComponent(appwriteBucket)}/files/${encodeURIComponent(fileId)}/view?project=${encodeURIComponent(appwriteProject)}`;

    return {
      provider: "appwrite",
      bucket: appwriteBucket,
      objectKey: `shorts/${fileId || fileName}`,
      publicUrl,
      bytes: bytes.length,
      sha256,
    };
  }

  throw new Error(
    "Storage upload failed: no credentials configured. Set CONVEX_URL or APPWRITE_API_KEY.",
  );
}
