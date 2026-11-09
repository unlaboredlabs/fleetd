// `fleetd chat`: write to a project's lead from a terminal and read its chat, over
// the app socket exactly as the desktop app does: chat_send, chat_history, events and streamed `chat_delta` frames.
import { readFileSync, readlinkSync } from "node:fs";
import { ArgError, parse } from "./args.ts";
import { clientRequestId, ioMessage, isMachineId, println, st, write } from "./common.ts";
import { hubUrl, parseRfc3339, Refused, reportAs, Unreachable, zoned } from "./steer.ts";
import { resolveProject } from "./time.ts";
import { CHAT_USAGE } from "./usages.ts";
export { CHAT_USAGE };


const CALL_TIMEOUT = 30_000;
/** As the app pages its chat. */
const PAGE = 50;

type ChatCommand =
  | { kind: "send"; project: string; text: string; now: boolean; wait: boolean; follow: boolean }
  | { kind: "history"; project: string; page: number };
export type ChatArgs = { command: ChatCommand; hub?: string; home?: string; keyFile: string };

export function parseChatArgs(argv: string[]): ChatArgs {
  const v = parse(argv, {
    options: { hub: "str", "key-file": "str", wait: "bool", follow: "bool", now: "bool", page: "str" },
    positionals: true,
  });
  if (v instanceof ArgError) throw v;
  const p = v.positionals;
  let command: ChatCommand;
  if (p[0] === "history") {
    if (v.flag("wait") || v.flag("follow") || v.flag("now")) {
      throw new ArgError("--now, --wait and --follow are for sending, not history");
    }
    if (p.length !== 2) throw new ArgError("expected fleetd chat history <project>");
    const raw = v.str("page");
    let page = 1;
    if (raw !== undefined) {
      page = /^\+?[0-9]+$/.test(raw) ? Number(raw) : 0;
      if (!(page > 0)) throw new ArgError("--page is a page number: 1 is the newest");
    }
    command = { kind: "history", project: p[1]!, page };
  } else {
    if (v.has("page")) throw new ArgError("--page is for history");
    const [project, ...words] = p;
    const text = words.join(" ");
    if (project === undefined || text.trim() === "") {
      throw new ArgError(`expected fleetd chat <machine>/<project> "<text>"`);
    }
    command = { kind: "send", project, text, now: v.flag("now"), wait: v.flag("wait"), follow: v.flag("follow") };
  }
  const keyFile = v.str("key-file");
  if (!keyFile) {
    throw new ArgError(
      "--key-file is required: the key says who writes, your human key as you and an agent key as that agent. Make yours once: fleetd hub key create --human --name <device> --out <file>",
    );
  }
  const hub = v.str("hub") || undefined;
  return { command, ...(hub === undefined ? {} : { hub }), keyFile };
}

// ---- what it prints ----

/** Who wrote a message, as the app's header says it. */
export function authorLabel(message: unknown): string {
  switch (st(message, "author")) {
    case "human":
      return `you · ${st(message, "client") ?? "app"}`;
    case "agent":
      return `agent · ${st(message, "by") ?? "unnamed"}`;
    case "lead":
      return "lead";
    default:
      return "fleetd";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Oct 22 14:02`, in this machine's zone. */
function when(iso: string): string {
  const ms = parseRfc3339(iso);
  if (ms === undefined) return "";
  const z = zoned(ms);
  return `${z.month} ${z.day} ${z.hour}:${z.minute}`;
}
void MONTHS;

function itemLine(item: any): string | undefined {
  const state = st(item, "state") ?? "open";
  switch (st(item, "kind")) {
    case "secret_request":
      return `asks for a secret, ${st(item, "name") ?? "unnamed"}: ${state}`;
    case "command_approval": {
      const argv = item?.gated?.argv;
      const what = Array.isArray(argv)
        ? argv.filter((a: unknown) => typeof a === "string").join(" ")
        : (st(item?.permission, "tool") ?? "");
      return `asks to run \`${what}\`: ${state}`;
    }
    default:
      return undefined;
  }
}

