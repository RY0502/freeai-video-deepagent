import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";

export interface StorageUploadResult {
  provider: "supabase" | "appwrite";
  bucket: string;
  objectKey: string;
  publicUrl: string;
  bytes: number;
  sha256: string;
}

export interface StorageUploaderOptions {
  fetch?: typeof fetch;
}

/**
 * Uploads a video file to the 'shorts' directory in the configured storage bucket
 * (Supabase Storage or Appwrite Storage).
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

  // Check Supabase configuration first (referencing C:\work\content-generator-video)
  const supabaseKey = (config.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const supabaseUrl = (config.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const supabaseBucket = (config.SUPABASE_STORAGE_BUCKET || "shared").trim();

  if (supabaseKey && supabaseUrl) {
    const uploadUrl = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(supabaseBucket)}/shorts/${encodeURIComponent(fileName)}`;
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(supabaseBucket)}/shorts/${encodeURIComponent(fileName)}`;

    const response = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        apikey: supabaseKey,
        authorization: `Bearer ${supabaseKey}`,
        "cache-control": "3600",
        "content-type": "video/mp4",
        "x-upsert": "true",
      },
      body: new Uint8Array(bytes),
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      throw new Error(
        `Failed to upload video to Supabase Storage (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }

    return {
      provider: "supabase",
      bucket: supabaseBucket,
      objectKey,
      publicUrl,
      bytes: bytes.length,
      sha256,
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
    "Storage upload failed: no credentials configured. Set SUPABASE_SERVICE_ROLE_KEY or APPWRITE_API_KEY.",
  );
}
