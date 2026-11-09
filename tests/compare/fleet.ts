// A throwaway fleet of the fleetd under test: the factory lab's hub, node and generated project
// (tests/lab/factory/kit.ts), offline claude stand-in and all, plus what the benches need on top: the hub's and the
// node's PIDs, an admin key for MCP and a human key for /app (the desktop's). Everything runs under its own run dir
// and ports, never the real hub's; the kit stops every process it started by PID.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { callToolWith, descendants, fleetdCommand } from "../lab/harness.ts";
import { type Factory, withFactory } from "../lab/factory/kit.ts";

export interface Fleet {
  readonly f: Factory;
  readonly hubPid: number;
  readonly nodePid: () => number | undefined;
  /** The node's descendants that are its session hosts (and so the agents' processes' parents). */
  readonly hostPids: () => Array<number>;
  readonly humanKey: string;
  /** MCP as an admin (cap_set and the other hub-wide settings). */
  readonly admin: ReturnType<typeof callToolWith>;
  /** The tools MCP lists to that admin. */
  readonly toolNames: () => Promise<Array<string>>;
  /**
   * Waits until each task's thread has ended a turn (thread.completed, .failed or .interrupted) after `cursor`;
   * resolves with how many ended otherwise than completed.
   */
  readonly turnsEnded: (taskIds: ReadonlyArray<string>, cursor: number, ms: number) => Promise<{ failed: number }>;
  /** `fleetd <args>` against this fleet's hub, as its machine's user. */
  readonly cli: (...args: Array<string>) => string;
}

export async function withFleet(dir: string, bin: string, body: (fleet: Fleet) => Promise<void>) {
  process.env.FLEETD_BIN = bin;
  await withFactory(dir, async (f) => {
    const hub = descendants(process.pid).find((p) => p.cmdline.includes("hub") && p.cmdline.includes("start"));
    if (hub === undefined) throw new Error("the fleet's hub process isn't among this run's children");
    const env = { HOME: path.join(dir, "hub-user"), PATH: process.env.PATH ?? "", LANG: "C.UTF-8", USER: process.env.USER ?? "lab", FLEETD_HOME: dir };
    const cli = (...args: Array<string>) => execFileSync(...fleetdCommand(args), { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const keyFile = path.join(dir, "bench-human.key");
    cli("hub", "key", "create", "--human", "--name", "bench", "--role", "admin", "--machines", "*", "--out", keyFile);
    const humanKey = fs.readFileSync(keyFile, "utf8").trim();
    const client = new Client({ name: "fleetd-compare", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${f.hubUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${humanKey}` } } }) as Transport);
    const hostPids = () => {
      const pid = f.nodePid();
      return pid === undefined ? [] : descendants(pid).filter((p) => p.cmdline.includes("session-host")).map((p) => p.pid);
    };
    try {
      const turnsEnded = async (taskIds: ReadonlyArray<string>, cursor: number, ms: number) => {
        const threads = new Map<string, string | undefined>();
        for (const id of taskIds) {
          const t = await f.until(`${id} has a thread`, ms, async () => {
            const task = await f.task(id);
            return task.threadRef?.threadId === undefined ? (await new Promise((r) => setTimeout(r, 200)), undefined) : task;
          });
          threads.set(t.threadRef.threadId as string, undefined);
        }
        let from = cursor;
        await f.until(`${taskIds.length} turns end`, ms, async () => {
          const page = (await f.callTool("events_wait", { cursor: from, types: ["thread.completed", "thread.failed", "thread.interrupted"], timeoutSec: 10 })).body;
          for (const e of page.events as Array<Record<string, any>>) if (threads.has(e.threadId) && threads.get(e.threadId) === undefined) threads.set(e.threadId, e.type);
          from = page.cursor as number;
          return [...threads.values()].every((v) => v !== undefined) ? true : undefined;
        });
        return { failed: [...threads.values()].filter((v) => v !== "thread.completed").length };
      };
      const toolNames = async () => (await client.listTools()).tools.map((t) => t.name).sort();
      await body({ f, hubPid: hub.pid, nodePid: f.nodePid, hostPids, humanKey, admin: callToolWith(() => client), toolNames, turnsEnded, cli });
    } finally {
      await client.close().catch(() => undefined);
    }
  });
}