/** One message: who and when on a line, then what it says, indented. */
export function renderMessage(message: any): string {
  let out = authorLabel(message);
  const created = st(message, "createdAt");
  const at = created === undefined ? "" : when(created);
  if (at !== "") out += `  ${at}`;
  out += "\n";
  const body = (message?.item !== undefined ? itemLine(message.item) : undefined) ?? st(message, "text") ?? "";
  for (const line of linesOf(body.replace(/\s+$/, ""))) out += `  ${line}\n`;
  return out;
}

/** Rust's `str::lines`: split on `\n`, a trailing `\r` dropped, no last empty line. */
export function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** The line after a send: how it went in, from chat_send's answer. */
export function sentLine(sent: any): string {
  const who = authorLabel(sent?.message);
  const why = st(sent, "leadWaiting");
  if (why !== undefined) return `held, as ${who}: ${why}`;
  const how =
    {
      turn: "it starts the lead's next turn",
      steer: "the lead is working and reads it at its next step",
      now: "the lead stopped its step to read it",
    }[st(sent?.message, "delivery") ?? ""] ?? "it goes in as soon as the lead is ready";
  return `sent as ${who}: ${how}`;
}

/** What a `chat_delta` adds to what was printed of a message: UTF-16 offsets, as the hub counts them. */
export const applyDelta = (printed: string, offset: number, append: string) =>
  offset === printed.length ? append : undefined;

/** The rest of a finished message after what was streamed of it. */
export function restOf(printed: string, full: string): string {
  if (full.startsWith(printed)) return full.slice(printed.length);
  return printed === "" ? full : `\n${full}`;
}

// ---- the app socket ----

/** `http://host:port` → `ws://host:port/app`. */
export function appUrl(hub: string): string {
  const h = hub.replace(/\/+$/, "");
  const ws = h.startsWith("https://") ? `wss://${h.slice(8)}` : h.startsWith("http://") ? `ws://${h.slice(7)}` : h;
  return `${ws}/app`;
}

const refusal = (frame: any) => {
  const fix = st(frame, "fix");
  return new Refused(`${st(frame, "message") ?? "the hub refused"}${fix === undefined ? "" : `\n  fix: ${fix}`}`);
};

