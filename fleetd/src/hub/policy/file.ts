// The repo policy file `.fleetd/policy.yaml` as text: its path, what it may say and how it is read, with no hub
// behind it (reading it from a checkout and caching it is index.ts).
import { ToolError } from "../../shared/errors.ts";

export const POLICY_FILE_PATH = ".fleetd/policy.yaml";
export const DEFAULT_BRANCH_PREFIX = "fleetd/";
export const POLICY_TTL_MS = 60_000;
const EXAMPLE = 'tools:\n  deny: ["Bash(git push:*)"]';

/** The repo policy file, as decoded. Keys it doesn't know are ignored. */
export type PolicyFile = { tools?: { allow: string[]; deny: string[] }; branchPrefix?: string };

function invalid(problem: string): ToolError {
  return new ToolError(
    "invalid",
    [...`${POLICY_FILE_PATH} is invalid: ${problem}`].slice(0, 1000).join(""),
    `Fix ${POLICY_FILE_PATH} in the project's checkout on its machine. For example:\n${EXAMPLE}`,
  );
}

/** A git branch name prefix ending in `/` (tasks.rs `is_branch_prefix`). */
export function isBranchPrefix(s: string): boolean {
  if (!s.endsWith("/") || s.length > 100) return false;
  const dirs = s.slice(0, -1);
  return (
    dirs !== "" &&
    !dirs.startsWith("-") &&
    dirs.split("/").every((c) => c !== "" && !c.startsWith(".") && !c.endsWith(".lock") && !c.includes("..") && /^[A-Za-z0-9._-]+$/.test(c))
  );
}

/** Parses and validates the file's text. An empty file sets nothing, like no file. */
export function parsePolicy(text: string): PolicyFile {
  if (text.trim() === "") return {};
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    throw invalid((e as Error).message.split("\n")[0] ?? "");
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) throw invalid("invalid type: expected struct PolicyFile");
  const d = doc as { tools?: unknown; branchPrefix?: unknown };
  const out: PolicyFile = {};
  if (d.tools !== undefined && d.tools !== null) {
    if (typeof d.tools !== "object" || Array.isArray(d.tools)) throw invalid("tools: invalid type: expected struct PolicyFileTools");
    const t = d.tools as { allow?: unknown; deny?: unknown };
    const list = (name: "allow" | "deny"): string[] => {
      const v = t[name];
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v)) throw invalid(`tools.${name}: invalid type: expected a sequence`);
      if (v.length > 100) throw invalid(`tools.${name}: at most 100 rules`);
      for (const r of v) if (typeof r !== "string" || r.length < 1 || r.length > 200) throw invalid(`tools.${name}: each rule is text of 1 to 200 characters`);
      return v as string[];
    };
    out.tools = { allow: list("allow"), deny: list("deny") };
  }
  if (d.branchPrefix !== undefined && d.branchPrefix !== null) {
    if (typeof d.branchPrefix !== "string" || !isBranchPrefix(d.branchPrefix)) {
      throw invalid("branchPrefix: expected a branch prefix ending in /, such as fleetd/ (letters, digits, . _ - between the slashes)");
    }
    out.branchPrefix = d.branchPrefix;
  }
  return out;
}
