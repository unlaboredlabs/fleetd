// Daytona: plain HTTP against its public API (www.daytona.io/docs/openapi.json, at app.daytona.io/api, the key as a
// bearer token) and each box's toolbox (www.daytona.io/docs/toolbox-openapi.json, at the `toolboxProxyUrl` the API
// gives, plus the box's id).
//
// - A box is ephemeral (`autoDeleteInterval: 0`: any stop deletes it, and an ephemeral box can't be paused), with
//   auto-stop off, a wall-clock life (`ttlMinutes`, which destroys it whatever its state) that fleetd extends, and its
//   preview private. Daytona has no idempotency key: the key is the box's name, and a create that finds the name taken
//   answers the box of that name when it carries the same key.
// - Daytona's size is the snapshot's, at most 4 vCPUs, 8 GB and 10 GB of disk (docs: sandboxes, "Resources").
// - A detached command is an async command of a toolbox session, which takes no environment: a one-shot command with
//   its own `envs` first writes them to a private file, which the detached command reads and removes (shell.ts).
// - Toolbox calls carry the key too: Daytona's toolbox proxy takes the same bearer token.
// - The guest's port is reached at its preview URL with the `x-daytona-preview-token` header, plus fleetd's secret.
import { badKey, type Box, type BuildOptions, type ClientOptions, type CreateOptions, DEFAULT_SIZE, KEY_LABEL, LABEL, labelsFor, notOffered, type Provider, type ProviderAuth, SECRET_HEADER, type StartOptions } from "./common.ts";
import { type Answer, Http, pause, ProviderError } from "./http.ts";
import { parse } from "./recipe.ts";
import { envFile, envPath, launcher, shq } from "./shell.ts";
import { dial } from "./stream.ts";

const NAME = "Daytona";
export const API = "https://app.daytona.io/api";
/** Daytona's largest box (docs: sandboxes, "Resources"). */
export const MAX = { cpu: 4, memGb: 8, diskGb: 10 };
const LOG = "/tmp/.fleetd-start.log";
/** The longest a new box may take to start before `start` gives up. */
const UP_MS = 5 * 60_000;

