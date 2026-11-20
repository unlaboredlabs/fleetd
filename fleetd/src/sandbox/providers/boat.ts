// boat.dev: plain HTTP against its public API (docs.boat.dev/api/v1, the OpenAPI file docs.boat.dev/openapi/boat-v1.yaml),
// the key as a bearer token.
//
// - A box is made with none of the account's own secrets (`noEnv`), never snapshotted (`snapshots: false`: a stop,
//   boat's auto-stop included, erases its disk instead of keeping it), and without boat's command and output history
//   (`monitoring: false`). Its life is boat's auto-stop deadline (`ttlSeconds`), extended with a PATCH.
// - boat's commands take no stdin and no environment of their own, and boat keeps a command's text: so a start writes
//   the environment to a private file first, and the detached command reads and removes it (shell.ts).
// - The guest's port is reached through boat's token-gated URL for it (`POST /host`, which answers the same URL again),
//   with fleetd's own secret besides.
// - A bot's computer image (`snapshot`) is a saved snapshot of a box that ran its setup; `forget` deletes it.
// - boat builds no images: `build` replays the recipe's steps as root on a fresh box from boat's own Ubuntu 24.04
//   image, saves it as a saved snapshot, and deletes the box. That image comes with apt sources of its own besides
//   Ubuntu's (the ondrej/php PPA), which the recipe doesn't use and which can break `apt-get update` from outside
//   (a changed release info, an unreachable host): the build drops them first (`APT_OWN`).
import { badKey, type Box, type BuildOptions, type ClientOptions, type CreateOptions, DEFAULT_SIZE, LABEL, labelsFor, type Provider, notOffered, type ProviderAuth, sameSize, SECRET_HEADER, type Size, type StartOptions } from "./common.ts";
import { type Answer, Http, pause, ProviderError } from "./http.ts";
import { parse } from "./recipe.ts";
import { envFile, envPath, launcher, shq } from "./shell.ts";
import { dial } from "./stream.ts";

/** Its name in every message: NAMES.boat (shared/sandbox.ts). */
const NAME = "boat.dev";
export const API = "https://boat.dev/api/v1";
/** Where a detached command's output goes in the box. */
const LOG = "/tmp/.fleetd-start.log";
/** boat's sizes, smallest first (docs.boat.dev/machines). */
export const TYPES: readonly { type: string; cpu: number; memGb: number }[] = [
  { type: "small", cpu: 2, memGb: 4 },
  { type: "default", cpu: 4, memGb: 8 },
  { type: "large", cpu: 8, memGb: 16 },
  { type: "xlarge", cpu: 16, memGb: 32 },
];
/** States in which a box takes commands. */
const READY = new Set(["ready", "idle", "running"]);
/** The longest a build's box may take to come up. */
const BUILD_UP_MS = 10 * 60_000;
/** The longest one step of a template build may run, and a snapshot may take to save: past it, boat is taken as not
 * answering (`unreachable`), so a hung step or a save stuck in "saving" fails every start waiting on it, with why. */
export const STEP_MS = 15 * 60_000;
export const SAVE_MS = 20 * 60_000;
/** A template build's first step: only Ubuntu's own apt sources stay (noble's ubuntu.sources), and a change of their
 * release info (an Ubuntu point release) is taken rather than failing `apt-get update`. */
export const APT_OWN = `for f in /etc/apt/sources.list.d/*; do [ -e "$f" ] || continue; [ "\${f##*/}" = ubuntu.sources ] || rm -rf -- "$f"; done
mkdir -p /etc/apt/apt.conf.d && printf 'Acquire::AllowReleaseInfoChange "true";\\n' > /etc/apt/apt.conf.d/99fleetd-release-info`;

/** The boat type of exactly `size`; a size boat has no type of is refused, never rounded up to a larger one. */
export function typeFor(size: Size): string {
  const t = TYPES.find((t) => sameSize(t, size));
  if (!t) throw new ProviderError("failed", notOffered("boat", size, "boat.dev")!);
  return t.type;
}

