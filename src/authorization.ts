const YOUTUBE_UPLOAD_AUTHORIZATION_MARKER = "[[host-authorized-youtube-upload:v1]]";

/** Remove host-only control-plane text before deriving user-visible metadata. */
export function stripYouTubeUploadAuthorization(prompt: string): string {
  const trimmed = prompt.trim();
  return trimmed.toLowerCase().endsWith(YOUTUBE_UPLOAD_AUTHORIZATION_MARKER)
    ? trimmed.slice(0, -YOUTUBE_UPLOAD_AUTHORIZATION_MARKER.length).trim()
    : trimmed;
}

/**
 * Bind an explicit CLI capability to the immutable prompt/run hash. User text
 * cannot manufacture the reserved marker: every new CLI run passes through
 * this function before the marker is optionally appended.
 */
export function bindYouTubeUploadAuthorization(
  userPrompt: string,
  authorized: boolean,
): string {
  const prompt = userPrompt.trim();
  if (prompt.toLowerCase().includes(YOUTUBE_UPLOAD_AUTHORIZATION_MARKER)) {
    throw new Error("The video prompt contains a reserved host authorization marker.");
  }
  return authorized
    ? `${prompt}\n\n${YOUTUBE_UPLOAD_AUTHORIZATION_MARKER}`
    : prompt;
}

/** True only for a prompt/run explicitly capability-bound by the host CLI. */
export function promptExplicitlyRequestsYouTubeUpload(prompt: string): boolean {
  return prompt.trim().toLowerCase().endsWith(YOUTUBE_UPLOAD_AUTHORIZATION_MARKER);
}
