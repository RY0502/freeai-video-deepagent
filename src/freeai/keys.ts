const INDEXED_AUDIO_KEY = /^FREE_AI_API_AUDIO_KEY_(\d+)$/;

export function normalizeFreeAiMusicKeys(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const value of values) {
    const key = value?.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** Load audio-only keys numerically, allowing gaps and removing duplicates. */
export function loadFreeAiMusicKeys(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return normalizeFreeAiMusicKeys(Object.entries(env)
    .map(([name, value]) => {
      const match = INDEXED_AUDIO_KEY.exec(name);
      return match ? { index: Number(match[1]), value } : undefined;
    })
    .filter((entry): entry is { index: number; value: string | undefined } => Boolean(entry))
    .sort((left, right) => left.index - right.index)
    .map(({ value }) => value));
}

export function freeAiMusicKeyLabel(index: number): string {
  return `key-${index + 1}`;
}

/** Redact configured credentials and provider-shaped bearer tokens. */
export function redactFreeAiMusicSecrets(value: unknown, keys: readonly string[] = []): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  for (const key of keys) {
    if (key) text = text.split(key).join("[redacted]");
  }
  return text
    .replace(/sk-free-[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/https?:\/\/[^\s\"'<>?]+\?[^\s\"'<>]+/gi, "[redacted signed URL]");
}
