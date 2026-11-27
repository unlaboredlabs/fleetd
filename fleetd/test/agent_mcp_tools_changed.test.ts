// A running `fleetd agent-mcp` takes the tools of the node it calls: a session that started on an older build sees a
// tool the node's newer build added at its next tools/list, announced with notifications/tools/list_changed, and calls it.
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { serve, type LeadDeps } from "../src/cli/agent_mcp/index.ts";
import { sendToNode } from "../src/cli/agent_mcp/socket.ts";
import { BUILT_IN, snapshotHash, useSnapshot, type Snapshot } from "../src/cli/agent_mcp/tools.ts";
import { agentTools } from "../src/node/lead/channel.ts";
import { LeadRelay, serveLeadSocket } from "../src/node/lead/index.ts";
import { Masker } from "../src/node/mask.ts";
import type { NodeFrame } from "../src/shared/node_link.ts";
import { tempHome } from "./helpers.ts";

afterEach(() => useSnapshot(BUILT_IN));

/** The tool the newer build added, missing from the build the session started on: a lead's that needs no arguments. */
const added = BUILT_IN.tools.filter((t) => t.lead && !t.browser && !(t.inputSchema.required as string[] | undefined)?.length).at(-1)!;
const older: Snapshot = { ...BUILT_IN, tools: BUILT_IN.tools.filter((t) => t !== added) };

const until = async <T>(what: string, get: () => T | undefined): Promise<T> => {
  for (let i = 0; i < 500; i++) {
    const got = get();
    if (got !== undefined) return got;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

test("the node answers agent_tools with its build's tools, or only their hash when the caller has them", () => {
  const hash = snapshotHash(BUILT_IN);
  expect(agentTools("an older hash")).toEqual({ t: "agent_tools", hash, snapshot: BUILT_IN });
  expect(agentTools(hash)).toEqual({ t: "agent_tools", hash });
});

test("a session that started before a tool was added sees it at its next tools/list, and calls it", async () => {
  const home = tempHome();
  const sock = join(home.dir, "node.sock");
  let stop = () => {};
  try {
    // The node the session started under: a build from before agent_tools, which refuses the frame.
    const old = Bun.listen({
      unix: sock,
      socket: {
        data(s) {
          s.write(`${JSON.stringify({ t: "lead_result", id: "invalid", error: { code: "invalid", message: "not a lead_call frame" } })}\n`);
          s.end();
        },
      },
    });
    useSnapshot(older);
    const out: Record<string, any>[] = [];
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const stdin = new ReadableStream<Uint8Array>({ start: (c) => void (input = c) });
    const say = (m: unknown) => input.enqueue(new TextEncoder().encode(`${JSON.stringify(m)}\n`));
    const deps: LeadDeps = { pwd: undefined, sock, thread: undefined, cwd: home.dir, send: (s, f) => sendToNode(s, f, 5_000, 1_000) };
    const served = serve("lead", stdin, async (line) => void out.push(JSON.parse(line)), deps, 20);
    const answer = (id: number) => until(`answer ${id}`, () => out.find((m) => m.id === id));

    say({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect((await answer(1)).result.capabilities).toEqual({ tools: { listChanged: true } });
    say({ jsonrpc: "2.0", method: "notifications/initialized" });
    say({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const before = (await answer(2)).result.tools.map((t: { name: string }) => t.name);
    expect(before).not.toContain(added.name);

    // The machine updates: its node now runs the build with the tool.
    old.stop(true);
    rmSync(sock, { force: true });
    const relay = new LeadRelay();
    const calls: NodeFrame[] = [];
    relay.attach((f) => {
      calls.push(f);
      queueMicrotask(() => relay.resolve({ id: String(f.id), result: { op: added.op } }));
    }, []);
    stop = await serveLeadSocket(sock, { relay, identify: () => ({ kind: "outside" }), maskFor: () => new Masker() });

    await until("list_changed", () => out.find((m) => m.method === "notifications/tools/list_changed"));
    say({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const after = (await answer(3)).result.tools.map((t: { name: string }) => t.name);
    expect(after).toEqual(BUILT_IN.tools.filter((t) => t.lead).map((t) => t.name));
    // Announced once: the node's tools are the served ones now.
    await Bun.sleep(100);
    expect(out.filter((m) => m.method === "notifications/tools/list_changed")).toHaveLength(1);

    say({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: added.name, arguments: {} } });
    await answer(4);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ t: "lead_call", call: { op: added.op } });

    input.close();
    await served;
  } finally {
    stop();
    home.done();
  }
});
