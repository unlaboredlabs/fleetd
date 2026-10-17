// Minimal outside client for a stock T3 server, built only from the vendored T3 slice
// (vendor/t3: @t3tools/contracts + @t3tools/client-runtime/rpc).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  executeEnvironmentHttpRequest,
  layerRemoteHttpClient,
  makeEnvironmentHttpApiGroupClient,
} from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

export const LAB = process.env.FLEETD_LAB ?? path.join(process.env.HOME ?? "", "src/fleetd-lab");
export const T3_SRC = process.env.T3_SRC ?? path.join(LAB, "t3-src");

export interface Lab {
  readonly name: "lab-a" | "lab-b";
  readonly port: number;
  readonly home: string;
  readonly repo: string;
  readonly claudeDir: string;
}

const lab = (name: Lab["name"], port: number): Lab => {
  const s = name.slice(-1);
  return {
    name,
    port,
    home: path.join(LAB, `home-${s}`),
    repo: path.join(LAB, `repo-${s}`),
    claudeDir: path.join(LAB, `claude-${s}`),
  };
};
export const LAB_A = lab("lab-a", 4711);
export const LAB_B = lab("lab-b", 4712);
export const httpBase = (l: Lab) => `http://127.0.0.1:${l.port}`;

export const scrubbedEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "USER", "LANG"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
};

/** Mint a bearer session locally with T3's own CLI, the way `fleetd node` would. Never logged. */
export function mintSession(l: Lab, ttl = "1h"): string {
  const out = execFileSync(
    process.execPath,
    [path.join(T3_SRC, "apps/server/src/bin.ts"), "auth", "session", "issue",
      "--base-dir", l.home, "--ttl", ttl, "--label", "fleetd-s0", "--token-only"],
    { env: scrubbedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const token = out.trim().split("\n").at(-1)?.trim() ?? "";
  if (token.length < 20) throw new Error(`could not mint a session for ${l.name}`);
  return token;
}

/** One WebSocket connection: bearer -> one-time ws ticket -> /ws?wsTicket=… (as T3's own remote clients do). */
export const connect = (l: Lab, token: string) =>
  Effect.gen(function* () {
    const base = httpBase(l);
    const ticket = yield* executeEnvironmentHttpRequest(
      `${base}/api/auth/websocket-ticket`,
      10_000,
      Effect.flatMap(makeEnvironmentHttpApiGroupClient(base, "auth"), (auth) =>
        auth.webSocketTicket({ headers: { authorization: `Bearer ${token}` } }),
      ),
    ).pipe(Effect.provide(layerRemoteHttpClient(globalThis.fetch)));
    const url = new URL("/ws", base);
    url.protocol = "ws:";
    url.searchParams.set("wsTicket", ticket.ticket);
    url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          pingTimeout: "15 seconds",
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(url.toString(), { openTimeout: "15 seconds" }).pipe(
              Layer.provide(Socket.layerWebSocketConstructorGlobal),
            ),
            RpcSerialization.layerJson,
          ),
        ),
      ),
    );
    return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
  });

export type T3Client = Effect.Success<ReturnType<typeof connect>>;

/** A connection whose lifetime the caller controls (close() drops the socket). */
export const openConnection = (l: Lab, token: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const client = yield* connect(l, token).pipe(Scope.provide(scope));
    return { client, close: Scope.close(scope, Exit.void) };
  });

/** Collect a stream into an array in the background; `stop` interrupts it. */
export const collect = <A, E>(stream: Stream.Stream<A, E>, onItem?: (a: A) => void) =>
  Effect.gen(function* () {
    const items: A[] = [];
    let failure: unknown = undefined;
    const fiber = yield* stream.pipe(
      Stream.runForEach((a) => Effect.sync(() => { items.push(a); onItem?.(a); })),
      Effect.catchCause((cause) => Effect.sync(() => { failure = cause; })),
      Effect.forkDetach,
    );
    return { items, failure: () => failure, stop: Fiber.interrupt(fiber) };
  });

/** Poll a condition (spike only; production code would use the stream directly). */
export const waitUntil = <A>(what: string, check: () => A | undefined | false, timeoutMs = 120_000) =>
  Effect.gen(function* () {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const v = check();
      if (v !== undefined && v !== false) return v;
      yield* Effect.sleep("250 millis");
    }
    return yield* Effect.fail(new Error(`timed out: ${what}`));
  });

export const pidOf = (l: Lab): number =>
  Number(fs.readFileSync(path.join(LAB, "pids", `${l.name}.pid`), "utf8").trim());

/** Every live descendant of `root` with its argv, read from /proc. */
export function descendants(root: number): Array<{ pid: number; argv: string[] }> {
  const parent = new Map<number, number>();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      parent.set(Number(entry), ppid);
    } catch {
      // raced with exit
    }
  }
  const out: Array<{ pid: number; argv: string[] }> = [];
  for (const pid of parent.keys()) {
    let p: number | undefined = parent.get(pid);
    while (p !== undefined && p > 1 && p !== root) p = parent.get(p);
    if (p !== root) continue;
    try {
      out.push({ pid, argv: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) });
    } catch {
      // raced with exit
    }
  }
  return out;
}

/** Sample the claude CLI processes a lab server spawns (argv shows --effort, --disallowedTools…). */
export function sampleClaudeProcesses(l: Lab) {
  const seen = new Map<number, string[]>();
  const timer = setInterval(() => {
    for (const p of descendants(pidOf(l))) {
      if (!seen.has(p.pid) && p.argv.some((a) => /(^|\/)claude(\.exe)?$|claude-code|cli\.js$/.test(a))) {
        seen.set(p.pid, p.argv);
      }
    }
  }, 150);
  return { seen, stop: () => clearInterval(timer) };
}
