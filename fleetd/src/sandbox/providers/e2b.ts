// E2B (e2b.dev), or a self-hosted E2B at the team's `domain` (E2B Embed: the same API with no E2B account). Plain
// HTTP against E2B's public API (docs.e2b.dev/openapi-public.yaml): the platform API at `api.<domain>` with the key in
// `X-API-Key`, and each box's own agent (envd, port 49983) at `<port>-<id>.<domain>` with the box's access token.
//
// - A box is made with an explicit timeout (E2B's default is 5 minutes, then it is killed), auto-pause off (a paused
//   box keeps its memory, secrets included, in E2B's storage), and its ports private (`allowPublicTraffic: false`;
//   older projects default to public). Its port is reached with the `e2b-traffic-access-token` header.
// - The tokens a box's calls need come with its create; after a node restart, `connect` (which never shortens a
//   box's life) gives them again. They are kept in memory only.
// - A detached command is envd's Process.Start (Connect protocol, server streaming) read until the process starts,
//   then let go: the process outlives the call. Its environment is the call's own `envs`.
import { badKey, type Box, type BuildOptions, type ClientOptions, type CreateOptions, DEFAULT_SIZE, LABEL, labelsFor, type Provider, type ProviderAuth, SECRET_HEADER, type StartOptions } from "./common.ts";
import { type Answer, Http, pause, ProviderError } from "./http.ts";
import { parse } from "./recipe.ts";
import { dial } from "./stream.ts";

const NAME = "E2B";
export const DEFAULT_DOMAIN = "e2b.app";
/** envd's port inside every box. */
export const ENVD_PORT = 49983;

type Access = { envd: string; traffic: string; domain: string };