export function boat(auth: ProviderAuth, o: ClientOptions = {}): Provider {
  const http = new Http({ name: NAME, base: o.urls?.api ?? API, headers: { Authorization: `Bearer ${auth.key}` }, key: auth.key, fetch: o.fetch, signal: o.signal, refine });
  const pollMs = o.pollMs ?? 2000;
  const now = o.now ?? Date.now;
  /** Each box's port URLs, token included: boat answers the same one again, so this only saves a call. */
  const hosted = new Map<string, string>();
  const box = (id: string) => `/sandboxes/${encodeURIComponent(id)}`;

  /** A call to the box's machine, tried again while the box is still starting or restoring (boat says when it may be). */
  async function onBox(method: string, path: string, c: Parameters<Http["call"]>[2] = {}): Promise<Answer> {
    for (let tries = 0; ; tries++) {
      try {
        return await http.call(method, path, c);
      } catch (e) {
        const again = e instanceof ProviderError && (e.code === "sandbox_starting" || e.code === "boat_starting" || (e.status === 502 && /sandbox_restoring/.test(e.message)));
        if (!again || tries >= 10) throw e;
        await pause(pollMs, c.signal);
      }
    }
  }

  async function create(body: Record<string, unknown>, key: string, signal?: AbortSignal): Promise<any> {
    for (let tries = 0; ; tries++) {
      try {
        return (await http.call("POST", "/sandboxes", { body, headers: { "Idempotency-Key": key }, signal })).body.sandbox;
      } catch (e) {
        if (e instanceof ProviderError && e.code === "idempotency_in_progress" && tries < 10) {
          await pause(pollMs, signal);
          continue;
        }
        throw e;
      }
    }
  }

  async function destroy(id: string, signal?: AbortSignal) {
    await http.call("DELETE", box(id), { headers: { "X-Ascii-Confirm-Delete": id }, ok: [404], signal });
    for (const k of hosted.keys()) if (k.startsWith(`${id}:`)) hosted.delete(k);
  }

  /** Runs `command` detached; with `wait`, until it ends (at most STEP_MS), failing on a non-zero exit. */
  async function run(id: string, command: string, wait: boolean, signal?: AbortSignal): Promise<void> {
    const started = await onBox("POST", `${box(id)}/commands`, { body: { command, detached: true }, signal });
    if (!wait) return;
    const pid = started.body?.processId;
    const until = now() + STEP_MS;
    for (;;) {
      if (now() > until) throw new ProviderError("unreachable", `a step of boat.dev's sandbox build didn't finish within ${STEP_MS / 60_000} minutes`);
      await pause(pollMs, signal);
      const st = await http.call("GET", `${box(id)}/commands/${pid}`, { query: { tailBytes: "2000" }, signal });
      if (st.body?.running) continue;
      if (st.body?.exitCode === 0) return;
      const tail = String(st.body?.stderr || st.body?.stdout || "").trim().split("\n").slice(-3).join(" / ");
      throw new ProviderError("failed", `a step failed in boat.dev's build box (exit ${st.body?.exitCode ?? st.body?.status}): ${tail.slice(0, 300)}`);
    }
  }

  /** Saves box `id` as the snapshot `name`, waiting until boat says it is ready (at most SAVE_MS). A save of that name
   * already under way (another machine's build of the same recipe) is waited for instead, never saved over. */
  async function save(id: string, name: string, signal?: AbortSignal): Promise<string> {
    try {
      await http.call("POST", "/saved-snapshots", { body: { sandboxId: id, name }, signal });
    } catch (e) {
      if (!(e instanceof ProviderError && e.code === "save_in_progress")) throw e;
    }
    return settle(name, signal);
  }

  /** Waits until the save of `name` is ready (at most SAVE_MS), failing as boat says it failed. */
  async function settle(name: string, signal?: AbortSignal): Promise<string> {
    const until = now() + SAVE_MS;
    for (;;) {
      const g = await http.call("GET", `/saved-snapshots/${encodeURIComponent(name)}`, { signal });
      const status = g.body?.snapshot?.status;
      if (status === "ready") return name;
      if (status === "failed") throw new ProviderError("failed", `boat.dev couldn't save the snapshot ${name} (${g.body?.snapshot?.error ?? "no reason given"})`);
      if (now() > until) throw new ProviderError("unreachable", `boat.dev didn't finish saving a sandbox within ${SAVE_MS / 60_000} minutes`);
      await pause(pollMs, signal);
    }
  }

  return {
    id: "boat",

    async create(c: CreateOptions): Promise<Box> {
      const bad = badKey(c.key);
      if (bad) throw new ProviderError("failed", bad);
      const labels = labelsFor(c);
      const s = await create(
        {
          from: c.template,
          type: typeFor(c.size ?? DEFAULT_SIZE),
          ttlSeconds: seconds(c.lifetimeMs),
          labels,
          name: `fleetd ${c.key}`,
          noEnv: true,
          // An image build's box is saved (`snapshot`) once it ran setup; no other box ever is.
          ...(c.keep ? {} : { snapshots: false }),
          monitoring: false,
        },
        c.key,
        c.signal,
      );
      return { id: String(s.id), labels };
    },

    destroy: (id, d = {}) => destroy(id, d.signal),

    async list(l = {}) {
      const out: Box[] = [];
      let cursor: string | undefined;
      do {
        const a = await http.call("GET", "/sandboxes", { query: { label: `${LABEL}=1`, limit: "200", cursor }, signal: l.signal });
        for (const s of (a.body?.sandboxes ?? []) as any[]) {
          if (s.state === "cancelled") continue;
          out.push({ id: String(s.id), labels: { ...(s.labels ?? {}) } });
        }
        cursor = a.body?.pageInfo?.hasMore ? (a.body.pageInfo.nextCursor ?? undefined) : undefined;
      } while (cursor);
      return out.filter((b) => b.labels[LABEL] === "1");
    },

    async start(id: string, s: StartOptions) {
      if (s.argv.length === 0) throw new ProviderError("failed", "nothing to start: the command is empty");
      let envAt: string | undefined;
      if (Object.keys(s.env).length > 0) {
        envAt = envPath();
        await onBox("PUT", `${box(id)}/files`, { body: { path: envAt, content: envFile(s.env) }, signal: s.signal });
      }
      await run(id, launcher(s.argv, { envAt, cwd: s.cwd, log: LOG }), false, s.signal);
    },

    async connect(id, port, secret, c = {}) {
      let url = hosted.get(`${id}:${port}`);
      if (!url) {
        const a = await onBox("POST", `${box(id)}/host`, { body: { port }, signal: c.signal });
        url = String(a.body?.url ?? "");
        if (!url) throw new ProviderError("failed", `boat.dev gave no address for port ${port} of the box`);
        hosted.set(`${id}:${port}`, url);
      }
      const token = new URL(url).searchParams.get("_token") ?? "";
      return dial({ name: NAME, url, headers: { [SECRET_HEADER]: secret }, secrets: [token, secret], signal: c.signal, WebSocket: o.WebSocket });
    },

    async read(id, path, max, r = {}) {
      let a: Answer;
      try {
        a = await onBox("GET", `${box(id)}/files`, { query: { path, encoding: "base64" }, signal: r.signal });
      } catch (e) {
        if (e instanceof ProviderError && e.status === 413) throw new ProviderError("failed", `${path} in the box is larger than boat.dev reads (5 MiB)`, 413);
        if (e instanceof ProviderError && e.status === 404) throw new ProviderError("failed", `the box has no file ${path}`, 404);
        throw e;
      }
      const bytes = Buffer.from(String(a.body?.content ?? ""), "base64");
      if (bytes.length > max) throw new ProviderError("failed", `${path} in the box is larger than ${max} bytes`);
      return new Uint8Array(bytes);
    },

    async lifetime(id, ms, l = {}) {
      await http.call("PATCH", box(id), { body: { ttlSeconds: seconds(ms) }, signal: l.signal });
    },

    snapshot: (id, name, s = {}) => save(id, name, s.signal),

    async forget(template, f = {}) {
      await http.call("DELETE", `/saved-snapshots/${encodeURIComponent(template)}`, { ok: [404], signal: f.signal });
    },

    async saved(prefix, o = {}) {
      const a = await http.call("GET", "/saved-snapshots", { query: { namePrefix: prefix }, signal: o.signal });
      return ((a.body?.snapshots ?? []) as any[]).map((s) => ({ name: String(s.name), status: s.status, at: String(s.createdAt ?? "") }));
    },

    settled: (name, o = {}) => settle(name, o.signal),

    async build(dockerfile: string, b: BuildOptions) {
      const r = parse(dockerfile);
      b.onLog?.(`boat builds no images: the recipe's steps run on boat's own Ubuntu 24.04 image, not ${r.from}`);
      // One key per build: boat keeps a key 24 hours and answers its box again, so a key reused after a failed build
      // would answer the box that build already deleted. Retries inside this call share it, and make no second box.
      const key = `build-${crypto.randomUUID().slice(0, 8)}-${b.name}`.slice(0, 63).replace(/-+$/, "");
      const s = await create(
        { type: typeFor(b.size ?? DEFAULT_SIZE), ttlSeconds: 2 * 3600, labels: { ...b.labels, [LABEL]: "1", "fleetd-build": b.name }, name: `fleetd build ${b.name}`, noEnv: true },
        key,
        b.signal,
      );
      const id = String(s.id);
      b.onBox?.(id);
      try {
        const until = now() + BUILD_UP_MS;
        for (;;) {
          const g = await http.call("GET", box(id), { signal: b.signal });
          const state = String(g.body?.sandbox?.state ?? "");
          if (READY.has(state)) break;
          if (state === "error" || state === "cancelled") throw new ProviderError("failed", `boat.dev's build box didn't start (${g.body?.sandbox?.error ?? state})`);
          if (now() > until) throw new ProviderError("failed", "boat.dev's build box didn't start within 10 minutes");
          await pause(pollMs, b.signal);
        }
        b.onLog?.("dropping the apt sources boat's image adds besides Ubuntu's own");
        await run(id, `sudo bash -c ${shq(`set -e; ${APT_OWN}`)}`, true, b.signal);
        const env: [string, string][] = [];
        let cwd = "/";
        let user = "root";
        for (const step of r.steps) {
          if (step.op === "ENV") for (let i = 0; i + 1 < step.args.length; i += 2) env.push([step.args[i]!, step.args[i + 1]!]);
          else if (step.op === "WORKDIR") cwd = step.args[0]!;
          else if (step.op === "USER") user = step.args[0]!;
          else {
            b.onLog?.(`RUN ${step.args[0]!.slice(0, 120)}`);
            const exports = env.map(([k, v]) => `export ${k}=${shq(v)}; `).join("");
            const script = `${exports}mkdir -p ${shq(cwd)} && cd ${shq(cwd)} && ${step.args[0]}`;
            await run(id, `sudo -H -u ${shq(user)} bash -c ${shq(`set -e; ${script}`)}`, true, b.signal);
          }
        }
        if (env.length > 0) {
          const lines = env.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n");
          await run(id, `sudo bash -c ${shq(`printf '%s\\n' ${shq(lines)} >> /etc/environment`)}`, true, b.signal);
        }
        return await save(id, b.name, b.signal);
      } finally {
        await destroy(id).catch(() => {});
      }
    },
  };
}

