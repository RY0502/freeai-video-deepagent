import "dotenv/config";
import { z } from "zod";

const booleanFromEnv = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const envSchema = z.object({
  AGNES_BASE_URL: z.string().url().default("https://apihub.agnes-ai.com"),
  AGNES_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  AGNES_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  AGNES_POLL_WINDOW_MS: z.coerce.number().int().min(1_000).default(480_000),
  AGNES_MAX_DOWNLOAD_BYTES: z.coerce.number().int().min(1_000_000).default(500_000_000),
  FREE_AI_BASE_URL: z.string().url().default("https://api.free.ai"),
  FREE_AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
  FREE_AI_RETRY_DELAY_MS: z.coerce.number().int().min(0).default(6_000),
  FREE_AI_MUSIC_MAX_DOWNLOAD_BYTES: z.coerce.number().int().min(1_000_000).default(64 * 1024 * 1024),
  ELEVENLABS_BASE_URL: z.string().url().default("https://api.elevenlabs.io"),
  ELEVENLABS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
  VIDEO_ASPECT_RATIO: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).default("16:9"),
  VIDEO_STYLE: z
    .enum([
      "cinematic",
      "animation",
      "realistic",
      "artistic",
      "vintage",
      "anime",
      "film-noir",
      "documentary",
      "commercial",
      "music-video",
    ])
    .default("cinematic"),
  VIDEO_FPS: z.coerce.number().int().min(12).max(60).default(24),
  VIDEO_OUTPUT_ROOT: z.string().min(1).default("./runs"),
  VIDEO_MUSIC_VOLUME: z.coerce.number().min(0).max(2).default(0.10),
  VIDEO_FOLEY_VOLUME: z.coerce.number().min(0).max(2).default(1),
  YOUTUBE_UPLOAD_ENABLED: booleanFromEnv.default("false"),
  YOUTUBE_CLIENT_ID: z.string().default(""),
  YOUTUBE_CLIENT_SECRET: z.string().default(""),
  YOUTUBE_REDIRECT_URI: z.string().url().default("http://127.0.0.1:53682/oauth2/callback"),
  YOUTUBE_REFRESH_TOKEN: z.string().default(""),
  YOUTUBE_DEFAULT_PRIVACY: z.enum(["private", "unlisted", "public"]).default("private"),
  YOUTUBE_DEFAULT_MADE_FOR_KIDS: booleanFromEnv.default("false"),
  YOUTUBE_DEFAULT_CONTAINS_SYNTHETIC_MEDIA: booleanFromEnv.default("true"),
}).superRefine((config, context) => {
  if (config.AGNES_POLL_INTERVAL_MS > config.AGNES_POLL_WINDOW_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AGNES_POLL_INTERVAL_MS"],
      message: "AGNES_POLL_INTERVAL_MS must not exceed AGNES_POLL_WINDOW_MS",
    });
  }
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}

export function assertYouTubeConfig(config: AppConfig): void {
  if (!config.YOUTUBE_UPLOAD_ENABLED) {
    throw new Error("YouTube upload is disabled. Set YOUTUBE_UPLOAD_ENABLED=true to opt in.");
  }
  const missing = [
    ["YOUTUBE_CLIENT_ID", config.YOUTUBE_CLIENT_ID],
    ["YOUTUBE_CLIENT_SECRET", config.YOUTUBE_CLIENT_SECRET],
    ["YOUTUBE_REFRESH_TOKEN", config.YOUTUBE_REFRESH_TOKEN],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing YouTube environment variables: ${missing.join(", ")}`);
  }
}
