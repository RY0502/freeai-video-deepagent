const INDEXED_KEY = /^ELEVENLABS_API_KEY_(\d+)$/;

export function normalizeElevenLabsApiKeys(
  values: readonly (string | undefined)[],
): string[] {
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

/** Discover numbered keys in numeric order, allowing gaps and ignoring duplicates. */
export function loadElevenLabsApiKeys(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return normalizeElevenLabsApiKeys(Object.entries(env)
    .map(([name, value]) => {
      const match = INDEXED_KEY.exec(name);
      return match ? { index: Number(match[1]), value } : undefined;
    })
    .filter((entry): entry is { index: number; value: string | undefined } => Boolean(entry))
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.value));
}

export function elevenLabsKeyLabel(index: number): string {
  return `key-${index + 1}`;
}

export function redactElevenLabsSecrets(
  value: unknown,
  keys: readonly string[] = [],
): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  for (const key of keys) {
    if (key) text = text.split(key).join("[redacted]");
  }
  return text.replace(/\bsk_[A-Za-z0-9._-]{8,}\b/g, "[redacted]");
}

export function sanitizeElevenLabsSecrets(
  value: unknown,
  keys: readonly string[] = [],
): unknown {
  const seen = new WeakSet<object>();
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") return redactElevenLabsSecrets(entry, keys);
    if (entry === null || typeof entry !== "object") return entry;
    if (seen.has(entry)) return "[circular]";
    seen.add(entry);
    if (Array.isArray(entry)) return entry.map(visit);
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
      .map(([name, nested]) => [redactElevenLabsSecrets(name, keys), visit(nested)]));
  };
  return visit(value);
}