export function daytona(auth: ProviderAuth, o: ClientOptions = {}): Provider {
  const bearer = { Authorization: `Bearer ${auth.key}` };
  const http = new Http({ name: NAME, base: o.urls?.api ?? API, headers: bearer, key: auth.key, fetch: o.fetch, signal: o.signal, refine });
  const pollMs = o.pollMs ?? 2000;
  const toolbox = new Map<string, string>();
  const previews = new Map<string, { url: string; token: string }>();
  const box = (id: string) => `/sandbox/${encodeURIComponent(id)}`;

  const remember = (s: any) => {
    if (s?.toolboxProxyUrl) toolbox.set(String(s.id), `${String(s.toolboxProxyUrl).replace(/\/$/, "")}/${encodeURIComponent(String(s.id))}`);
  };

  /** The box's toolbox once it has started. */
  async function started(id: string, signal?: AbortSignal): Promise<string> {
    const until = Date.now() + UP_MS;
    for (;;) {
      const s = (await http.call("GET", box(id), { signal })).body;
      remember(s);
      const state = String(s?.state ?? "");
      if (state === "started" && toolbox.has(id)) return toolbox.get(id)!;
      if (["error", "build_failed", "destroyed", "destroying", "stopped", "archived"].includes(state)) {
        throw new ProviderError("failed", `the Daytona box is ${state.replace("_", " ")}${s?.errorReason ? ` (${s.errorReason})` : ""}`);
      }
      if (Date.now() > until) throw new ProviderError("failed", `the Daytona box didn't start within ${UP_MS / 60_000} minutes (it is ${state || "unknown"})`);
      await pause(pollMs, signal);
    }
  }

  return {
    id: "daytona",

    async create(c: CreateOptions): Promise<Box> {
      const bad = badKey(c.key);
      if (bad) throw new ProviderError("failed", bad);
      const labels = labelsFor(c);
      try {
        const a = await http.call("POST", "/sandbox", {
          body: {
            name: c.key,
            snapshot: c.template,
            labels,
            public: false,
            autoStopInterval: 0,
            autoDeleteInterval: 0,
            ttlMinutes: minutes(c.lifetimeMs),
          },
          signal: c.signal,
        });
        remember(a.body);
        return { id: String(a.body.id), labels };
      } catch (e) {
        if (!(e instanceof ProviderError && e.status === 409)) throw e;
        // The name is taken: the box an earlier try of this key made, or someone else's, which isn't ours to answer.
        const a = await http.call("GET", box(c.key), { signal: c.signal });
        if (a.body?.labels?.[KEY_LABEL] !== c.key) throw new ProviderError("failed", `Daytona already has a sandbox named ${c.key} that fleetd didn't make`, 409);
        remember(a.body);
        return { id: String(a.body.id), labels: { ...a.body.labels } };
      }
    },

    async destroy(id, d = {}) {
      await http.call("DELETE", box(id), { ok: [404], signal: d.signal });
      toolbox.delete(id);
      for (const k of previews.keys()) if (k.startsWith(`${id}:`)) previews.delete(k);
    },

    async list(l = {}) {
      const out: Box[] = [];
      let cursor: string | undefined;
      do {
        const a = await http.call("GET", "/sandbox", { query: { labels: JSON.stringify({ [LABEL]: "1" }), limit: "200", cursor }, signal: l.signal });
        const items = (Array.isArray(a.body) ? a.body : (a.body?.items ?? [])) as any[];
        for (const s of items) out.push({ id: String(s.id), labels: { ...(s.labels ?? {}) } });
        cursor = Array.isArray(a.body) ? undefined : (a.body?.nextCursor ?? undefined);
      } while (cursor);
      return out.filter((b) => b.labels[LABEL] === "1");
    },

    async start(id: string, s: StartOptions) {
      if (s.argv.length === 0) throw new ProviderError("failed", "nothing to start: the command is empty");
      const tb = await started(id, s.signal);
      let envAt: string | undefined;
      if (Object.keys(s.env).length > 0) {
        envAt = envPath();
        const w = await http.call("POST", "/process/execute", {
          base: tb,
          headers: bearer,
          body: { command: `sh -c ${shq(`umask 077 && printf '%s' "$FLEETD_ENV" > ${shq(envAt)}`)}`, envs: { FLEETD_ENV: envFile(s.env) }, timeout: 30 },
          signal: s.signal,
        });
        if (w.body?.exitCode !== 0) throw new ProviderError("failed", `Daytona couldn't write the command's environment in the box (exit ${w.body?.exitCode ?? "?"})`);
      }
      const session = `fleetd-${crypto.randomUUID()}`;
      await http.call("POST", "/process/session", { base: tb, headers: bearer, body: { sessionId: session }, signal: s.signal });
      await http.call("POST", `/process/session/${session}/exec`, {
        base: tb,
          headers: bearer,
        body: { command: launcher(s.argv, { envAt, cwd: s.cwd, log: LOG }), runAsync: true },
        signal: s.signal,
      });
    },

    async connect(id, port, secret, c = {}) {
      let p = previews.get(`${id}:${port}`);
      if (!p) {
        const a = await http.call("GET", `${box(id)}/ports/${port}/preview-url`, { signal: c.signal });
        p = { url: String(a.body?.url ?? ""), token: String(a.body?.token ?? "") };
        if (!p.url) throw new ProviderError("failed", `Daytona gave no URL for port ${port} of the box`);
        previews.set(`${id}:${port}`, p);
      }
      return dial({
        name: NAME,
        url: p.url,
        headers: { "x-daytona-preview-token": p.token, [SECRET_HEADER]: secret },
        secrets: [p.token, secret],
        signal: c.signal,
        WebSocket: o.WebSocket,
      });
    },

    async read(id, path, max, r = {}) {
      const tb = toolbox.get(id) ?? (await started(id, r.signal));
      const a = await http.call("GET", "/files/download", { base: tb, headers: bearer, query: { path }, raw: true, ok: [404], signal: r.signal });
      if (a.status === 404) throw new ProviderError("failed", `the box has no file ${path}`, 404);
      const chunks: Uint8Array[] = [];
      let n = 0;
      for await (const chunk of a.res.body!) {
        chunks.push(chunk);
        n += chunk.length;
        if (n > max) {
          await a.res.body!.cancel().catch(() => {});
          throw new ProviderError("failed", `${path} in the box is larger than ${max} bytes`);
        }
      }
      return new Uint8Array(Buffer.concat(chunks));
    },

    async lifetime(id, ms, l = {}) {
      await http.call("POST", `${box(id)}/ttl/${minutes(ms)}`, { signal: l.signal });
    },

    async build(dockerfile: string, b: BuildOptions) {
      parse(dockerfile);
      const size = b.size ?? DEFAULT_SIZE;
      const not = notOffered("daytona", size, NAME);
      if (not) throw new ProviderError("failed", not);
      const made = await http.call("POST", "/snapshots", {
        body: { name: b.name, buildInfo: { dockerfileContent: dockerfile }, cpu: size.cpu, memory: size.memGb, disk: MAX.diskGb },
        signal: b.signal,
      });
      const id = String(made.body?.id ?? b.name);
      for (;;) {
        const g = await http.call("GET", `/snapshots/${encodeURIComponent(id)}`, { signal: b.signal });
        const state = String(g.body?.state ?? "");
        b.onLog?.(`snapshot ${b.name}: ${state}`);
        if (state === "active") return b.name;
        if (state === "error" || state === "build_failed") throw new ProviderError("failed", `Daytona couldn't build the snapshot ${b.name}${g.body?.errorReason ? `: ${g.body.errorReason}` : ""}`);
        await pause(pollMs, b.signal);
      }
    },
  };
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/** Daytona's refusals in its own words (quotas, the organization's state), which come as 400 or 403. */
function refine(a: Answer, words: string): { reason: "billing" | "limit"; message: string } | undefined {
  if (a.status !== 400 && a.status !== 403 && a.status !== 429) return undefined;
  if (a.status === 429 || /quota|limit (?:is )?(?:exceeded|reached)|exceeds? .*limit|too many/i.test(words)) {
    return { reason: "limit", message: `Daytona's limit for this organization is reached (${words}).` };
  }
  if (/suspend|credit|billing|payment|balance|wallet/i.test(words)) {
    return { reason: "billing", message: `Daytona won't run sandboxes for this organization until its billing is sorted out (${words}).` };
  }
  return undefined;
}
