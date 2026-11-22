// `fleetd mcp-relay --server <name>`: how an agent's claude reaches an MCP server that signs in with OAuth. The node
// writes it into the session's `--mcp-config` as a stdio server in place of the server's URL and `Authorization`
// header (node/actions/mcp.ts `sessionConfig`), and it relays each message to the server, MCP's streamable HTTP or its
// older SSE transport, with the headers the node holds at that moment (`mcp_header` on FLEETD_NODE_SOCK): the hub
// renews the token every few minutes, so a session longer than one token's life keeps the server. A 401 asks the node
// to have the hub renew it now (`mcp_renew`) and sends again; when that can't help, or the server can't be reached, the
// call is answered in words the agent can act on, and the server stays connected for the next one. The token is
// never written anywhere: not to the config, stdout, stderr or a log.
import { Masker } from "../node/mask.ts";
import { VERSION } from "../shared/version.ts";
import { sendToNode } from "./agent_mcp/socket.ts";

type Json = Record<string, unknown>;
type Headers_ = { transport: { type: string; url?: string }; headers: Record<string, string>; fingerprint: string };
/** The node's answer to `mcp_header` and `mcp_renew`. */
type NodeAnswer = Headers_ | { refused: string; signedOut: boolean };
/** Why a message couldn't go: the words the agent reads. */
class Failed extends Error {}

/** How long one request may take, through to its answer's end. */
export const REQUEST_TIMEOUT_MS = 10 * 60_000;
const NODE_TIMEOUT_MS = 70_000;
const PROTOCOL_VERSION = "2025-06-18";
/** The id of an `initialize` the relay sends again itself, for a session the server forgot: its answer isn't claude's. */
const REPLAY_ID = "fleetd-relay-initialize";
const USAGE = "usage: fleetd mcp-relay --server <name>";

export type RelayDeps = {
  /** One `browser_call` to the node for this session: the call's result, or (thrown) why the node couldn't be asked. */
  node: (call: Json) => Promise<Json>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** One line to claude. */
  write: (line: string) => Promise<void>;
  /** A line for claude's MCP log: never a secret. */
  log: (line: string) => void;
  timeoutMs?: number;
};

const isRequest = (m: Json) => typeof m.method === "string" && m.id !== undefined && m.id !== null;
const trim = (s: string) => s.trim().replace(/\.$/, "");

/** Words for a sign-in that is gone: what the person does, and that the agent carries on. */
export const signedOutText = (name: string, why: string) =>
  `${name}'s sign-in has ended (${trim(why)}). Ask the person to sign in to ${name} again: Sign in again on ${name} in Connections. Until then, carry on without ${name} and say so in your result.`;

/** Words for a server that can't be reached now. */
export const notNowText = (name: string, why: string) =>
  `${name} can't be reached right now (${trim(why)}). Try again in a minute; if it keeps failing, carry on without ${name} and say so in your result.`;

export class Relay {
  #session: string | undefined;
  #protocol = PROTOCOL_VERSION;
  #init: Json | undefined;
  /** The older SSE transport: where to POST, the open event stream, and the requests it still owes an answer. */
  #sse: { endpoint: string; done: Promise<void>; close: () => void } | undefined;
  /** Requests not answered yet, and what waits for each one's answer. */
  #owed = new Map<unknown, Json>();
  #waiting = new Map<unknown, () => void>();
  #mask = new Masker([]);

  constructor(
    readonly name: string,
    readonly deps: RelayDeps,
  ) {}

