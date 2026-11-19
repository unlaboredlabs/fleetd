// The node's hosted boxes: the team's provider keys as the hub sealed them to this node, each provider's client, its
// template (built in the team's own account by itself on first use), and a box's whole life: created from the
// template with labels and a lifetime and no secret, its bootstrap started with the box's own secret, fleetd handed
// to it, and the guest's link opened (../box.ts). One box per agent; the node that made it destroys it, and reaps any
// box of its own it no longer knows (`reap`).
//
// The keys never reach a box or a session: they stay in this process, and on disk only as the hub sealed them to this
// node's box key (`<home>/sandbox/keys/<provider>`), so a node that restarts re-adopts its boxes before its hub link
// is up.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { DEFAULT_SIZE, GUEST_PORT, provider as makeProvider, notOffered, type ClientOptions, type Provider, type ProviderAuth, ProviderError, type ProviderId, PROVIDERS, type Reason, sameSize, type Size } from "../../../sandbox/providers/index.ts";
import { hosted as hostedRecipe, templateName } from "../../../sandbox/providers/recipe.ts";
import base from "../../../sandbox/image/Dockerfile" with { type: "text" };
import { TESTED } from "../../runner/claude.ts";
import { selfArgv, nowIso } from "../../util.ts";
import { baseUrl, channelOf, cliAsset, fileSha256Hex, pinnedName } from "../../../update/index.ts";
import { VERSION } from "../../../shared/version.ts";
import { NAMES } from "../../../shared/sandbox.ts";
import type { SandboxTrouble } from "../../../shared/node_link.ts";
import { leadSocketPath, type LeadSocketHooks } from "../../lead/index.ts";
import { Box, type Relay } from "../box.ts";
import { nodeTailnet } from "../tailnet.ts";
import { bootArgv, deliver, firstWord, type Source } from "./bootstrap.ts";

/** Labels on every box: the machine that made it, and the session it runs. */
export const MACHINE_LABEL = "fleetd-machine";
export const SESSION_LABEL = "fleetd-session";
/** How long a box lives unless extended; a live box is extended every EXTEND_MS. A box its node lost goes within it. */
export const LIFETIME_MS = 3600_000;
export const EXTEND_MS = 20 * 60_000;
/** How long a provider that failed to make a box is left out of placement. */
export const DOWN_MS = 10 * 60_000;
/** How long a box's bootstrap or guest may take to answer its first dial. */
const UP_MS = 90_000;

type Opener = { open(sealed: Uint8Array): Uint8Array | null };

/** What the node gives every box's link: how node.sock calls are answered. */
export type Wiring = { lead: LeadSocketHooks };

/** A box as the node keeps it: in `<hostDir>/place.json` (the hosted place). `relays`: a box made before its Claude
 * endpoint stopped being relayed (W722) has its claude pointed at one; it keeps it until the box goes. No new box gets
 * one. */
export type BoxRecord = { kind: "hosted"; provider: ProviderId; boxId: string; secret: string; tcp: number[]; relays?: Relay[] };

export class Boxes {
  #auth = new Map<ProviderId, ProviderAuth>();
  #clients = new Map<ProviderId, Provider>();
  #templates = new Map<string, Promise<string>>();
  #wiring: Wiring | undefined;
  #reaper: ReturnType<typeof setInterval> | undefined;
  /** Providers that failed to make a box lately (a refused key, a limit, billing, an outage): until when, and why. */
  #down = new Map<ProviderId, { until: number; why: string; reason: Reason }>();
  /** Providers whose live boxes couldn't be extended at the last try (`keptAlive`), and why. */
  #unkept = new Map<ProviderId, { why: string; reason: Reason }>();
  /** Boxes being made: their record isn't written yet, and the reaper leaves them. */
  #making = new Set<string>();
  /** Boxes no session's record holds that are still in use: a bot's image build's (../../place/hosted.ts). */
  #held = new Set<string>();

