// A hub as people, pairing and push tests reach it: an in-memory database, a clock the test moves, every module's
// tools, and callers made the way a device pairs.
import { registerAll } from "../src/hub/serve/areas.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { type Caller, Registry } from "../src/hub/api/registry.ts";
import { people } from "../src/hub/people/store.ts";
import { HubDb } from "../src/hub/store/db.ts";
import type { Grant } from "../src/shared/contracts.ts";
import { ToolError } from "../src/shared/errors.ts";

export class ManualClock {
  constructor(public ms: number) {}
  now() {
    return this.ms;
  }
  advance(ms: number) {
    this.ms += ms;
  }
}

export function testHub(opts: { home?: string; url?: string; host?: string } = {}) {
  const clock = new ManualClock(1_792_000_000_000);
  const hub = new Hub(
    { home: opts.home ?? "", listen: { host: opts.host ?? "127.0.0.1", port: 4790 }, ...(opts.url ? { url: opts.url } : {}) },
    HubDb.memory(),
    clock,
  );
  people(hub).ensureOwner();
  const tools = new Registry();
  registerAll(tools);
  /** Calls `tool` as `caller`: its output, or throws the ToolError it refused with. */
  const call = async <T = Record<string, unknown>>(caller: Caller, tool: string, input: unknown = {}): Promise<T> => {
    const result = await tools.call(hub, caller, tool, input);
    if ("output" in result) return result.output as T;
    if (result.error.kind === "tool") throw result.error.error;
    throw new Error(`${tool}: ${JSON.stringify(result.error)}`);
  };
  /** A human key of `personId` (the owner when absent), verified as a request would be. */
  const device = (grants: Grant[] = [{ role: "admin", machines: "*" }], personId?: string, name = "laptop"): Caller => {
    const { key } = hub.auth.keys.createKeyFor(name, grants, "human", personId);
    return hub.auth.verify(key);
  };
  const agent = (grants: Grant[] = [{ role: "admin", machines: "*" }]): Caller =>
    hub.auth.verify(hub.auth.keys.createKey("agent", grants, "agent").key);
  return { hub, clock, tools, call, device, agent };
}

/** The ToolError `promise` refused with. */
export async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** Every event of `type` in the hub's log, oldest first. */
export const eventsOf = (hub: Hub, type: string) =>
  hub.db
    .all<{ data: string }>("SELECT data FROM events WHERE type = ? ORDER BY seq", [type])
    .map((r) => JSON.parse(r.data) as { summary: string; data?: Record<string, unknown> });