  /** The server's headers now, from the node. */
  async #current(): Promise<Headers_> {
    return this.#answer(await this.#ask({ op: "mcp_header", server: this.name }));
  }

  async #ask(call: Json): Promise<NodeAnswer> {
    try {
      return (await this.deps.node(call)) as NodeAnswer;
    } catch (why) {
      throw new Failed(notNowText(this.name, `fleetd's node didn't answer: ${String(why)}`));
    }
  }

  #answer(a: NodeAnswer): Headers_ {
    if ("refused" in a) throw new Failed(a.signedOut ? signedOutText(this.name, a.refused) : notNowText(this.name, a.refused));
    this.#mask = new Masker(Object.entries(a.headers));
    return a;
  }

  /**
   * `send` with the server's current headers. A 401 has the node renew the token, then sends again; a second 401 says
   * the token just renewed was refused too, which signs the server out unless the node holds a newer one, which gets
   * one last try.
   */
  async #authed(send: (h: Headers_) => Promise<Response>): Promise<Response> {
    let h = await this.#current();
    for (let round = 0; ; round++) {
      let response: Response;
      try {
        response = await send(h);
      } catch (error) {
        if (error instanceof Failed) throw error;
        const e = error as Error;
        const why = e.name === "TimeoutError" || e.name === "AbortError" ? `it didn't answer within ${Math.round((this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS) / 60_000)} min` : e.message;
        throw new Failed(notNowText(this.name, this.#mask.text(why)));
      }
      if (response.status !== 401) return response;
      await response.body?.cancel().catch(() => {});
      if (round >= 2) throw new Failed(signedOutText(this.name, `${this.name} turned away fleetd's renewed sign-in`));
      h = this.#answer(await this.#ask({ op: "mcp_renew", server: this.name, fingerprint: h.fingerprint, ...(round === 1 ? { refused: true } : {}) }));
    }
  }

  #signal = () => AbortSignal.timeout(this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS);

  /** `fetch` following at most 10 redirects, each to the first URL's own origin only: the token never goes elsewhere. */
  async #fetch(url: string, init: RequestInit): Promise<Response> {
    const origin = new URL(url).origin;
    let at = url;
    for (let hop = 0; ; hop++) {
      const response = await this.deps.fetch(at, { ...init, redirect: "manual" });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location || hop >= 10) return response;
      const next = new URL(location, at);
      if (next.origin !== origin) return response;
      await response.body?.cancel().catch(() => {});
      at = next.toString();
    }
  }

  async #post(url: string, message: Json, h: Headers_): Promise<Response> {
    return this.#fetch(url, {
      method: "POST",
      signal: this.#signal(),
      headers: {
        ...h.headers,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": this.#protocol,
        "user-agent": `fleetd-mcp-relay/${VERSION}`,
        ...(this.#session ? { "mcp-session-id": this.#session } : {}),
      },
      body: JSON.stringify(message),
    });
  }

  /** A server's message for claude; the answer to an `initialize` the relay sent again itself stays here. */
  async #emit(m: Json): Promise<void> {
    if (m.id === REPLAY_ID) return;
    if (m.id !== undefined && ("result" in m || "error" in m)) {
      if (this.#init && m.id === this.#init.id) {
        const version = (m.result as Json | undefined)?.protocolVersion;
        if (typeof version === "string") this.#protocol = version;
      }
      this.#settle(m.id);
    }
    await this.deps.write(JSON.stringify(m));
  }

  /** Whether `id` was still owed; it isn't now. */
  #settle(id: unknown): boolean {
    const owed = this.#owed.delete(id);
    this.#waiting.get(id)?.();
    this.#waiting.delete(id);
    return owed;
  }

  /** Claude's message, to the server. A request that can't be answered is answered with why. */
  async deliver(m: Json): Promise<void> {
    if (m.method === "initialize") this.#init = m;
    if (isRequest(m)) this.#owed.set(m.id, m);
    try {
      await this.#deliver(m);
      if (isRequest(m) && this.#owed.has(m.id)) throw new Failed(notNowText(this.name, `${this.name} ended its answer before it finished`));
    } catch (error) {
      if (!(error instanceof Failed)) throw error;
      await this.#fail(m, error.message);
    }
  }

  async #fail(m: Json, text: string): Promise<void> {
    if (!isRequest(m) || !this.#settle(m.id)) {
      this.deps.log(`fleetd mcp-relay: ${text}`);
      return;
    }
    // A tool's call answered with a tool error keeps the server connected; anything else is the request's error.
    const answer =
      m.method === "tools/call"
        ? { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }], isError: true } }
        : { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: text } };
    await this.deps.write(JSON.stringify(answer));
  }

  async #deliver(m: Json): Promise<void> {
    const h = await this.#current();
    const url = h.transport.url ?? "";
    if (h.transport.type === "sse") return this.#viaSse(url, m);
    for (let replayed = false; ; replayed = true) {
      const response = await this.#authed((now) => this.#post(url, m, now));
      // A session the server no longer knows: it starts a new one, as the first did, and the message goes again.
      if (response.status === 404 && this.#session && m.method !== "initialize" && !replayed && this.#init) {
        await response.body?.cancel().catch(() => {});
        this.#session = undefined;
        await this.#reinitialize(url);
        continue;
      }
      return this.#take(response);
    }
  }

  async #reinitialize(url: string): Promise<void> {
    const again = { ...this.#init, id: REPLAY_ID };
    await this.#take(await this.#authed((h) => this.#post(url, again, h)));
    const done = await this.#authed((h) => this.#post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, h));
    await done.body?.cancel().catch(() => {});
  }

  /** A POST's answer: nothing (202), one message or a batch, or an event stream of them. */
  async #take(response: Response): Promise<void> {
    const session = response.headers.get("mcp-session-id");
    if (session) this.#session = session;
    if (response.status === 202) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const said = body.trim() ? `: ${[...this.#mask.text(body.trim())].slice(0, 300).join("")}` : "";
      throw new Failed(notNowText(this.name, `it answered HTTP ${response.status}${said}`));
    }
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for await (const [, data] of events(response.body)) await this.#emitText(data);
      return;
    }
    const body = await response.text();
    if (body.trim()) await this.#emitText(body);
  }

  async #emitText(text: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    for (const m of Array.isArray(value) ? value : [value]) if (m && typeof m === "object") await this.#emit(m as Json);
  }

  /** MCP's older HTTP transport: an event stream carries the server's messages, and each of claude's is a POST to
   * the endpoint it names. A stream that ends is opened again, with the newest headers, at the next message. */
  async #viaSse(url: string, m: Json): Promise<void> {
    if (!this.#sse) await this.#openSse(url, m.method !== "initialize");
    const sse = this.#sse!;
    const response = await this.#authed((h) =>
      this.#fetch(sse.endpoint, {
        method: "POST",
        signal: this.#signal(),
          headers: { ...h.headers, "content-type": "application/json", "user-agent": `fleetd-mcp-relay/${VERSION}` },
        body: JSON.stringify(m),
      }),
    );
    if (!response.ok) await this.#take(response);
    await response.body?.cancel().catch(() => {});
    if (!isRequest(m)) return;
    // Its answer comes on the stream: wait for it, or for the stream to end.
    if (this.#owed.has(m.id)) await Promise.race([sse.done, new Promise<void>((answered) => this.#waiting.set(m.id, answered))]);
  }

  async #openSse(url: string, replay: boolean): Promise<void> {
    const abort = new AbortController();
    const response = await this.#authed((h) =>
      this.#fetch(url, { signal: abort.signal, headers: { ...h.headers, accept: "text/event-stream", "user-agent": `fleetd-mcp-relay/${VERSION}` } }),
    );
    if (!response.ok) await this.#take(response);
    const stream = events(response.body);
    let endpoint: string | undefined;
    for (;;) {
      const next = await stream.next();
      if (next.done) throw new Failed(notNowText(this.name, `${this.name} closed its event stream before it named where to send`));
      const [name, data] = next.value;
      if (name !== "endpoint") continue;
      const at = new URL(data.trim(), url);
      // Its headers (the token among them) go to the server's own origin only.
      if (at.origin !== new URL(url).origin) throw new Failed(notNowText(this.name, `${this.name} named an endpoint on another origin (${at.origin})`));
      endpoint = at.toString();
      break;
    }
    let done: Promise<void>;
    done = (async () => {
      try {
        for (let next = await stream.next(); !next.done; next = await stream.next()) if (next.value[0] === "message") await this.#emitText(next.value[1]);
      } catch {}
      if (this.#sse?.done === done!) this.#sse = undefined;
      // Requests the stream still owed an answer are answered with why.
      for (const owed of [...this.#owed.values()]) await this.#fail(owed, notNowText(this.name, `${this.name} closed its event stream`));
    })();
    this.#sse = { endpoint, done, close: () => abort.abort() };
    if (replay && this.#init) {
      // A stream opened again is a new session: initialized again, before claude's message goes.
      for (const again of [{ ...this.#init, id: REPLAY_ID }, { jsonrpc: "2.0", method: "notifications/initialized" }]) {
        const r = await this.#authed((h) =>
          this.#fetch(endpoint!, { method: "POST", signal: this.#signal(), headers: { ...h.headers, "content-type": "application/json" }, body: JSON.stringify(again) }),
        );
        await r.body?.cancel().catch(() => {});
      }
    }
  }

  /** Claude closed stdin: the server's session ends too, as far as the relay can tell it. */
  async close(): Promise<void> {
    this.#sse?.close();
    if (!this.#session) return;
    try {
      const h = await this.#current();
      if (h.transport.type !== "http" || !h.transport.url) return;
      const r = await this.#fetch(h.transport.url, {
        method: "DELETE",
        signal: AbortSignal.timeout(2_000),
        headers: { ...h.headers, "mcp-session-id": this.#session, "mcp-protocol-version": this.#protocol },
      });
      await r.body?.cancel().catch(() => {});
    } catch {}
  }
}

/** An event stream's events, `[name, data]`. */
export async function* events(body: ReadableStream<Uint8Array> | null): AsyncGenerator<[string, string]> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const block = function* (): Generator<[string, string]> {
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const text = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let name = "message";
      const data: string[] = [];
      for (const line of text.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield [name, data.join("\n")];
    }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    yield* block();
  }
  buffer += "\n\n";
  yield* block();
}

/** Serves `input`'s lines until it ends: a request goes at once, each in its own time; `initialize`, notifications
 * and answers go one after another, so the server reads them in claude's order. */
export async function serve(relay: Relay, input: AsyncIterable<string>): Promise<void> {
  const inflight = new Set<Promise<void>>();
  for await (const line of input) {
    if (!line.trim()) continue;
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch (error) {
      await relay.deps.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `parse error: ${(error as Error).message}` } }));
      continue;
    }
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const message = m as Json;
    if (isRequest(message) && message.method !== "initialize") {
      const going: Promise<void> = relay.deliver(message).finally(() => inflight.delete(going));
      inflight.add(going);
    } else await relay.deliver(message);
  }
  await Promise.all(inflight);
  await relay.close();
}

