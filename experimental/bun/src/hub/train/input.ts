// The checks a tool's input gets in the Rust hub from its contract types (serde, `brand!` patterns, `IntOr`), for the
// train's, the reviews' and the PR views' tools: a value that doesn't fit is refused as `invalid`.
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { ALL_STATES } from "./records.ts";

type Input = Record<string, unknown>;

const invalid = (message: string) => new ToolError("invalid", message);

/** `IntOr<MIN, MAX, DEFAULT>`: `fallback` when absent, refused outside `[min, max]`. */
export function intOr(input: Input, key: string, min: number, max: number, fallback: number): number {
  const v = input[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw invalid(`${key}: expected an integer from ${min} to ${max}`);
  }
  return v;
}

/** `Positive`. */
export function positive(input: Input, key: string): number {
  const v = input[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw invalid(`${key}: expected a positive integer`);
  return v;
}

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** `GitHubRepo`: `owner/name`. */
export function repo(input: Input, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || !REPO.test(v)) throw invalid(`${key}: expected a GitHub repo owner/name`);
  return v;
}

export function optionalRepo(input: Input, key: string): string | undefined {
  return input[key] === undefined || input[key] === null ? undefined : repo(input, key);
}

/** `Text<MIN, MAX>`, counted in characters. */
export function text(input: Input, key: string, min: number, max: number): string {
  const v = input[key];
  const n = typeof v === "string" ? [...v].length : -1;
  if (typeof v !== "string" || n < min || n > max) throw invalid(`${key}: expected text of ${min} to ${max} characters`);
  return v;
}

export function optionalText(input: Input, key: string, min: number, max: number): string | undefined {
  return input[key] === undefined || input[key] === null ? undefined : text(input, key, min, max);
}

/** `ProjectRef`. */
export function projectRef(input: Input, key: string): ProjectRef {
  const v = input[key] as Record<string, unknown> | undefined;
  if (!v || typeof v.machineId !== "string" || typeof v.projectId !== "string" || v.machineId === "" || v.projectId === "") {
    throw invalid(`${key}: expected { machineId, projectId }`);
  }
  return { machineId: v.machineId, projectId: v.projectId };
}

export function optionalProjectRef(input: Input, key: string): ProjectRef | undefined {
  return input[key] === undefined || input[key] === null ? undefined : projectRef(input, key);
}

export function optionalState(input: Input, key: string) {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(ALL_STATES as string[]).includes(v)) throw invalid(`${key}: expected a Change state`);
  return v as (typeof ALL_STATES)[number];
}
