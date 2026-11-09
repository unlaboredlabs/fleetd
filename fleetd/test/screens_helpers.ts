// A hub for the screens tests: a fresh home under $TMPDIR, an in-memory-free database there, the D346 shims as its
// node link and app sockets, and a clock the test moves. Never the live hub's home.
import { registerAll } from "../src/hub/serve/areas.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { type Caller, Registry } from "../src/hub/api/registry.ts";
import { bindApp } from "../src/hub/browser/app.ts";
import { type AppConn, ShimAppWs } from "../src/hub/browser/app_seam.ts";
import type { Socket } from "../src/hub/http/route.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import type { LeadCaller } from "../src/hub/lead_calls/types.ts";
import type { Linked } from "../src/hub/link/index.ts";
import { events } from "../src/hub/store/events.ts";
import { ToolError } from "../src/shared/errors.ts";
import type { HubEvent, Machine, Role } from "../src/shared/contracts.ts";
import type { NodeLoad } from "../src/shared/node_link.ts";
import type { HubToNodeFrame, McpToolError, NodeToHubFrame } from "../src/shared/screens_wire.ts";
import { openHubDb, tempHome } from "./helpers.ts";

/** The hub's node link as this area uses it (src/hub/link's Link), with its nodes driven by the test. */
export class FakeLink {
  readonly handlers = new Map<string, ((machineId: string, frame: NodeToHubFrame) => void)[]>();
  readonly linked = new Map<string, { id: number; caps: Set<string>; out: HubToNodeFrame[] }>();
  readonly linkedFns: ((linked: Linked) => void)[] = [];
  private readonly loads = new Map<string, NodeLoad>();
  /** How a test answers `request`. */
  answer: (machineId: string, frame: HubToNodeFrame) => Promise<unknown> = async () => {
    throw new Error("not linked");
  };
  private ids = 0;

  on(tag: string, fn: (machineId: string, frame: NodeToHubFrame) => void): () => void {
    this.handlers.set(tag, [...(this.handlers.get(tag) ?? []), fn]);
    return () => {};
  }
  /** Where a sent frame goes besides the record of it: a test's node. */
  onSend: ((machineId: string, frame: HubToNodeFrame) => void) | undefined;
  send(machineId: string, frame: HubToNodeFrame): boolean {
    const link = this.linked.get(machineId);
    if (!link) return false;
    link.out.push(frame);
    this.onSend?.(machineId, frame);
    return true;
  }
  request(machineId: string, frame: HubToNodeFrame): Promise<unknown> {
    return this.answer(machineId, frame);
  }
  can(machineId: string, cap: string): boolean {
    return this.linked.get(machineId)?.caps.has(cap) ?? false;
  }
  lacks(machineId: string, cap: string): boolean {
    const caps = this.linked.get(machineId)?.caps;
    return caps !== undefined && !caps.has(cap);
  }
  linkId(machineId: string): number | undefined {
    return this.linked.get(machineId)?.id;
  }
  onLinked(fn: (linked: Linked) => void): () => void {
    this.linkedFns.push(fn);
    return () => {};
  }
  load(machineId: string): NodeLoad | undefined {
    return this.loads.get(machineId);
  }
  setHosts(machineId: string, hosts: NodeLoad["hosts"]): void {
    const load = this.loads.get(machineId);
    if (load) this.loads.set(machineId, { ...load, hosts });
  }
  /** A node links with `caps`. */
  link(machineId: string, caps: string[]): void {
    const id = ++this.ids;
    this.linked.set(machineId, { id, caps: new Set(caps), out: [] });
    for (const fn of this.linkedFns) fn({ machineId, linkId: id } as Linked);
  }
  unlink(machineId: string): void {
    this.linked.delete(machineId);
  }
  /** A frame from a node; a heartbeat's load is kept as the link keeps it. */
  deliver(machineId: string, frame: NodeToHubFrame): void {
    if (frame.t === "hb" && frame.load) this.loads.set(machineId, frame.load as NodeLoad);
    for (const fn of this.handlers.get(frame.t) ?? []) fn(machineId, frame);
  }
  sent(machineId: string): HubToNodeFrame[] {
    return this.linked.get(machineId)?.out ?? [];
  }
}