async function* lines(input: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) yield buffer;
}

/** `fleetd mcp-relay --server <name>`, for an agent's claude, which starts it from the session's `--mcp-config`. */
export async function mcpRelay(argv: string[]): Promise<number> {
  const name = argv.length === 2 && argv[0] === "--server" ? argv[1] : undefined;
  const sock = process.env.FLEETD_NODE_SOCK;
  if (!name || !sock) {
    process.stderr.write(`${USAGE}${name ? " (run by an agent's session, with FLEETD_NODE_SOCK set)" : ""}\n`);
    return 2;
  }
  const thread = process.env.FLEETD_THREAD_ID;
  const out = Bun.stdout.writer();
  const relay = new Relay(name, {
    node: async (call) => {
      const frame = { t: "browser_call", id: `relay-${process.pid}`, cwd: process.cwd(), call, ...(thread ? { threadId: thread } : {}) };
      const answer = await sendToNode(sock, frame, NODE_TIMEOUT_MS);
      if (answer.error) throw String((answer.error as Json).message ?? "the node refused");
      return answer.result as Json;
    },
    fetch: (url, init) => fetch(url, init),
    write: async (line) => {
      out.write(`${line}\n`);
      await out.flush();
    },
    log: (line) => process.stderr.write(`${line}\n`),
  });
  try {
    await serve(relay, lines(Bun.stdin.stream()));
  } catch (error) {
    if ((error as { code?: string }).code !== "EPIPE") throw error;
  }
  return 0;
}
