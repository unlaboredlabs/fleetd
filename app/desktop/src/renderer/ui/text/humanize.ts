/**
 * A readable label from an internal key, for old records that carry only a key ("public-snapshot" →
 * "Public snapshot"). New data must carry real labels; this is the fallback that keeps old data from showing slugs.
 */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_.\s/]+/)
    .filter(Boolean)
    // A leading option letter or number ("a-monthly", "2_retry") is an index, not part of the meaning.
    .filter((w, i, all) => !(i === 0 && all.length > 1 && /^([a-z]|\d+)$/i.test(w)))
    .map((w) => w.toLowerCase());
  if (words.length === 0) return key;
  const [first = "", ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}
