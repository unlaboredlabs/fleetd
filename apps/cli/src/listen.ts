// `fleetd listen`: streams hub events to a command or a URL, at least once. It long-polls events_wait over MCP and
// persists its cursor only after the command exits 0 or the POST gets a 2xx, so a crash or restart re-delivers the
// event in flight instead of losing it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { HubEventType, MachineId, type HubEvent } from "@fleetd/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import pkg from "../package.json" with { type: "json" };
import { runUntilSignal } from "./node.ts";

export const LISTEN_USAGE = `  listen --hub <url> --key-file <path> (--exec '<cmd>' | --post <url>)
         [--types a,b] [--machines a,b] [--name <name>]
             deliver hub events, at least once and in order, to a command (one event's JSON on stdin)
             or a URL; the cursor lives in ~/.fleetd/listen/<name>.cursor (name default "default").
             Exits 78 when the hub refuses the key.
`;

/** sysexits EX_CONFIG: the key or flags are wrong, so a service manager restarting us would only loop. */
export const EXIT_CONFIG = 78;

/** The hub refused the key (HTTP 401) or the request (forbidden/invalid): retrying cannot help. */
export class ListenRefused extends Data.TaggedError("ListenRefused")<{ readonly message: string }> {}
export class HubUnavailable extends Data.TaggedError("HubUnavailable")<{ readonly message: string }> {}

export interface WaitPage {
  readonly events: ReadonlyArray<HubEvent>;
  readonly cursor: number;
}

export interface Hub {
  /** One events_wait long-poll; no cursor means from the hub's current end. */
  readonly wait: (cursor: number | undefined) => Effect.Effect<WaitPage, ListenRefused | HubUnavailable>;
}

export interface CursorStore {
  readonly read: () => number | undefined;
  readonly write: (seq: number) => void;
}

/** Hands one event to the consumer; true means it was taken (exit 0 or a 2xx). */
export type Deliver = (event: HubEvent) => Effect.Effect<boolean>;

const HUB_RETRY_SEC = [1, 2, 5, 10, 30] as const;
const DELIVER_RETRY_SEC = [1, 5, 30, 60] as const;

const warn = (line: string) => Effect.sync(() => void process.stderr.write(`fleetd listen: ${line}\n`));

/**
 * Runs until refused. Each event is retried until delivered, never skipped; the cursor moves past it only then.
 * `machines` filters here because events_wait takes one machine at most.
 */
export const listenLoop = (options: {
  readonly hub: Hub;
  readonly deliver: Deliver;
  readonly cursor: CursorStore;
  readonly machines?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    let cursor = options.cursor.read();
    let hubFailures = 0;
    for (;;) {
      const page = yield* Effect.result(options.hub.wait(cursor));
      if (page._tag === "Failure") {
        if (page.failure._tag === "ListenRefused") return yield* page.failure;
        const delay = HUB_RETRY_SEC[hubFailures] ?? HUB_RETRY_SEC.at(-1)!;
        hubFailures += 1;
        yield* warn(`hub unavailable (${page.failure.message}); retrying in ${delay}s`);
        yield* Effect.sleep(`${delay} seconds`);
        continue;
      }
      hubFailures = 0;
      for (const event of page.success.events) {
        if (options.machines !== undefined && (event.machineId === undefined || !options.machines.includes(event.machineId))) continue;
        for (let attempt = 0; ; attempt++) {
          // Once started, an attempt and its ack finish even on SIGTERM, so a clean stop never re-delivers.
          const taken = yield* Effect.uninterruptible(
            Effect.tap(options.deliver(event), (ok) => (ok ? Effect.sync(() => options.cursor.write(event.seq)) : Effect.void)),
          );
          if (taken) break;
          const delay = DELIVER_RETRY_SEC[attempt] ?? DELIVER_RETRY_SEC.at(-1)!;
          yield* warn(`event ${event.seq} (${event.type}) not delivered; retrying in ${delay}s`);
          yield* Effect.sleep(`${delay} seconds`);
        }
        cursor = event.seq;
      }
      if (cursor === undefined || page.success.cursor > cursor) {
        cursor = page.success.cursor;
        options.cursor.write(cursor);
      }
    }
  });

