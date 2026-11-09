// The optional repo policy file `.fleetd/policy.yaml`, read from the working tree
// of the project's checkout through the node (so an uncommitted file counts). Cached per project for 60 s;
// `invalidate` drops an entry at once. No file is the default policy. A broken file is an error with a fix, never a
// silent fallback, so a typo can't drop a deny rule. `hub.area("policy")`, whose contract is `get(ref)`: the train
// reads `branchPrefix` from it (DEFAULT_BRANCH_PREFIX when unset), a launch its tool rules (`toolRules`).
import type { ProjectRef } from "../../shared/contracts.ts";
import type { Clock } from "../../shared/clock.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { ExecutorError, executors } from "../executor/index.ts";
import type { SessionRules } from "../executor/sessions.ts";

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

/** Why a policy file wasn't read: the machine has no such project (cached), or anything else (not cached). */
export class ReadFailure extends Error {
  constructor(
    readonly noProject: boolean,
    readonly error: ToolError,
  ) {
    super(error.message);
  }
}

/** Where a project's policy file comes from: the hub's asks the machine's node; tests use a fake. */
export type PolicySource = (r: ProjectRef) => Promise<string | undefined>;

/** Reads the file from the project's workspace through the machine's node (executor `read_project_file`). */
export function nodePolicySource(hub: Hub): PolicySource {
  return async (r) => {
    try {
      const out = (await executors(hub).call(r.machineId, "read", { op: "read_file", projectId: r.projectId, path: POLICY_FILE_PATH } as never, 15_000)) as {
        kind?: string;
        contents?: string | null;
      };
      if (out.kind !== undefined && out.kind !== "file") throw ExecutorError.failed(r.machineId, "read", "the node sent no file");
      return out.contents ?? undefined;
    } catch (e) {
      const noProject = e instanceof ExecutorError && e.extra.nodeMessage === `no project ${r.projectId} on this machine`;
      const error =
        e instanceof ExecutorError && e.kind === "not_connected"
          ? new ToolError("machine_offline", `Machine ${r.machineId} is offline.`, `Start the node on ${r.machineId} or check its network, then retry.`)
          : new ToolError("failed", e instanceof Error ? e.message : String(e), "Retry; if it keeps failing, check the machine with fleetd_status.");
      throw new ReadFailure(noProject, error);
    }
  };
}

const keyOf = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

export class Policies {
  private readonly cache = new Map<string, [number, PolicyFile | ToolError]>();

  constructor(
    private readonly source: PolicySource,
    private readonly clock: Clock,
  ) {}

  /** The project's policy from its file, cached up to 60 s. A read failure is not cached, except "no such project". */
  async get(r: ProjectRef): Promise<PolicyFile> {
    const now = this.clock.now();
    const hit = this.cache.get(keyOf(r));
    if (hit && now - hit[0] < POLICY_TTL_MS) {
      if (hit[1] instanceof ToolError) throw hit[1];
      return hit[1];
    }
    let result: PolicyFile | ToolError;
    try {
      const text = await this.source(r);
      result = text === undefined ? {} : parsePolicy(text);
    } catch (e) {
      if (e instanceof ReadFailure && !e.noProject) throw e.error;
      result = e instanceof ReadFailure ? e.error : e instanceof ToolError ? e : new ToolError("failed", String(e));
    }
    this.cache.set(keyOf(r), [now, result]);
    if (result instanceof ToolError) throw result;
    return result;
  }

  /** Forgets the cached policy, so the next `get` reads the file again. */
  invalidate(r: ProjectRef): void {
    this.cache.delete(keyOf(r));
  }
}

/** The policy area's contract: the project's policy file, decoded. */
export type PolicyReader = { get(r: ProjectRef): Promise<PolicyFile> };

/** A launch's session rules, `tools.allow` and `tools.deny` (executor mod.rs `ToolPolicy::tools`): a file that
 * doesn't decode refuses the launch rather than drop its denies. */
export async function toolRules(p: PolicyReader, r: ProjectRef): Promise<SessionRules> {
  const t = (await p.get(r)).tools;
  return { allow: [...(t?.allow ?? [])], deny: [...(t?.deny ?? [])] };
}

/** The hub's policies, `hub.area("policy")`. */
export const policy = (hub: Hub) => hub.area("policy", (h) => new Policies(nodePolicySource(h), h.clock));
