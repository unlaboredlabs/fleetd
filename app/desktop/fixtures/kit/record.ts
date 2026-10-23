// Records a lab hub's real /app traffic, as the app would see it, into a raw JSONL file for `sanitize.ts`:
//
//   node fixtures/kit/record.ts --handoff <file> --out <raw.jsonl>          (in app/desktop; stop it with SIGTERM)
//
// The lab writes the handoff ({hubUrl, key}, a human key) when run with FLEETD_LAB_APP_HANDOFF=<file>
// (tests/lab/testLab.ts). The recorder waits for it, then holds one /app session for the whole run: the snapshot, every
// event from cursor 0, the live feed (board, focused on the newest order), and repeated sweeps of every read call the
// app's screens make over every machine, project, order and thread it has seen (Time's answers are fixtures/time's, so
// it records none). It reconnects when the lab restarts the hub. A call's result is written only when it differs from
// that call's last one, so an hour stays small.
// The raw file holds real lab paths and ids; only sanitize.ts output goes into the repo.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isObject, type JsonObject, type JsonValue, asText } from "./json.ts";

export type RawLine =
  | { readonly at: number; readonly kind: "frame"; readonly frame: JsonObject }
  | {
      readonly at: number;
      readonly kind: "result";
      readonly tool: string;
      readonly input: JsonObject;
      readonly output?: JsonValue;
      readonly error?: JsonObject;
    }
  | { readonly at: number; readonly kind: "mark"; readonly what: string };

const str = (v: JsonValue | undefined): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Every entity seen in any frame or result, so each sweep covers it. */
const seen = {
  machines: new Set<string>(),
  projects: new Map<string, { machineId: string; projectId: string }>(),
  orders: new Set<string>(),
  threads: new Map<string, { machineId: string; threadId: string }>(),
  prompts: new Set<string>(),
  promptsFetched: new Set<string>(),
};

const collect = (v: JsonValue): void => {
  if (Array.isArray(v)) {
    for (const x of v) collect(x);
    return;
  }
  if (!isObject(v)) return;
  const machineId = str(v["machineId"]);
  const projectId = str(v["projectId"]);
  const threadId = str(v["threadId"]);
  const workstreamId = str(v["workstreamId"]);
  if (machineId !== undefined) seen.machines.add(machineId);
  if (machineId !== undefined && projectId !== undefined) seen.projects.set(`${machineId}/${projectId}`, { machineId, projectId });
  if (machineId !== undefined && threadId !== undefined) seen.threads.set(`${machineId}/${threadId}`, { machineId, threadId });
  if (workstreamId !== undefined) seen.orders.add(workstreamId);
  for (const x of Object.values(v)) collect(x);
};

/** The read calls the app's screens make, over everything seen so far. */
const sweepCalls = (since: string): Array<readonly [string, JsonObject]> => {
  const calls: Array<readonly [string, JsonObject]> = [
    ["orders_board", {}],
    ["status_projects", {}],
    ["prompts_list", {}],
    ["doctor_list", {}],
    ["attention_policy", {}],
    ["status_get", { scope: { kind: "fleet" } }],
  ];
  for (const { machineId, projectId } of seen.projects.values()) {
    const projectRef = { machineId, projectId };
    calls.push(
      ["chat_history", { projectRef }],
      ["orders_board", { projectRef, includeDoneSince: since }],
      ["prompts_list", { projectRef }],
      ["status_get", { scope: { kind: "project", projectRef } }],
    );
  }
  for (const workstreamId of seen.orders) {
    calls.push(["order_get", { workstreamId }], ["status_get", { scope: { kind: "order", workstreamId } }]);
  }
  // thread_tail feeds only the conversation fixtures (kit/shared.ts withConversation).
  for (const { machineId, threadId } of seen.threads.values()) {
    calls.push(["thread_tail", { machineId, threadId, n: 50 }], ["session_prompt_get", { machineId, threadId }]);
  }
  for (const machineId of seen.machines) calls.push(["project_discover", { machineId }]);
  // Prompt bodies are static: each once, after a list named it.
  for (const id of seen.prompts) if (!seen.promptsFetched.has(id)) calls.push(["prompt_get", { id }]);
  return calls;
};

interface Session {
  readonly call: (tool: string, input: JsonObject) => Promise<void>;
  readonly send: (frame: JsonObject) => void;
  readonly isOpen: () => boolean;
}

