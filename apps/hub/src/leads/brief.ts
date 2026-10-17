import { createHash } from "node:crypto";
import type { Brief } from "@fleetd/contracts";

/** JSON with object keys sorted at every level and no whitespace, so equal briefs always hash the same. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** sha256 of the brief's canonical JSON, lowercase hex. */
export const briefHash = (brief: Brief): string => createHash("sha256").update(canonicalJson(brief)).digest("hex");