/** The hub's app socket, authenticated. Frames read while waiting for a call's answer are kept, in order. */
class Socket {
  private nextId = 0;
  private readonly queue: any[] = [];
  private waiters: ((frame: any) => void)[] = [];
  private closed: Error | undefined;
  private readonly kept: any[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      let frame;
      try {
        frame = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const w = this.waiters.shift();
      if (w) w(frame);
      else this.queue.push(frame);
    });
    ws.addEventListener("close", () => {
      this.closed ??= new Unreachable("the hub closed the connection");
      for (const w of this.waiters.splice(0)) w(undefined);
    });
  }

  static async open(hub: string, key: string): Promise<Socket> {
    const url = appUrl(hub);
    const ws = new WebSocket(url);
    const opened = await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(`the hub at ${hub} does not answer`), 15_000);
      ws.addEventListener("open", () => (clearTimeout(timer), resolve(undefined)));
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        resolve(`cannot reach the hub at ${hub}: ${(e as ErrorEvent).message ?? "connection failed"}`);
      });
    });
    if (opened !== undefined) throw new Unreachable(opened);
    const socket = new Socket(ws);
    socket.send({ t: "auth", key });
    for (;;) {
      const frame = await socket.read();
      if (st(frame, "t") === "ready") return socket;
      if (st(frame, "t") === "error") throw refusal(frame);
    }
  }

  send(frame: unknown) {
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (error) {
      throw new Unreachable(`the hub connection failed: ${(error as Error).message}`);
    }
  }

  private read(): Promise<any> {
    const frame = this.queue.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) =>
      this.waiters.push((f) => (f === undefined ? reject(this.closed) : resolve(f))),
    );
  }

  next(): Promise<any> {
    const frame = this.kept.shift();
    return frame !== undefined ? Promise.resolve(frame) : this.read();
  }

  async call(tool: string, input: unknown): Promise<any> {
    const id = `c${++this.nextId}`;
    this.send({ t: "call", id, tool, input });
    const answer = (async () => {
      for (;;) {
        const frame = await this.read();
        if (st(frame, "id") === id) {
          if (st(frame, "t") === "result") return frame.output;
          throw refusal(frame);
        }
        this.kept.push(frame);
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Unreachable(`the hub did not answer ${tool}`)), CALL_TIMEOUT);
    });
    try {
      return await Promise.race([answer, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    this.ws.close();
  }
}

/** The project `given` names, as `fleetd status` finds one. */
async function projectRef(socket: Socket, given: string): Promise<any> {
  const slash = given.indexOf("/");
  const named = slash >= 0 && isMachineId(given.slice(0, slash)) ? [given.slice(0, slash), given.slice(slash + 1)] : undefined;
  const listed = await socket.call("project_get", { machineId: named?.[0] ?? null });
  const projects: any[] = Array.isArray(listed?.projects) ? listed.projects : [];
  let why: string;
  try {
    return resolveProject(given, projects);
  } catch (error) {
    why =
      projects.length === 0
        ? `no project ${given}: the hub has none yet`
        : (error as Error).message.replace("no order or project", "no project");
  }
  if (named === undefined) throw new Refused(why);
  const r = { machineId: named[0], projectId: named[1] };
  try {
    await socket.call("project_get", r);
    return r;
  } catch (error) {
    if (error instanceof Refused) throw new Refused(why);
    throw error;
  }
}

/** The session's thread id when this runs inside a fleetd session (node/runner/process `session_thread_id`). */
export function sessionThreadId(): string | undefined {
  const env = process.env.FLEETD_THREAD_ID;
  if (env) return env;
  if (process.platform !== "linux") return undefined;
  const seen = new Set<number>();
  let at = process.pid;
  while (at > 1 && !seen.has(at)) {
    seen.add(at);
    try {
      const vars = readFileSync(`/proc/${at}/environ`, "latin1").split("\0");
      const hit = vars.find((v) => v.startsWith("FLEETD_THREAD_ID="))?.slice(17);
      if (hit) return hit;
    } catch {}
    try {
      const stat = readFileSync(`/proc/${at}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      at = Number(after[1]);
      if (!Number.isInteger(at)) return undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
void readlinkSync;

async function send(socket: Socket, project: any, c: Extract<ChatCommand, { kind: "send" }>): Promise<number> {
  const watch = c.wait || c.follow;
  if (watch) {
    const cursor = (await socket.call("fleetd_status", {}))?.cursor ?? null;
    if (c.follow) socket.send({ t: "chat", project });
    socket.send({ t: "events", cursor });
  }
  const input: Record<string, unknown> = { projectRef: project, text: c.text, clientRequestId: clientRequestId(), client: "cli" };
  if (c.now) input.now = true;
  const session = sessionThreadId();
  if (session !== undefined) input.session = session;
  const sent = await socket.call("chat_send", input);
  println(sentLine(sent));
  if (!watch) {
    println(`\`fleetd chat history ${c.project}\` shows the lead's reply`);
    return 0;
  }
  return followReply(socket, project, typeof sent?.message?.seq === "number" ? sent.message.seq : 0, c.follow);
}

const sameRef = (a: any, b: any) => a?.machineId === b?.machineId && a?.projectId === b?.projectId && a && Object.keys(a).length === 2;

async function followReply(socket: Socket, project: any, after: number, follow: boolean): Promise<number> {
  const ours = (frame: any) => sameRef(frame?.projectRef, project);
  const texts = new Map<number, string>();
  let current: number | undefined;
  let replied = false;
  let worked = false;
  const header = (seq: number) => {
    if (current !== seq) {
      if (current !== undefined) println();
      println(`${replied ? "\n" : ""}lead`);
      current = seq;
    }
  };
  for (;;) {
    const frame = await socket.next();
    const t = st(frame, "t");
    if (t === "chat_delta" && follow && ours(frame)) {
      const seq = typeof frame.seq === "number" ? frame.seq : 0;
      if (seq <= after) continue;
      header(seq);
      replied = true;
      const printed = texts.get(seq) ?? "";
      const add = applyDelta(printed, typeof frame.offset === "number" ? frame.offset : 0, st(frame, "append") ?? "");
      if (add !== undefined) {
        write(add);
        texts.set(seq, printed + add);
      }
    } else if (t === "event") {
      const data = frame.data;
      if (!ours(data)) continue;
      const type = st(frame, "type");
      const seq = typeof data?.seq === "number" ? data.seq : 0;
      if (type === "chat.message" && st(data, "author") === "lead" && st(data, "state") === "final" && seq > after) {
        const message =
          data.message !== null && typeof data.message === "object"
            ? data.message
            : (await socket.call("chat_history", { projectRef: project, after: seq - 1, limit: 1 }))?.messages?.[0];
        const full = st(message, "text") ?? "";
        if (full.trim() === "") continue;
        header(seq);
        const printed = texts.get(seq) ?? "";
        texts.delete(seq);
        println(restOf(printed, full).replace(/\n+$/, ""));
        current = undefined;
        replied = true;
      } else if (type === "chat.waiting") {
        if (data.leadWorking === true) worked = true;
        else if (worked || replied) {
          if (current !== undefined) println();
          if (!replied) println("the lead's turn ended without a reply");
          return replied ? 0 : 1;
        }
      }
    } else if (t === "error" && frame.id === undefined) {
      throw refusal(frame);
    }
  }
}

async function history(socket: Socket, project: any, page: number, given: string): Promise<number> {
  let before: number | undefined;
  let out: any = null;
  for (let n = 1; n <= page; n++) {
    const input: Record<string, unknown> = { projectRef: project, limit: PAGE };
    if (before !== undefined) input.before = before;
    out = await socket.call("chat_history", input);
    const first = out?.messages?.[0]?.seq;
    if (n < page) {
      if (typeof first === "number" && out?.moreBefore === true) before = first;
      else {
        println(`the chat has no page ${page}`);
        return 0;
      }
    }
  }
  const messages: any[] = Array.isArray(out?.messages) ? out.messages : [];
  if (messages.length === 0) println("no messages yet");
  for (const m of messages) write(renderMessage(m));
  if (out?.moreBefore === true) println(`older: fleetd chat history ${given} --page ${page + 1}`);
  return 0;
}

async function run(args: ChatArgs): Promise<number> {
  const url = hubUrl(args.hub, args.home);
  let key: string;
  try {
    key = readFileSync(args.keyFile, "utf8").trim();
  } catch (error) {
    throw new Refused(`cannot read --key-file: ${ioMessage(error)}`);
  }
  const socket = await Socket.open(url, key);
  try {
    const r = await projectRef(socket, args.command.project);
    return args.command.kind === "send"
      ? await send(socket, r, args.command)
      : await history(socket, r, args.command.page, args.command.project);
  } finally {
    socket.close();
  }
}

/** `fleetd chat …`. */
export async function chatCommand(argv: string[]): Promise<number> {
  let args: ChatArgs;
  try {
    args = parseChatArgs(argv);
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    process.stderr.write(`fleetd: ${error.message}\n\nusage:\n${CHAT_USAGE}`);
    return 2;
  }
  try {
    return await run(args);
  } catch (error) {
    return reportAs("chat", error);
  }
}
