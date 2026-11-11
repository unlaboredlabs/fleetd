// A throwaway fleet of the fleetd under test on a team of the target (target.ts): the factory lab's node and
// generated project (tests/lab/factory/kit.ts), offline claude stand-in and all, joined to that team, plus what the
// benches need on top: the hub's and the node's PIDs, an admin key for MCP and a human key for /app (the desktop's).
// Given a binary instead of a target, the team is a hub of that build (hubBuild.ts), as every fleet here used to be.
// Everything runs under its own run dir and ports, never the real hub's; what is started is stopped by PID.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { callToolWith, descendants, fleetdCommand } from "../lab/harness.ts";
import { type Factory, withFactory } from "../lab/factory/kit.ts";
import { hubBuild } from "./hubBuild.ts";
import type { Target } from "./target.ts";

export interface Fleet {
  readonly f: Factory;
  /** The hub's process; throws on a target that started none here. */
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

export async function withFleet(dir: string, on: string | Target, body: (fleet: Fleet) => Promise<void>) {
  const target = typeof on === "string" ? hubBuild("", on) : on;
  try {
    await onTeam(dir, target, body);
  } finally {
    // A target given is its caller's to close.
    if (typeof on === "string") await target.close();
  }
}

async function onTeam(dir: string, target: Target, body: (fleet: Fleet) => Promise<void>) {
  const team = await target.team(dir);
  await withFactory(dir, async (f) => {
    const env = { HOME: path.join(dir, "hub-user"), PATH: process.env.PATH ?? "", LANG: "C.UTF-8", USER: process.env.USER ?? "lab", FLEETD_HOME: dir };
    const cli = (...args: Array<string>) => execFileSync(...fleetdCommand(args), { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const humanKey = await team.key({ name: "bench", role: "admin", human: true });
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
      const fleet: Fleet = {
        f,
        get hubPid() {
          if (team.pid === undefined) throw new Error(`${target.name} started no hub process here to measure`);
          return team.pid;
        },
        nodePid: f.nodePid,
        hostPids,
        humanKey,
        admin: callToolWith(() => client),
        toolNames,
        turnsEnded,
        cli,
      };
      await body(fleet);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, { hub: team });
}
