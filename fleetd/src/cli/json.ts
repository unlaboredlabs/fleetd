// JSON as serde_json prints a `Value`: keys sorted (no `preserve_order`), no spaces.
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

export const jsonText = (value: unknown) => JSON.stringify(sortKeys(value));