export const fileCursor = (file: string): CursorStore => ({
  read: () => {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const seq = Number(text.trim());
    if (!Number.isInteger(seq) || seq < 0) throw new Error(`cursor file ${file} is corrupt; delete it to start from now`);
    return seq;
  },
  write: (seq) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${seq}\n`);
    fs.renameSync(tmp, file);
  },
});

/** Runs `sh -c cmd` with the event's JSON as one line on stdin. */
export const execDeliver =
  (cmd: string): Deliver =>
  (event) =>
    Effect.callback<boolean>((resume) => {
      const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "inherit", "inherit"] });
      // A command that never reads stdin closes the pipe early; its exit code still decides.
      child.stdin.on("error", () => {});
      child.stdin.end(`${JSON.stringify(event)}\n`);
      child.once("error", () => resume(Effect.succeed(false)));
      child.once("exit", (code) => resume(Effect.succeed(code === 0)));
    });

export const postDeliver =
  (url: string): Deliver =>
  (event) =>
    Effect.promise(async () => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": `fleetd-listen/${pkg.version}` },
          body: JSON.stringify(event),
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        });
        await response.body?.cancel();
        return response.status >= 200 && response.status < 300;
      } catch {
        return false;
      }
    });

interface ToolBody {
  readonly code?: string;
  readonly message?: string;
  readonly fix?: string;
  readonly events?: ReadonlyArray<HubEvent>;
  readonly cursor?: number;
}

/** events_wait over the hub's MCP endpoint, reconnecting after any transport failure. */
export const mcpHub = (hubUrl: string, key: string, filter: { readonly types?: ReadonlyArray<string>; readonly machineId?: string }): Hub => {
  let client: Client | undefined;
  const connect = async () => {
    const next = new Client({ name: "fleetd-listen", version: pkg.version });
    const transport = new StreamableHTTPClientTransport(new URL("mcp", hubUrl.endsWith("/") ? hubUrl : `${hubUrl}/`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    });
    // The SDK's own types disagree under exactOptionalPropertyTypes (sessionId?: string vs string | undefined).
    await next.connect(transport as Transport);
    return next;
  };
  return {
    wait: (cursor) =>
      Effect.tryPromise({
        try: async (signal) => {
          client ??= await connect();
          const result = await client.callTool(
            { name: "events_wait", arguments: { ...(cursor === undefined ? {} : { cursor }), ...filter, timeoutSec: 50 } },
            undefined,
            { timeout: 70_000, signal },
          );
          const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as ToolBody;
          if (result.isError === true) throw Object.assign(new Error(`${body.code}: ${body.message}${body.fix ? ` (${body.fix})` : ""}`), { tool: body.code });
          return { events: body.events ?? [], cursor: body.cursor ?? cursor ?? 0 };
        },
        catch: (error) => {
          const { code, tool, message } = error as { code?: unknown; tool?: unknown; message?: string };
          if (code === 401) return new ListenRefused({ message: "the hub refused the key (401); check --key-file or create a new key" });
          if (tool === "forbidden" || tool === "invalid") return new ListenRefused({ message: message ?? String(error) });
          void client?.close().catch(() => {});
          client = undefined;
          return new HubUnavailable({ message: message ?? String(error) });
        },
      }),
  };
};

const usage = (message: string) => {
  process.stderr.write(`fleetd: ${message}\n\nusage:\n${LISTEN_USAGE}`);
  return 2;
};

const list = (value: string | undefined) => value?.split(",").map((s) => s.trim()).filter(Boolean);

/** `fleetd listen …`: runs until a signal (exit 0) or until the hub refuses the key (exit 78). */
export const listenCommand = async (argv: ReadonlyArray<string>): Promise<number> => {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        hub: { type: "string" },
        "key-file": { type: "string" },
        exec: { type: "string" },
        post: { type: "string" },
        types: { type: "string" },
        machines: { type: "string" },
        name: { type: "string" },
      },
    }));
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  const { hub, exec, post } = values;
  const keyFile = values["key-file"];
  if (!hub) return usage("--hub is required");
  if (!keyFile) return usage("--key-file is required");
  if ((exec === undefined) === (post === undefined)) return usage("give exactly one of --exec or --post");
  const types = list(values.types);
  const badType = types?.find((t) => !Schema.is(HubEventType)(t));
  if (badType !== undefined) return usage(`'${badType}' is not an event type`);
  const machines = list(values.machines);
  const badMachine = machines?.find((m) => !Schema.is(MachineId)(m));
  if (badMachine !== undefined) return usage(`'${badMachine}' is not a machine id ([a-z0-9-]{1,32})`);
  const name = values.name ?? "default";
  if (!/^[\w.-]{1,64}$/u.test(name)) return usage("--name may use letters, digits, '.', '_' and '-'");

  let key: string;
  try {
    key = fs.readFileSync(keyFile, "utf8").trim();
  } catch (error) {
    process.stderr.write(`fleetd listen: cannot read --key-file: ${(error as Error).message}\n`);
    return EXIT_CONFIG;
  }

  const program = listenLoop({
    hub: mcpHub(hub, key, {
      ...(types === undefined ? {} : { types }),
      ...(machines?.length === 1 ? { machineId: machines[0]! } : {}),
    }),
    deliver: exec !== undefined ? execDeliver(exec) : postDeliver(post!),
    cursor: fileCursor(path.join(os.homedir(), ".fleetd", "listen", `${name}.cursor`)),
    ...(machines === undefined ? {} : { machines }),
  }).pipe(
    Effect.catchTag("ListenRefused", (error) =>
      Effect.as(warn(`${error.message}; exiting ${EXIT_CONFIG} so a service manager does not restart-loop`), EXIT_CONFIG),
    ),
  );
  return runUntilSignal(program);
};
