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
import { parsePolicy, POLICY_FILE_PATH, POLICY_TTL_MS, type PolicyFile } from "./file.ts";

export { DEFAULT_BRANCH_PREFIX, isBranchPrefix, parsePolicy, POLICY_FILE_PATH, POLICY_TTL_MS, type PolicyFile } from "./file.ts";

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