/** A node's lead call, answered by the registered handler as the link does: the result, or the refusal. */
export async function callLead(hub: Hub, caller: LeadCaller, call: Record<string, unknown>): Promise<{ result?: unknown; error?: McpToolError }> {
  const handler = leadCalls(hub).handler(String(call.op));
  if (!handler) return { error: { code: "invalid", message: `unknown lead call ${String(call.op)}` } };
  try {
    return { result: await handler(caller, call as never) };
  } catch (e) {
    if (e instanceof ToolError) return { error: e.toJSON() as McpToolError };
    throw e;
  }
}

export class TestClock {
  constructor(public ms = Date.parse("2026-11-08T12:00:00.000Z")) {}
  now(): number {
    return this.ms;
  }
}

export function testHub() {
  const home = tempHome();
  const clock = new TestClock();
  const hub = new Hub({ home: home.dir, listen: { host: "127.0.0.1", port: 0 } }, openHubDb(home.dir), clock);
  // This area's node link, before anything makes the real one.
  const fake = hub.area("link", () => new FakeLink() as never) as unknown as FakeLink;
  const appended: HubEvent[] = [];
  events(hub).subscribe((e) => appended.push(e));
  const app = new ShimAppWs();
  bindApp(hub, app);
  const tools = new Registry();
  registerAll(tools);
  return {
    hub,
    clock,
    tools,
    link: fake,
    app,
    events: { appended },
    calls: {
      call: (caller: LeadCaller, call: Record<string, unknown>) => callLead(hub, caller, call),
      hosts: (runner: string, thread: string) => leadCalls(hub).hosted(runner, thread),
    },
    done: () => {
      hub.shutdown.abort();
      hub.db.close();
      home.done();
    },
  };
}

export function caller(role: Role, opts: { kind?: "human"; machines?: string[] | "*"; name?: string } = {}): Caller {
  return {
    keyId: `key_${opts.name ?? "t"}`,
    name: opts.name ?? "t",
    prefix: "fld_abcdef",
    grants: [{ role, machines: opts.machines ?? "*" }],
    createdAt: new Date(0).toISOString(),
    ...(opts.kind ? { kind: opts.kind } : {}),
  };
}

export function addMachine(hub: Hub, id: string, extra: Partial<Machine> = {}): void {
  const m: Machine = { machineId: id, name: id, nodeVersion: "1.0.0", status: "online", lastSeenAt: new Date(0).toISOString(), ...extra };
  hub.db.conn.query("INSERT INTO machines (machine_id, data) VALUES (?, ?)").run(id, JSON.stringify(m));
}

export function addProject(hub: Hub, machineId: string, projectId: string): void {
  hub.db.conn
    .query("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (?, ?, '', '', ?)")
    .run(machineId, projectId, JSON.stringify({ machineId, projectId, title: projectId }));
}

export const agent = (machineId: string, projectId: string, taskId?: string): LeadCaller => ({
  projectRef: { machineId, projectId },
  by: `lead:${machineId}/${projectId}`,
  agent: taskId ? { kind: "task", taskId } : { kind: "lead" },
  threadId: "t1",
});

/** An app connection (#1186's AppConn, as this area reads it): what the hub sent it. */
export type FakeConn = AppConn & { sent: unknown[]; pings: number };
export function fakeSocket(): FakeConn {
  const s = {
    sent: [] as unknown[],
    pings: 0,
    caller: undefined as Caller | undefined,
    send(text: string) {
      s.sent.push(JSON.parse(text));
      return text.length;
    },
    ping() {
      s.pings += 1;
      return 1;
    },
  } as unknown as FakeConn & { ws: Socket };
  s.ws = s as unknown as Socket;
  return s;
}

/** `conn`, authed as `caller`. */
export const as = (conn: FakeConn, caller: Caller): FakeConn => Object.assign(conn, { caller });

export const tick = () => new Promise((r) => setTimeout(r, 0));
