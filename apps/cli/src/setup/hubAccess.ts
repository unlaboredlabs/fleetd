import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MachineId } from "@fleetd/contracts";
import * as Auth from "@fleetd/hub/auth/Auth.ts";
import * as HubDb from "@fleetd/hub/store/HubDb.ts";
import * as HubStore from "@fleetd/hub/store/HubStore.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

/** The hub home's database, opened beside a running hub (SQLite WAL), as `hub key` does. */
export const openHub = (home: string) =>
  ManagedRuntime.make(Layer.mergeAll(Auth.layer, HubStore.layer).pipe(Layer.provideMerge(HubDb.layer(home))));
export type HubRuntime = ReturnType<typeof openHub>;

export const enrollToken = (machineId: MachineId) =>
  Effect.gen(function* () {
    return yield* (yield* Auth.Auth).createEnrollToken(machineId);
  });
export const hasNodeKey = (machineId: MachineId) =>
  Effect.gen(function* () {
    return (yield* (yield* Auth.Auth).nodePubKey(machineId)) !== undefined;
  });
export const machineStatus = (machineId: MachineId) =>
  Effect.gen(function* () {
    return (yield* (yield* HubStore.HubStore).machines.get(machineId))?.status;
  });

/** Revokes the node's key and drops the machine from the hub's list. */
export const forgetMachine = (machineId: MachineId) =>
  Effect.gen(function* () {
    const revoked = yield* (yield* Auth.Auth).revokeNode(machineId);
    yield* (yield* HubStore.HubStore).machines.remove(machineId);
    return revoked;
  });

/**
 * True once the hub has the machine online and heard from its node at or after `sinceMs`. A quick node restart
 * does not flap the status, so there may be no fresh machine.online event to wait for; the hub writes from its own
 * process, so this re-reads the record every second.
 */
export const waitOnline = (machineId: MachineId, sinceMs: number, timeoutMs: number) =>
  Effect.gen(function* () {
    const store = yield* HubStore.HubStore;
    const deadline = sinceMs + timeoutMs;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const machine = yield* store.machines.get(machineId);
      if (machine?.status === "online" && Date.parse(machine.lastSeenAt) >= sinceMs) return true;
      yield* Effect.sleep("1 second");
    }
    return false;
  });

/** PIDs (other than this one) with `file` open: the hub keeps hub.sqlite open while it runs. */
export const processesHolding = (file: string): ReadonlyArray<number> => {
  if (process.platform === "linux") {
    const held: Array<number> = [];
    for (const pid of fs.readdirSync("/proc").filter((entry) => /^\d+$/u.test(entry))) {
      if (Number(pid) === process.pid) continue;
      try {
        const dir = path.join("/proc", pid, "fd");
        if (fs.readdirSync(dir).some((fd) => fs.readlinkSync(path.join(dir, fd)) === file)) held.push(Number(pid));
      } catch {
        // Not ours to read, or gone.
      }
    }
    return held;
  }
  try {
    return execFileSync("lsof", ["-t", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter((line) => /^\d+$/u.test(line) && Number(line) !== process.pid)
      .map(Number);
  } catch {
    return [];
  }
};

/** What answers at `http://host:port/healthz`: a fleetd hub, something else, or nothing. */
export const probeListen = async (listen: { readonly host: string; readonly port: number }): Promise<"hub" | "other" | "free"> => {
  const host = listen.host.includes(":") ? `[${listen.host}]` : listen.host;
  try {
    const response = await fetch(`http://${host}:${listen.port}/healthz`, { signal: AbortSignal.timeout(2_000) });
    const body = (await response.json().catch(() => undefined)) as { protocol?: unknown } | undefined;
    return response.ok && typeof body?.protocol === "number" ? "hub" : "other";
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return code === "ECONNREFUSED" ? "free" : "other";
  }
};