const main = async () => {
  const { values } = parseArgs({ options: { handoff: { type: "string" }, out: { type: "string" } } });
  if (values.handoff === undefined || values.out === undefined) throw new Error("usage: record.ts --handoff <file> --out <raw.jsonl>");
  const handoffFile = values.handoff;
  const out = fs.createWriteStream(values.out, { flags: "a" });
  const write = (line: RawLine) => out.write(`${JSON.stringify(line)}\n`);
  const lastDigest = new Map<string, string>();
  const since = new Date().toISOString();
  // Set from signal handlers and the socket's listeners, read through a function the checker won't narrow.
  const run = { stopping: false, dirty: true };
  process.on("SIGTERM", () => (run.stopping = true));
  process.on("SIGINT", () => (run.stopping = true));
  const stopping = () => run.stopping;

  let cursor = 0;
  let focus: string | undefined;

  const open = async (hubUrl: string, key: string): Promise<Session> => {
    const ws = new WebSocket(`${hubUrl.replace(/^http/u, "ws")}/app`);
    const waiting = new Map<string, { tool: string; input: JsonObject; done: () => void }>();
    let open = true;
    let nextId = 0;
    const send = (frame: JsonObject) => {
      if (open) ws.send(JSON.stringify(frame));
    };
    const ready = new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => send({ t: "auth", key }));
      ws.addEventListener("error", () => reject(new Error(`cannot open ${hubUrl}/app`)));
      ws.addEventListener("close", () => {
        open = false;
        for (const w of waiting.values()) w.done();
        waiting.clear();
        reject(new Error("closed"));
      });
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as JsonObject;
        const at = Date.now();
        const id = str(frame["id"]);
        const pending = id === undefined ? undefined : waiting.get(id);
        if (pending !== undefined && id !== undefined) {
          waiting.delete(id);
          const output = frame["t"] === "result" ? (frame["output"] ?? null) : undefined;
          const { t: _t, id: _id, ...error } = frame;
          const digest = createHash("sha256").update(JSON.stringify(output ?? error)).digest("hex");
          const callKey = `${pending.tool} ${JSON.stringify(pending.input)}`;
          if (lastDigest.get(callKey) !== digest) {
            lastDigest.set(callKey, digest);
            write({ at, kind: "result", tool: pending.tool, input: pending.input, ...(output === undefined ? { error } : { output }) });
          }
          if (output !== undefined) {
            collect(output);
            if (pending.tool === "prompt_get") seen.promptsFetched.add(asText(pending.input["id"]));
            const prompts = isObject(output) ? output["prompts"] : undefined;
            if (pending.tool === "prompts_list" && Array.isArray(prompts)) {
              for (const p of prompts) if (isObject(p) && typeof p["id"] === "string") seen.prompts.add(p["id"]);
            }
          }
          pending.done();
          return;
        }
        write({ at, kind: "frame", frame });
        if (frame["t"] === "ready") resolve();
        if (frame["t"] === "live") return;
        collect(frame);
        if (frame["t"] === "event") {
          run.dirty = true;
          if (typeof frame["seq"] === "number") cursor = Math.max(cursor, frame["seq"]);
          const data = frame["data"];
          const order = isObject(data) ? str(data["workstreamId"]) : undefined;
          if (frame["type"] === "workstream.created" && order !== undefined && order !== focus) {
            focus = order;
            send({ t: "live", board: true, focus: order });
          }
        }
      });
    });
    await ready;
    const call = (tool: string, input: JsonObject) =>
      new Promise<void>((resolve) => {
        if (!open) return resolve();
        const id = `r${++nextId}`;
        // A call the hub never answers must not hold up the sweep.
        const timer = setTimeout(() => (waiting.delete(id), resolve()), 30_000);
        waiting.set(id, { tool, input, done: () => (clearTimeout(timer), resolve()) });
        send({ t: "call", id, tool, input });
      });
    return { call, send, isOpen: () => open };
  };

  const sweep = async (session: Session, what: string) => {
    write({ at: Date.now(), kind: "mark", what: `sweep ${what}` });
    session.send({ t: "snapshot" });
    // Re-subscribing makes the next live frame full, so every moment has a complete lane picture close behind it.
    session.send({ t: "live", board: true, ...(focus === undefined ? {} : { focus }) });
    const calls = sweepCalls(since);
    // Well under the hub's 32 calls in flight per connection.
    for (let i = 0; i < calls.length && session.isOpen(); i += 16) {
      await Promise.all(calls.slice(i, i + 16).map(([tool, input]) => session.call(tool, input)));
    }
  };

  while (!fs.existsSync(handoffFile) && !stopping()) await sleep(500);
  while (!stopping()) {
    let session: Session;
    try {
      const { hubUrl, key } = JSON.parse(fs.readFileSync(handoffFile, "utf8")) as { hubUrl: string; key: string };
      session = await open(hubUrl, key);
    } catch {
      await sleep(1000);
      continue;
    }
    write({ at: Date.now(), kind: "mark", what: "connected" });
    session.send({ t: "snapshot" });
    session.send({ t: "events", cursor });
    session.send({ t: "live", board: true, ...(focus === undefined ? {} : { focus }) });
    let lastSweep = 0;
    while (session.isOpen() && !stopping()) {
      // At most one sweep every 15 s, after something happened, or each minute for timers and live durations.
      if ((run.dirty && Date.now() - lastSweep > 15_000) || Date.now() - lastSweep > 60_000) {
        run.dirty = false;
        lastSweep = Date.now();
        await sweep(session, new Date().toISOString());
      }
      await sleep(1000);
    }
    if (session.isOpen()) await sweep(session, "final");
    write({ at: Date.now(), kind: "mark", what: stopping() ? "stopped" : "disconnected" });
  }
  await new Promise((resolve) => out.end(resolve));
};

await main();