  constructor(
    readonly home: string,
    readonly machineId: string,
    private readonly opener: Opener,
    /** Tests: another provider than the real clients, another fleetd source, and how long a new box is left alone. */
    readonly o: { provider?: (id: ProviderId, auth: ProviderAuth, c?: ClientOptions) => Provider; source?: () => Source; dial?: (b: BoxRecord) => Promise<Duplex>; makingMs?: number } = {},
  ) {
    for (const p of PROVIDERS) {
      const sealed = this.#keyFile(p);
      if (existsSync(sealed)) this.#take(p, readFileSync(sealed));
    }
  }

  wire(w: Wiring): void {
    this.#wiring = w;
  }

  #keyFile = (p: ProviderId) => join(this.home, "sandbox", "keys", p);

  /** Opens a key the hub sealed to this node: `{"provider","key","domain"?}`. */
  #take(p: ProviderId, sealed: Uint8Array): boolean {
    const plain = this.opener.open(new Uint8Array(sealed));
    if (!plain) return false;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(plain)) as { provider?: unknown; key?: unknown; domain?: unknown };
      if (parsed.provider !== p || typeof parsed.key !== "string" || !parsed.key) return false;
      this.#auth.set(p, { key: parsed.key, ...(typeof parsed.domain === "string" && parsed.domain ? { domain: parsed.domain } : {}) });
      this.#clients.delete(p);
      return true;
    } catch {
      return false;
    } finally {
      plain.fill(0);
    }
  }

  /** The team's keys as the hub sent them last (sealed to this node, base64), by provider: one not sent is forgotten. */
  setKeys(sealed: Partial<Record<string, string>>): void {
    mkdirSync(join(this.home, "sandbox", "keys"), { recursive: true, mode: 0o700 });
    for (const p of PROVIDERS) {
      const b64 = sealed[p];
      const bytes = b64 ? new Uint8Array(Buffer.from(b64, "base64")) : undefined;
      if (bytes && this.#take(p, bytes)) writeFileSync(this.#keyFile(p), bytes, { mode: 0o600 });
      else if (!b64) {
        this.#auth.delete(p);
        this.#clients.delete(p);
        for (const k of [...this.#templates.keys()]) if (k === p || k.startsWith(`${p}-`)) this.#templates.delete(k);
        rmSync(this.#keyFile(p), { force: true });
      }
    }
  }

  /** The providers this node holds a key for. */
  connected(): ProviderId[] {
    return PROVIDERS.filter((p) => this.#auth.has(p));
  }

  /** Those it can make boxes in now: not set aside after a failure (`setAside`). */
  usable(now = Date.now()): ProviderId[] {
    return this.connected().filter((p) => (this.#down.get(p)?.until ?? 0) <= now);
  }

  /** Why `p` is set aside now, or undefined. */
  aside(p: ProviderId, now = Date.now()): string | undefined {
    const d = this.#down.get(p);
    return d && d.until > now ? d.why : undefined;
  }

  /** A provider that couldn't make a box is offered to the hub's placement no more for DOWN_MS: the agents it would
   * take run here or wait in line, rather than fail on it again. */
  setAside(p: ProviderId, why: string, now = Date.now(), reason: Reason = "failed"): void {
    this.#down.set(p, { until: now + DOWN_MS, why, reason });
    console.warn(`${nowIso()} WARN a hosted provider is set aside for ${DOWN_MS / 60_000} minutes {"provider":"${p}","why":${JSON.stringify(why)}}`);
  }

  /** Every provider set aside is offered again at once: the hub's fresh word (a key that works again, a change). */
  retry(): void {
    this.#down.clear();
  }

  /** A keep-alive of `p`'s box: failed (`error`), or worked, which clears the last failure. */
  keptAlive(p: ProviderId, error?: unknown): void {
    if (error === undefined) {
      this.#unkept.delete(p);
      return;
    }
    const reason: Reason = error instanceof ProviderError ? error.reason : "unreachable";
    this.#unkept.set(p, { why: error instanceof Error ? error.message : String(error), reason });
  }

  /** What the heartbeat says is wrong with each provider now (`load.sandboxTrouble`): set aside after a refusal or a
   * box that didn't come up, until when; or its boxes not kept alive. Only connected providers; empty when all is well. */
  trouble(now = Date.now()): SandboxTrouble[] {
    return this.connected().flatMap((p): SandboxTrouble[] => {
      const d = this.#down.get(p);
      if (d && d.until > now) return [{ provider: p, what: "start", reason: d.reason, why: d.why, until: d.until }];
      const k = this.#unkept.get(p);
      return k ? [{ provider: p, what: "keep_alive", reason: k.reason, why: k.why }] : [];
    });
  }

  client(p: ProviderId): Provider {
    const auth = this.#auth.get(p);
    if (!auth) throw new ProviderError("invalid_key", `This machine holds no ${p} key: an admin connects one in Settings › Hub › Machines.`);
    let c = this.#clients.get(p);
    if (!c) {
      c = (this.o.provider ?? makeProvider)(p, auth);
      this.#clients.set(p, c);
    }
    return c;
  }

  /** The name of the template boxes start from, for this recipe: what a bot's computer image builds on. */
  templateName(): string {
    return templateName(hostedRecipe(base, { claude: TESTED }));
  }

  /** The template boxes start from: built in the team's account once per recipe, by itself, the first time it's
   * needed. boat sizes a box at create, so one serves every size; a provider that fixed a box's size in its template
   * would build one per size (`<name>-<cpu>c<mem>g`). */
  template(p: ProviderId, size: Size = DEFAULT_SIZE): Promise<string> {
    const recipe = hostedRecipe(base, { claude: TESTED });
    const sized = (p as string) !== "boat" && !sameSize(size, DEFAULT_SIZE) ? `-${size.cpu}c${size.memGb}g` : "";
    const name = `${this.templateName()}${sized}`;
    const file = join(this.home, "sandbox", `template-${p}${sized}.json`);
    const key = `${p}${sized}`;
    let kept: { name?: string; id?: string } = {};
    try {
      kept = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    if (kept.name === name && kept.id) return Promise.resolve(kept.id);
    let building = this.#templates.get(key);
    if (!building) {
      console.log(`${nowIso()} INFO building the hosted sandbox template {"provider":"${p}","name":"${name}"}`);
      building = this.client(p)
        .build(recipe, { name, size, onLog: () => {} })
        .then((id) => {
          mkdirSync(join(this.home, "sandbox"), { recursive: true, mode: 0o700 });
          writeFileSync(file, JSON.stringify({ name, id }));
          console.log(`${nowIso()} INFO the hosted sandbox template is built {"provider":"${p}","name":"${name}"}`);
          return id;
        });
      building.catch(() => this.#templates.delete(key));
      this.#templates.set(key, building);
    }
    return building;
  }

  /** Where this node's fleetd comes from for a box: its own binary, and its release asset where it has one. */
  source(): Source {
    if (this.o.source) return this.o.source();
    if (!hostable()) throw new Error(NOT_X64);
    const argv = selfArgv();
    if (argv.length !== 1) throw new ProviderError("failed", "Hosted sandboxes take fleetd's built binary, and this machine runs fleetd from its source.");
    const exe = argv[0]!;
    const sha256 = fileSha256Hex(exe);
    let url: string | undefined;
    try {
      url = `${baseUrl(channelOf(VERSION, true))}/${pinnedName(cliAsset(), sha256)}`;
    } catch {}
    return { sha256, ...(url ? { url } : {}), bytes: async () => new Uint8Array(await Bun.file(exe).arrayBuffer()) };
  }

  /** Creates a box for `session` from the provider's template (or `o.template`: a bot's computer image), starts its
   * bootstrap and hands it fleetd. `o.keep`: an image build's box, which the provider may save. */
  async create(p: ProviderId, session: string, tcp: number[], dirs: string[] = [], size?: Size, o: { template?: string; keep?: boolean } = {}): Promise<BoxRecord> {
    const client = this.client(p);
    // A size the provider has no exact box of is refused here, before any box or template is made.
    const not = size ? notOffered(p, size, NAMES[p]) : undefined;
    if (not) throw new ProviderError("failed", not);
    const template = o.template ?? (await this.template(p, size));
    // A key per attempt, never the session's: boat keeps a key a day after its box is gone, and a session's next
    // box must be a new one.
    const key = `fleetd-${randomBytes(12).toString("hex")}`;
    const made = await client.create({ template, key, labels: { [MACHINE_LABEL]: label(this.machineId), [SESSION_LABEL]: label(session) }, lifetimeMs: LIFETIME_MS, ...(size ? { size } : {}), ...(o.keep ? { keep: true } : {}) });
    const record: BoxRecord = { kind: "hosted", provider: p, boxId: made.id, secret: randomBytes(24).toString("base64url"), tcp };
    this.#making.add(made.id);
    // Its caller writes the record at once; until a while after, the reaper leaves the box.
    const made_ = () => setTimeout(() => this.#making.delete(made.id), this.o.makingMs ?? 60_000).unref?.();
    try {
      const boot = bootArgv(dirs);
      await client.start(made.id, { argv: boot.argv, env: { ...boot.env, FLEETD_BOX_SECRET: record.secret } });
      // Until fleetd's guest answers: a provider's proxy may take the link before the bootstrap listens.
      const deadline = Date.now() + UP_MS;
      for (let wait = 250; ; wait = Math.min(wait * 2, 3000)) {
        const link = await this.#dialUp(record);
        let word: Awaited<ReturnType<typeof firstWord>>;
        try {
          word = await firstWord(link);
          if (word === "bootstrap") await deliver(link, this.source());
        } finally {
          link.close();
        }
        // The bootstrap, once it took fleetd, makes way for the guest: dialled again until the guest itself answers.
        if (word === "guest") break;
        if (Date.now() + wait >= deadline) throw new ProviderError("unreachable", `fleetd's guest didn't answer in the box within ${UP_MS / 1000} s`);
        await Bun.sleep(word === "bootstrap" ? 300 : wait);
      }
      return record;
    } catch (error) {
      await client.destroy(made.id).catch(() => {});
      throw error;
    } finally {
      made_();
    }
  }

  /** The box's port, dialled until something there answers. */
  async #dialUp(b: BoxRecord) {
    const deadline = Date.now() + UP_MS;
    for (let wait = 250; ; wait = Math.min(wait * 2, 3000)) {
      try {
        return await this.client(b.provider).connect(b.boxId, GUEST_PORT, b.secret);
      } catch (error) {
        if (Date.now() + wait >= deadline) throw error;
        await Bun.sleep(wait);
      }
    }
  }

  /** A new byte stream to the box's guest. */
  async dial(b: BoxRecord): Promise<Duplex> {
    if (this.o.dial) return this.o.dial(b);
    const web = await this.#dialUp(b);
    // Node's own, which Bun has; its types here don't name it.
    const fromWeb = (Duplex as unknown as { fromWeb(p: { readable: ReadableStream; writable: WritableStream }): Duplex }).fromWeb;
    return fromWeb({ readable: web.readable, writable: web.writable });
  }

  /** The node's link to the guest in the box, for `session`. Its node.sock calls are answered by the node's hooks as
   * they are when a call comes: a node re-adopts its boxes before its node.sock serves. */
  open(b: BoxRecord, session: string): Promise<Box> {
    const lead = new Proxy({} as LeadSocketHooks, {
      get: (_t, k) => {
        const hooks = this.#wiring?.lead;
        if (!hooks) throw new Error("the node's node.sock isn't serving yet");
        return hooks[k as keyof LeadSocketHooks];
      },
    });
    // The team's tailnet, as the node has it when a connection or lookup comes (./tailnet.ts).
    const tailnet = {
      dial: (host: string, port: number) => {
        const t = nodeTailnet();
        return t ? t.dial(host, port) : Promise.reject(new Error("this machine reaches no tailnet"));
      },
      dns: (name: string, type: number) => {
        const t = nodeTailnet();
        return t ? t.dns(name, type) : Promise.reject(new Error("this machine reaches no tailnet"));
      },
    };
    return Box.open({ session, dial: () => this.dial(b), nodeSock: leadSocketPath(this.home), tcp: b.tcp, ...(b.relays?.length ? { relays: b.relays } : {}), lead, tailnet, goneMs: 120_000 });
  }

  /** Deletes the box; one already gone is no error. */
  async destroy(b: Pick<BoxRecord, "provider" | "boxId">): Promise<void> {
    await this.client(b.provider).destroy(b.boxId);
  }

  /** Sets the box's life to LIFETIME_MS from now. */
  extend(b: BoxRecord): Promise<void> {
    return this.client(b.provider).lifetime(b.boxId, LIFETIME_MS);
  }

  /** Deletes this machine's boxes in every connected account that no session of `known()` holds. How many it deleted. */
  /** Keeps the box `id` from the sweep until the answer is called: one no session records, while it is in use. */
  hold(id: string): () => void {
    this.#held.add(id);
    return () => void this.#held.delete(id);
  }

  async reap(known: () => Set<string>): Promise<number> {
    let n = 0;
    for (const p of this.connected()) {
      let boxes;
      try {
        boxes = await this.client(p).list();
      } catch (error) {
        console.warn(`${nowIso()} WARN hosted boxes not swept {"provider":"${p}","error":${JSON.stringify((error as Error).message)}}`);
        continue;
      }
      const keep = known();
      for (const b of boxes) {
        if (b.labels[MACHINE_LABEL] !== label(this.machineId) || keep.has(b.id) || this.#making.has(b.id) || this.#held.has(b.id)) continue;
        try {
          await this.client(p).destroy(b.id);
          n++;
        } catch {}
      }
    }
    if (n) console.warn(`${nowIso()} WARN deleted hosted boxes no session of this machine holds {"deleted":${n}}`);
    return n;
  }

  /** Sweeps at once and every `everyMs`. */
  startReaper(known: () => Set<string>, everyMs = 10 * 60_000): void {
    void this.reap(known);
    this.#reaper = setInterval(() => void this.reap(known), everyMs);
    this.#reaper.unref?.();
  }

  stop(): void {
    if (this.#reaper) clearInterval(this.#reaper);
  }
}

/** Hosted boxes are x86_64 Linux, and each runs the node's own fleetd: only an x86_64 node can make them. */
export const hostable = (arch: string = process.arch) => arch === "x64";
export const NOT_X64 = `Hosted sandboxes run x86_64 Linux, and this machine's fleetd is built for ${process.arch}: run hosted agents from an x86_64 machine.`;

/** A label's value: lowercase letters, digits and hyphens, at most 63, as every provider takes. */
export const label = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 63);

let current: Boxes | undefined;

/** The node's Boxes, once its start made them (node/sandbox/hosted.ts); undefined off Linux. */
export const boxes = (): Boxes | undefined => current;
export const setBoxes = (b: Boxes | undefined) => void (current = b);

/** The box ids of every hosted session's record under `hosts` (`<hosts>/<session>/place.json`). */
export function knownBoxes(hosts: string): Set<string> {
  const out = new Set<string>();
  for (const name of existsSync(hosts) ? readdirSync(hosts) : []) {
    try {
      const r = JSON.parse(readFileSync(join(hosts, name, "place.json"), "utf8")) as BoxRecord;
      if (r.kind === "hosted" && r.boxId) out.add(r.boxId);
    } catch {}
  }
  return out;
}
