// HTTP over the team's tailnet from the node itself (W722): the hub's runner isn't on the tailnet (100.x doesn't route
// there), so a call it makes to a tailnet endpoint (a Claude account's Test) goes over a connection through the team's
// gateway (./tailnet.ts `dial`) instead: one HTTP/1.1 request (a GET, or a method with a body: an MCP server's Test
// POSTs), TLS on top for https, its answer read to its end.
import type { Duplex } from "node:stream";
import { isIP } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";

/** What the node's calls to an endpoint need of `fetch`. */
export type Fetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "follow" | "manual" | "error" },
) => Promise<Response>;

type Dial = (host: string, port: number) => Promise<Duplex>;

const HEAD_MAX = 64 << 10;
const BODY_MAX = 4 << 20;

/** A `fetch` whose every connection is `dial`'s; `tls` adds to https's options (a test's own CA). */
export function dialFetch(dial: Dial, tls: ConnectionOptions = {}): Fetcher {
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${u.protocol} isn't http or https`);
    const host = u.hostname.replace(/^\[(.*)\]$/u, "$1");
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    const method = init.method ?? "GET";
    if (!/^[A-Z]+$/u.test(method)) throw new Error(`${method} isn't an HTTP method`);
    const body = init.body === undefined ? undefined : Buffer.from(init.body, "utf8");
    const given = new Set(Object.keys(init.headers ?? {}).map((k) => k.toLowerCase()));
    const lines = [`${method} ${u.pathname || "/"}${u.search} HTTP/1.1`, `Host: ${u.host}`, "Connection: close"];
    if (!given.has("accept")) lines.push("Accept: */*");
    if (!given.has("user-agent")) lines.push("User-Agent: fleetd");
    if (body) lines.push(`Content-Length: ${body.length}`);
    for (const [k, v] of Object.entries(init.headers ?? {})) {
      if (["host", "connection", "content-length"].includes(k.toLowerCase())) continue;
      if (/[\r\n]/u.test(k + v)) throw new Error(`the header ${k} holds a line break`);
      lines.push(`${k}: ${v}`);
    }
    const signal = init.signal;
    signal?.throwIfAborted();
    let conn: Duplex | undefined;
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => (conn?.destroy(), reject(signal!.reason));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const go = async () => {
      const raw = await dial(host, port);
      if (signal?.aborted) throw (raw.destroy(), signal.reason);
      conn = raw;
      if (u.protocol === "https:") conn = await secure(raw, host, tls);
      conn.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (body) conn.write(body);
      return await answer(conn);
    };
    try {
      return await Promise.race([go(), aborted]);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      conn?.destroy();
    }
  };
}

function secure(raw: Duplex, host: string, tls: ConnectionOptions): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ socket: raw, host, ...(isIP(host) ? {} : { servername: host }), ALPNProtocols: ["http/1.1"], ...tls });
    s.once("secureConnect", () => resolve(s));
    s.once("error", (e: Error) => (raw.destroy(), reject(e)));
  });
}

/** The answer on `conn`: its status, headers and body, once its length (Content-Length, chunks, or the close) says
 * it is whole. */
function answer(conn: Duplex): Promise<Response> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let head: { status: number; statusText: string; headers: [string, string][]; at: number } | undefined;
    const finish = (body: Buffer | null) => {
      cleanup();
      const h = head!;
      const empty = h.status === 204 || h.status === 205 || h.status === 304;
      try {
        resolve(new Response(empty ? null : body, { status: h.status, statusText: h.statusText, headers: h.headers }));
      } catch (error) {
        reject(error as Error);
      }
    };
    const fail = (error: Error) => (cleanup(), reject(error));
    const whole = (ended: boolean): Buffer | undefined => {
      const body = buf.subarray(head!.at);
      const length = head!.headers.find(([k]) => k === "content-length")?.[1];
      if (head!.headers.some(([k, v]) => k === "transfer-encoding" && /chunked/iu.test(v))) return unchunk(body);
      if (length !== undefined) return body.length >= Number(length) ? body.subarray(0, Number(length)) : undefined;
      return ended ? body : undefined;
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!head) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return buf.length > HEAD_MAX ? fail(new Error("the endpoint's answer has no end to its headers")) : undefined;
        const [status, ...rest] = buf.subarray(0, end).toString("latin1").split("\r\n");
        const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/u.exec(status ?? "");
        if (!m) return fail(new Error("the endpoint didn't answer in HTTP"));
        const headers = rest.flatMap((l): [string, string][] => {
          const i = l.indexOf(":");
          return i > 0 ? [[l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]] : [];
        });
        head = { status: Number(m[1]), statusText: m[2] ?? "", headers, at: end + 4 };
      }
      if (buf.length - head.at > BODY_MAX) return fail(new Error("the endpoint's answer is too long"));
      const body = whole(false);
      if (body) finish(body);
    };
    const onEnd = () => {
      if (!head) return fail(new Error("the endpoint closed the connection without an answer"));
      const body = whole(true);
      if (body) finish(body);
      else fail(new Error("the endpoint closed the connection mid-answer"));
    };
    const onError = (e: Error) => fail(e);
    const cleanup = () => {
      conn.off("data", onData).off("end", onEnd).off("close", onEnd).off("error", onError);
    };
    conn.on("data", onData).on("end", onEnd).on("close", onEnd).on("error", onError);
  });
}

/** A chunked body, once its last chunk is in. */
function unchunk(body: Buffer): Buffer | undefined {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = body.indexOf("\r\n", at);
    if (eol < 0) return undefined;
    const size = parseInt(body.subarray(at, eol).toString("latin1"), 16);
    if (!Number.isFinite(size)) return undefined;
    if (size === 0) return Buffer.concat(parts);
    if (body.length < eol + 2 + size + 2) return undefined;
    parts.push(body.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
}