const seconds = (ms: number) => Math.min(2_592_000, Math.max(1, Math.ceil(ms / 1000)));

/** boat's own error codes (docs.boat.dev/api/v1, "Error model" and "Limits and retries"). */
function refine(a: Answer, words: string): { reason: "billing" | "limit" | "rate" | "failed"; message: string } | undefined {
  const code = String(a.body?.code ?? a.body?.error?.code ?? "");
  switch (code) {
    case "billing_required":
    case "credit_required":
      return { reason: "billing", message: `boat.dev won't start sandboxes on this account until its billing is sorted out (${words}).` };
    case "team_member_cap_reached":
    case "member_limit_reached":
      return { reason: "limit", message: `boat.dev's organization owner has capped this member's use (${words}).` };
    case "org_suspended":
      return { reason: "billing", message: `boat.dev has suspended the organization's wallet (${words}).` };
    case "trial_machine_class_not_allowed":
    case "machine_class_plan_required":
      return { reason: "billing", message: `boat.dev's plan for this account doesn't include that sandbox size (${words}).` };
    case "trial_compute_limit_reached":
      return { reason: "billing", message: `boat.dev's free trial hours are used up (${words}).` };
    case "rate_limited": {
      // It names the window whose starts are used up (docs.boat.dev/limits): a minute's free by themselves within one,
      // so asked again then (`rate`); an hour's or a day's don't, and a retry each minute wouldn't help: the plan's
      // limit, with its wait.
      const b = a.body;
      const window = String(b?.window ?? b?.error?.window ?? b?.details?.window ?? b?.error?.details?.window ?? "");
      if (window === "minute") return { reason: "rate", message: `boat.dev's limit on sandbox starts a minute is reached for now (${words}).` };
      return { reason: "limit", message: `boat.dev's limit on sandbox starts${window ? ` a${window === "hour" ? "n" : ""} ${window}` : ""} is reached (${words}).` };
    }
    case "limit_reached":
      return { reason: "limit", message: `boat.dev's limit on sandboxes at once is reached (${words}).` };
    case "snapshot_not_found":
      return { reason: "failed", message: `boat.dev has no saved snapshot by that name (${words}): build it first.` };
  }
  return undefined;
}
