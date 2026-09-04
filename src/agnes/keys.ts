import { createHash } from "node:crypto";

const INDEXED_AGNES_KEY = /^AGNES_API_KEY_(\d+)$/;

function normalizeKeys(values: readonly (string | undefined)[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const candidate of values) {
    const key = candidate?.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** Discover numbered keys in numeric order, allowing gaps and removing duplicates. */
export function loadAgnesApiKeys(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const indexed = normalizeKeys(Object.entries(env)
    .map(([name, value]) => {
      const match = INDEXED_AGNES_KEY.exec(name);
      return match ? { index: Number(match[1]), value } : undefined;
    })
    .filter((entry): entry is { index: number; value: string | undefined } => Boolean(entry))
    .sort((left, right) => left.index - right.index)
    .map(({ value }) => value));

  return indexed.length > 0 ? indexed : normalizeKeys([env.AGNES_API_KEY]);
}

export function normalizeAgnesApiKeys(keys: readonly string[]): string[] {
  return normalizeKeys(keys);
}

export function fingerprintAgnesKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function agnesKeyLabel(index: number): string {
  return `key-${index + 1}`;
}

/** Convert diagnostics to text and remove configured credentials and bearer capabilities. */
export function redactAgnesSecrets(
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

  return text
    .replace(/(bearer\s+)[^\s,"'}]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s"'<>?]+\?[^\s"'<>]+/gi, "[redacted signed URL]");
}

/** Deep-clone provider diagnostics while removing configured credentials. */
export function sanitizeAgnesSecrets(
  value: unknown,
  keys: readonly string[] = [],
): unknown {
  const seen = new WeakSet<object>();
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") return redactAgnesSecrets(entry, keys);
    if (entry === null || typeof entry !== "object") return entry;
    if (seen.has(entry)) return "[circular]";
    seen.add(entry);
    if (Array.isArray(entry)) return entry.map(visit);
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
      .map(([name, nested]) => [redactAgnesSecrets(name, keys), visit(nested)]));
  };
  return visit(value);
}
