import { google } from "googleapis";

export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

export interface YouTubeOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface YouTubeOAuthTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string;
  token_type?: string | null;
  expiry_date?: number | null;
}

export interface YouTubeOAuthClient {
  generateAuthUrl(options: {
    access_type: "offline";
    include_granted_scopes: true;
    prompt: "consent" | "select_account";
    scope: readonly string[];
    state: string;
  }): string;
  getToken(code: string): Promise<{ tokens: YouTubeOAuthTokens }>;
  setCredentials(tokens: YouTubeOAuthTokens): void;
}

export interface OAuthDependencies {
  createClient?: (clientId: string, clientSecret: string, redirectUri: string) => YouTubeOAuthClient;
}

export interface AuthorizationUrlOptions {
  /** A cryptographically random value retained by the calling web session. */
  state: string;
  /** `consent` is the default so the first authorization can issue a refresh token. */
  prompt?: "consent" | "select_account";
}

export class YouTubeOAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "YouTubeOAuthError";
  }
}

function requireNonEmpty(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new YouTubeOAuthError(`${label} must be a non-empty string`);
  }
}

export function createYouTubeOAuthClient(
  config: YouTubeOAuthConfig,
  dependencies: OAuthDependencies = {},
): YouTubeOAuthClient {
  requireNonEmpty("clientId", config.clientId);
  requireNonEmpty("clientSecret", config.clientSecret);
  requireNonEmpty("redirectUri", config.redirectUri);

  const createClient =
    dependencies.createClient ??
    ((clientId: string, clientSecret: string, redirectUri: string) =>
      new google.auth.OAuth2(clientId, clientSecret, redirectUri) as unknown as YouTubeOAuthClient);

  return createClient(config.clientId, config.clientSecret, config.redirectUri);
}

export function createYouTubeAuthorizationUrl(
  client: YouTubeOAuthClient,
  options: AuthorizationUrlOptions,
): string {
  requireNonEmpty("OAuth state", options.state);
  if (options.state.length < 16) {
    throw new YouTubeOAuthError("OAuth state must contain at least 16 characters");
  }

  return client.generateAuthUrl({
    access_type: "offline",
    include_granted_scopes: true,
    prompt: options.prompt ?? "consent",
    scope: [YOUTUBE_UPLOAD_SCOPE],
    state: options.state,
  });
}

export async function exchangeYouTubeAuthorizationCode(
  client: YouTubeOAuthClient,
  code: string,
): Promise<YouTubeOAuthTokens> {
  requireNonEmpty("authorization code", code);

  try {
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    return tokens;
  } catch (cause) {
    throw new YouTubeOAuthError("Unable to exchange the YouTube authorization code", { cause });
  }
}

export function applyYouTubeOAuthTokens(
  client: YouTubeOAuthClient,
  tokens: YouTubeOAuthTokens,
): void {
  if (!tokens.refresh_token && !tokens.access_token) {
    throw new YouTubeOAuthError("OAuth tokens must include an access token or refresh token");
  }
  client.setCredentials(tokens);
}

