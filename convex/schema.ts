import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Convex database schema for file storage segregation.
 * Convex file storage assigns opaque storageId values without directories.
 * This table indexes files by bucket (namespace) and virtual directory path,
 * allowing directory-like organization, metadata tracking, and deterministic lookup.
 */
export default defineSchema({
  storedFiles: defineTable({
    storageId: v.id("_storage"),
    path: v.string(), // Virtual directory path (e.g., "series_1/characters/pip_the_ant.png" or "shorts/video.mp4")
    bucket: v.string(), // Bucket / namespace (e.g., "agnes-character-references", "shorts", "shared")
    fileName: v.string(),
    contentType: v.string(),
    size: v.number(),
    sha256: v.optional(v.string()),
    url: v.optional(v.string()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_bucket_and_path", ["bucket", "path"])
    .index("by_bucket", ["bucket"])
    .index("by_path", ["path"])
    .index("by_storageId", ["storageId"]),
});
