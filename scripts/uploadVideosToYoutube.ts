import "dotenv/config";
import { existsSync, statSync, createReadStream, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import { loadConfig, type AppConfig } from "../src/config.js";

export function getLocalDate(date: Date, timeZone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export interface VideoUploadCandidate {
  runId: string;
  runDirectory: string;
  createdAt: string;
  originalPrompt: string;
  videoPath: string;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: string;
  madeForKids: boolean;
}

export interface StandaloneUploadOptions {
  targetRunId?: string;
  forceUpload?: boolean;
  config?: AppConfig;
}

export interface StandaloneUploadResult {
  uploaded: boolean;
  runId?: string;
  videoId?: string;
  videoUrl?: string;
  reason?: string;
}

function sanitizeText(value: string, maxLength: number): string {
  return value.replace(/[<>]/g, "").trim().slice(0, maxLength);
}

function sanitizeTags(tags: readonly string[], maxTotalChars = 400, maxTags = 10): string[] {
  const result: string[] = [];
  let totalLength = 0;
  for (const tag of tags) {
    const cleaned = tag.replace(/[<>]/g, "").trim();
    if (!cleaned) continue;
    if (result.length >= maxTags) break;
    if (totalLength + cleaned.length + 1 > maxTotalChars) break;
    if (!result.includes(cleaned)) {
      result.push(cleaned);
      totalLength += cleaned.length + 1;
    }
  }
  return result.length > 0 ? result : ["ai video", "shorts"];
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Standalone YouTube uploader:
 * 1. Checks 1 video per day quota (via disk state).
 * 2. Scans runs on disk for completed videos pending upload.
 * 3. Orders candidates by video creation timestamp ascending (oldest first).
 * 4. Uploads exactly one video per run and updates disk state.
 */
export async function uploadNextAvailableVideo(
  options: StandaloneUploadOptions = {},
): Promise<StandaloneUploadResult> {
  console.log("=================================================");
  console.log(">>> STANDALONE YOUTUBE UPLOADER (1/DAY GATE) <<<");
  console.log("=================================================");

  const config = options.config ?? loadConfig();

  // 1. Verify YouTube API Credentials
  if (!config.YOUTUBE_CLIENT_ID || !config.YOUTUBE_CLIENT_SECRET || !config.YOUTUBE_REFRESH_TOKEN) {
    const msg = "YouTube API credentials not configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN.";
    console.error(`[YouTube Uploader] Error: ${msg}`);
    return { uploaded: false, reason: msg };
  }

  const outputRoot = path.resolve(config.VIDEO_OUTPUT_ROOT);
  if (!existsSync(outputRoot)) {
    const reason = `Output root does not exist: ${outputRoot}`;
    console.log(`[YouTube Uploader] ${reason}`);
    return { uploaded: false, reason };
  }

  const now = new Date();
  const timeZone = config.EPISODE_DAILY_TIMEZONE || "Asia/Kolkata";
  const today = getLocalDate(now, timeZone);
  console.log(`[YouTube Uploader] Calendar Date: ${today} (${timeZone})`);

  // 2. Read disk state and check 1 video per day quota
  const runEntries = readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (!options.forceUpload) {
    for (const runId of runEntries) {
      const pipelinePath = path.join(outputRoot, runId, "pipeline-state.json");
      const pipeline = readJsonSafe<any>(pipelinePath);
      if (!pipeline?.checkpoints) continue;

      const ytCheckpoint = pipeline.checkpoints["video:checkpoint:youtube:upload"];
      if (ytCheckpoint?.status === "completed" && ytCheckpoint.externalId) {
        const uploadedAt = ytCheckpoint.updatedAt || ytCheckpoint.startedAt;
        if (uploadedAt) {
          const uploadDate = getLocalDate(new Date(uploadedAt), timeZone);
          if (uploadDate === today) {
            const reason = `Daily upload limit reached (1 video per day). Run ${runId} was already uploaded today (${uploadedAt}).`;
            console.log(`[YouTube Uploader] ⏳ ${reason}`);
            return { uploaded: false, reason };
          }
        }
      }
    }
  }

  // 3. Find candidates on disk that need upload
  const candidates: VideoUploadCandidate[] = [];

  for (const runId of runEntries) {
    if (options.targetRunId && options.targetRunId !== runId) continue;

    const runDir = path.join(outputRoot, runId);
    const pipelinePath = path.join(runDir, "pipeline-state.json");
    const pipeline = readJsonSafe<any>(pipelinePath);
    if (!pipeline?.checkpoints) continue;

    const ytCheckpoint = pipeline.checkpoints["video:checkpoint:youtube:upload"];
    if (ytCheckpoint?.status === "completed" && ytCheckpoint.externalId) {
      // Already uploaded
      continue;
    }

    const assemblyCheckpoint = pipeline.checkpoints["video:checkpoint:assembly:final"];
    if (assemblyCheckpoint?.status !== "completed" || !assemblyCheckpoint.path) {
      // Assembly not complete
      continue;
    }

    const videoPath = path.resolve(assemblyCheckpoint.path);
    if (!existsSync(videoPath)) {
      console.warn(`[YouTube Uploader] Skipping run ${runId}: output video ${videoPath} not found on disk.`);
      continue;
    }

    const fileStat = statSync(videoPath);
    if (fileStat.size <= 0) {
      console.warn(`[YouTube Uploader] Skipping run ${runId}: output video is empty.`);
      continue;
    }

    // Determine creation timestamp
    const manifest = pipeline.manifest || {};
    const runJson = readJsonSafe<any>(path.join(runDir, "run.json")) || {};
    const planJson = readJsonSafe<any>(path.join(runDir, "plan.json")) || {};

    const createdAt = manifest.createdAt
      || runJson.createdAt
      || assemblyCheckpoint.startedAt
      || fileStat.birthtime.toISOString();

    const originalPrompt = manifest.originalPrompt || runJson.originalPrompt || "";

    // Metadata extraction
    const planYt = planJson.youtubeUpload;
    const title = sanitizeText(
      planYt?.title || planJson.concept || originalPrompt.split("\n")[0] || `AI Video ${runId.slice(0, 8)}`,
      100,
    );
    const description = sanitizeText(
      planYt?.description || planJson.creativeScript || planJson.concept || originalPrompt,
      5000,
    );
    const tags = sanitizeTags(
      Array.isArray(planYt?.tags) ? planYt.tags : ["ai video", "cinematic", "shorts"],
    );
    const categoryId = String(planYt?.categoryId || "24");
    const privacyStatus = planYt?.privacyStatus || config.YOUTUBE_DEFAULT_PRIVACY || "private";
    const madeForKids = planYt?.madeForKids ?? config.YOUTUBE_DEFAULT_MADE_FOR_KIDS;

    candidates.push({
      runId,
      runDirectory: runDir,
      createdAt,
      originalPrompt,
      videoPath,
      title,
      description,
      tags,
      categoryId,
      privacyStatus,
      madeForKids,
    });
  }

  if (candidates.length === 0) {
    const reason = "No available on-disk videos pending upload.";
    console.log(`[YouTube Uploader] ${reason}`);
    return { uploaded: false, reason };
  }

  // 4. Sort candidates by video creation timestamp ascending (oldest first)
  candidates.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const candidate = candidates[0]!;
  console.log(`\n[YouTube Uploader] Selected for upload: Run ${candidate.runId} (Created: ${candidate.createdAt})`);
  console.log(`[YouTube Uploader] Video File: ${candidate.videoPath}`);
  console.log(`[YouTube Uploader] Title: "${candidate.title}"`);

  // 5. OAuth2 Client Setup
  const oauth2Client = new google.auth.OAuth2(
    config.YOUTUBE_CLIENT_ID,
    config.YOUTUBE_CLIENT_SECRET,
    config.YOUTUBE_REDIRECT_URI || "http://127.0.0.1:53682/oauth2/callback",
  );
  oauth2Client.setCredentials({ refresh_token: config.YOUTUBE_REFRESH_TOKEN });

  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  // 6. Upload Video
  console.log(`[YouTube Uploader] Starting upload to YouTube (privacyStatus: ${candidate.privacyStatus}, categoryId: ${candidate.categoryId})...`);
  const fileStat = statSync(candidate.videoPath);
  console.log(`[YouTube Uploader] File size: ${(fileStat.size / (1024 * 1024)).toFixed(2)} MB`);

  const uploadStartedAt = new Date().toISOString();
  const uploadResponse = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: candidate.title,
        description: candidate.description,
        tags: candidate.tags,
        categoryId: candidate.categoryId,
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
      },
      status: {
        privacyStatus: candidate.privacyStatus,
        selfDeclaredMadeForKids: candidate.madeForKids,
        embeddable: true,
        publicStatsViewable: true,
      },
    },
    media: {
      body: createReadStream(candidate.videoPath),
    },
  });

  const videoId = uploadResponse.data.id;
  if (!videoId) {
    throw new Error("YouTube upload succeeded but no video ID was returned.");
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[YouTube Uploader] ✅ Upload successful! Video ID: ${videoId} | URL: ${videoUrl}`);

  // 7. Update disk state (pipeline-state.json)
  console.log("[YouTube Uploader] Finalizing upload state in pipeline-state.json on disk...");
  const pipelinePath = path.join(candidate.runDirectory, "pipeline-state.json");
  const pipeline = readJsonSafe<any>(pipelinePath) || { schemaVersion: 2, manifest: {}, checkpoints: {} };

  const existingYt = pipeline.checkpoints["video:checkpoint:youtube:upload"];
  const completedAt = new Date().toISOString();

  pipeline.checkpoints["video:checkpoint:youtube:upload"] = {
    schemaVersion: 2,
    status: "completed",
    attempt: (existingYt?.attempt || 0) + 1,
    path: candidate.videoPath,
    url: videoUrl,
    externalId: videoId,
    provider: "youtube",
    model: "youtube-data-api-v3",
    details: {
      title: candidate.title,
      description: candidate.description,
      tags: candidate.tags,
      categoryId: candidate.categoryId,
      privacyStatus: candidate.privacyStatus,
      madeForKids: candidate.madeForKids,
    },
    startedAt: uploadStartedAt,
    updatedAt: completedAt,
  };

  if (pipeline.manifest) {
    pipeline.manifest.updatedAt = completedAt;
  }

  writeJsonAtomic(pipelinePath, pipeline);

  console.log("=================================================");
  console.log(`>>> UPLOAD COMPLETE: Run ${candidate.runId} <<<`);
  console.log(`Video URL: ${videoUrl}`);
  console.log("=================================================\n");

  return {
    uploaded: true,
    runId: candidate.runId,
    videoId,
    videoUrl,
  };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("uploadVideosToYoutube.ts")) {
  uploadNextAvailableVideo()
    .then((result) => {
      if (!result.uploaded) {
        console.log(`[Result]: ${result.reason}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("[Fatal Error]:", err);
      process.exit(1);
    });
}