export function e2b(auth: ProviderAuth, o: ClientOptions = {}): Provider {
  const domain = (auth.domain || DEFAULT_DOMAIN).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const http = new Http({ name: NAME, base: o.urls?.api ?? `https://api.${domain}`, headers: { "X-API-Key": auth.key }, key: auth.key, fetch: o.fetch, signal: o.signal, refine });
  const host = (id: string, port: number, d: string) => o.urls?.sandbox?.(id, port) ?? `https://${port}-${id}.${d}`;
  const access = new Map<string, Access>();
  const pollMs = o.pollMs ?? 2000;

  const remember = (b: any): Access => {
    const a = { envd: String(b?.envdAccessToken ?? ""), traffic: String(b?.trafficAccessToken ?? ""), domain: String(b?.domain || domain) };
    access.set(String(b.sandboxID), a);
    return a;
  };
  /** The box's tokens: kept from its create, else asked for again (a 1-second timeout never shortens its life). */
  async function tokens(id: string, signal?: AbortSignal): Promise<Access> {
    const kept = access.get(id);
    if (kept) return kept;
    const a = await http.call("POST", `/v2/sandboxes/${encodeURIComponent(id)}/connect`, { body: { timeout: 1 }, signal });
    return remember(a.body);
  }
  const envdHeaders = (id: string, a: Access) => ({ "X-Access-Token": a.envd, "E2b-Sandbox-Id": id, "E2b-Sandbox-Port": String(ENVD_PORT) });

  return {
    id: "e2b",

    async create(c: CreateOptions): Promise<Box> {
      const bad = badKey(c.key);
      if (bad) throw new ProviderError("failed", bad);
      const labels = labelsFor(c);
      const body = {
        templateID: c.template,
        timeout: seconds(c.lifetimeMs),
        autoPause: false,
        allow_internet_access: true,
        network: { allowPublicTraffic: false },
        metadata: labels,
      };
      for (let tries = 0; ; tries++) {
        try {
          const a = await http.call("POST", "/v2/sandboxes", { body, headers: { "Idempotency-Key": c.key }, signal: c.signal });
          remember(a.body);
          return { id: String(a.body.sandboxID), labels };
        } catch (e) {
          // Another try of the same key still under way: E2B answers its box once it is made.
          if (e instanceof ProviderError && e.code === "idempotency_in_progress" && tries < 10) {
            await pause(pollMs, c.signal);
            continue;
          }
          throw e;
        }
      }
    },

    async destroy(id, d = {}) {
      await http.call("DELETE", `/sandboxes/${encodeURIComponent(id)}`, { ok: [404], signal: d.signal });
      access.delete(id);
    },

    async list(l = {}) {
      const out: Box[] = [];
      let next: string | undefined;
      do {
        const a = await http.call("GET", "/v2/sandboxes", {
          query: { metadata: `${LABEL}=1`, state: "running,paused", limit: "100", nextToken: next },
          signal: l.signal,
        });
        for (const s of (a.body ?? []) as any[]) out.push({ id: String(s.sandboxID), labels: { ...(s.metadata ?? {}) } });
        next = a.headers.get("x-next-token") || undefined;
      } while (next);
      return out.filter((b) => b.labels[LABEL] === "1");
    },

    async start(id: string, s: StartOptions) {
      const [cmd, ...args] = s.argv;
      if (!cmd) throw new ProviderError("failed", "nothing to start: the command is empty");
      const a = await tokens(id, s.signal);
      const stop = new AbortController();
      const signal = s.signal ? AbortSignal.any([s.signal, stop.signal]) : stop.signal;
      const res = await http.call("POST", "/process.Process/Start", {
        base: host(id, ENVD_PORT, a.domain),
        headers: { ...envdHeaders(id, a), "content-type": "application/connect+json", "Connect-Protocol-Version": "1", "Keepalive-Ping-Interval": "50" },
        body: frame({ process: { cmd, args, envs: s.env, cwd: s.cwd ?? null }, stdin: false }),
        raw: true,
        signal,
      });
      try {
        for await (const msg of frames(res.res.body!)) {
          if (msg.end) {
            const err = msg.payload?.error;
            throw new ProviderError("failed", `E2B couldn't start ${cmd} in the box${err ? `: ${err.message ?? err.code}` : ""}`);
          }
          const ev = msg.payload?.event;
          if (ev?.start) return;
          if (ev?.end) throw new ProviderError("failed", `${cmd} ended as soon as it started in the box (${ev.end.status ?? `exit ${ev.end.exitCode ?? "?"}`})`);
        }
        throw new ProviderError("failed", `E2B ended the start of ${cmd} before it ran`);
      } finally {
        // Letting go of the stream leaves the process running (E2B's own `background` does the same).
        stop.abort();
      }
    },

    async connect(id, port, secret, c = {}) {
      const a = await tokens(id, c.signal);
      return dial({
        name: NAME,
        url: host(id, port, a.domain),
        headers: { "e2b-traffic-access-token": a.traffic, [SECRET_HEADER]: secret },
        secrets: [a.traffic, secret],
        signal: c.signal,
        WebSocket: o.WebSocket,
      });
    },

    async read(id, path, max, r = {}) {
      const a = await tokens(id, r.signal);
      const ans = await http.call("GET", "/files", {
        base: host(id, ENVD_PORT, a.domain),
        query: { path },
        headers: { ...envdHeaders(id, a), Range: `bytes=0-${max}`, "Accept-Encoding": "identity" },
        raw: true,
        ok: [404],
        signal: r.signal,
      });
      if (ans.status === 404) throw new ProviderError("failed", `the box has no file ${path}`, 404);
      const bytes = new Uint8Array(await ans.res.arrayBuffer());
      if (bytes.length > max) throw new ProviderError("failed", `${path} in the box is larger than ${max} bytes`);
      return bytes;
    },

    async lifetime(id, ms, l = {}) {
      await http.call("POST", `/sandboxes/${encodeURIComponent(id)}/timeout`, { body: { timeout: seconds(ms) }, signal: l.signal });
    },

    async build(dockerfile: string, b: BuildOptions) {
      const r = parse(dockerfile);
      const size = b.size ?? DEFAULT_SIZE;
      const made = await http.call("POST", "/v3/templates", { body: { name: b.name, cpuCount: size.cpu, memoryMB: size.memGb * 1024 }, signal: b.signal });
      const tid = String(made.body.templateID);
      const bid = String(made.body.buildID);
      const steps = r.steps.map((s) => ({ type: s.op, args: s.op === "RUN" ? [s.args[0]!, "root"] : s.args }));
      await http.call("POST", `/v2/templates/${encodeURIComponent(tid)}/builds/${encodeURIComponent(bid)}`, { body: { fromImage: r.from, steps }, signal: b.signal });
      let shown = 0;
      for (;;) {
        const st = await http.call("GET", `/templates/${encodeURIComponent(tid)}/builds/${encodeURIComponent(bid)}/status`, { signal: b.signal });
        const logs = ((st.body?.logEntries ?? []) as any[]).map((l) => String(l?.message ?? ""));
        for (const line of logs.slice(shown)) b.onLog?.(line);
        shown = Math.max(shown, logs.length);
        if (st.body?.status === "ready") return tid;
        if (st.body?.status === "error") {
          const why = st.body?.reason?.message ?? logs.slice(-3).join(" / ");
          throw new ProviderError("failed", `E2B couldn't build the template ${b.name}${why ? `: ${why}` : ""}`);
        }
        await pause(pollMs, b.signal);
      }
    },
  };
}

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/** E2B's own words for a refusal that its status alone doesn't say. */
function refine(a: Answer, words: string): { reason: "billing" | "limit" | "failed"; message: string } | undefined {
  if (a.status === 403 && /banned|blocked/i.test(words)) return { reason: "billing", message: `E2B has blocked this team's account (${words}).` };
  if (a.status === 400 && /lifetime limit|exceeds/i.test(words)) return { reason: "limit", message: `E2B's plan caps a sandbox's life below that (${words}).` };
  if (a.status === 429) return { reason: "limit", message: `E2B's limit for this team is reached: too many sandboxes at once or created too fast (${words}).` };
  if (a.status === 404 && /template/i.test(words)) return { reason: "failed", message: `E2B has no such template (${words}): build it first.` };
  return undefined;
}

/** One Connect-protocol frame: flags 0, the length, the JSON. */
export function frame(msg: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg));
  const out = new Uint8Array(5 + json.length);
  new DataView(out.buffer).setUint32(1, json.length);
  out.set(json, 5);
  return out;
}

/** The frames of a Connect-protocol stream: each payload, and whether it is the end-of-stream frame. */
export async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<{ end: boolean; payload: any }> {
  let buf = new Uint8Array(0);
  for await (const chunk of body) {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf);
    next.set(chunk, buf.length);
    buf = next;
    while (buf.length >= 5) {
      const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
      if (buf.length < 5 + len) break;
      const flags = buf[0]!;
      const text = new TextDecoder().decode(buf.subarray(5, 5 + len));
      buf = buf.slice(5 + len);
      let payload: any;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = {};
      }
      yield { end: (flags & 2) !== 0, payload };
    }
  }
}
