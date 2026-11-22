// The node's hosted boxes: the team's provider keys as the hub sealed them to this node, each provider's client, its
// template (built in the team's own account in the background when the keys come, and while it isn't there boxes
// start from the last good one: `template`), and a box's whole life: created from the
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
import { DEFAULT_SIZE, GUEST_PORT, provider as makeProvider, notOffered, type ClientOptions, type Provider, type ProviderAuth, ProviderError, type ProviderId, PROVIDERS, type Reason, sameSize, type Saved, type Size } from "../../../sandbox/providers/index.ts";
import { bakedName, hostedCheck, hostedDockerfile, templateName } from "../../../sandbox/providers/recipe.ts";
import { noQuery } from "../../../sandbox/providers/shell.ts";
import { Stages } from "../../../shared/stages.ts";
import { selfArgv, nowIso } from "../../util.ts";
import { baseUrl, channelOf, cliAsset, fileSha256Hex, pinnedName } from "../../../update/index.ts";
import { VERSION } from "../../../shared/version.ts";
import { ASIDE_MS, NAMES, RATE_MS } from "../../../shared/sandbox.ts";
import type { SandboxTrouble } from "../../../shared/node_link.ts";
import { leadChannel, leadSocketPath, type LeadSocketHooks } from "../../lead/index.ts";
import { Box, type Relay } from "../box.ts";
import { type HostedStep, stepped } from "../../place/hosted_steps.ts";
import { nodeTailnet } from "../tailnet.ts";
import { bootArgv, deliver, firstWord, type Source } from "./bootstrap.ts";

/** Labels on every box: the machine that made it, and the session it runs. */
export const MACHINE_LABEL = "fleetd-machine";
export const SESSION_LABEL = "fleetd-session";
/** How long a box lives unless extended; a live box is extended every EXTEND_MS. A box its node lost goes within it. */
export const LIFETIME_MS = 3600_000;
export const EXTEND_MS = 20 * 60_000;
/** How long a provider that failed to make a box is left out of placement. */
export const DOWN_MS = ASIDE_MS;
/** How long a box's bootstrap or guest may take to answer its first dial. */
const UP_MS = 90_000;
/** The longest wait between two dials of a box coming up: it answers within a second of being ready. */
const DIAL_MAX_MS = 1000;
/** How many of the account's templates are kept, newest first: this release's and the one before (`#prune`). */
export const KEEP_TEMPLATES = 2;
/** How long after the release asset's HEAD missed (not published yet, a network blip) a start asks again (`#probe`):
 * a release's asset is up within minutes of its tag, and a build of one's own, whose asks all miss, asks at most this
 * often, only when a box starts or the keys come. */
export const PROBE_AGAIN_MS = 10 * 60_000;

type Opener = { open(sealed: Uint8Array): Uint8Array | null };

/** A template's build on this machine (`Boxes.ahead`): `looked`, once the account's saved templates were read, this
 * recipe's own when it is ready there (`own`) and the newest ready one of another recipe (`older`, the last good);
 * `done`, the recipe's own once it is there; `failed`, set when it didn't build, until the next build ahead; `id`, set
 * once it is there. */
type Run = { name: string; looked: Promise<{ own?: string; older?: { id: string; at: string } }>; done: Promise<string>; failed?: boolean; id?: string };

/** What the node gives every box's link: how node.sock calls are answered. */
export type Wiring = { lead: LeadSocketHooks };

/** A box as the node keeps it: in `<hostDir>/place.json` (the hosted place). `relays`: a box made before its Claude
 * endpoint stopped being relayed (W722) has its claude pointed at one; it keeps it until the box goes. No new box gets
 * one. */
export type BoxRecord = { kind: "hosted"; provider: ProviderId; boxId: string; secret: string; tcp: number[]; relays?: Relay[] };

export class Boxes {
  #auth = new Map<ProviderId, ProviderAuth>();
  #clients = new Map<ProviderId, Provider>();
  #runs = new Map<string, Run>();
  #wiring: Wiring | undefined;
  #reaper: ReturnType<typeof setInterval> | undefined;
  /** Providers that failed to make a box lately (a refused key, a limit, billing, an outage): until when, and why. */
  #down = new Map<ProviderId, { until: number; why: string; reason: Reason }>();
  /** Providers whose live boxes couldn't be extended at the last try (`keptAlive`), and why; once none of their boxes
   * is left (`noneLive`), until when it is still said. */
  #unkept = new Map<ProviderId, { why: string; reason: Reason; until?: number }>();
  /** Boxes being made: their record isn't written yet, and the reaper leaves them. */
  #making = new Set<string>();
  /** Boxes no session's record holds that are still in use: a bot's image build's (../../place/hosted.ts). */
  #held = new Set<string>();
  /** The templates boxes of this node are being created from now, and how many: `#prune` never deletes one. */
  #starting = new Map<string, number>();

  constructor(
    readonly home: string,
    readonly machineId: string,
    private readonly opener: Opener,
    /** Tests: another provider than the real clients, another fleetd source, how long a new box is left alone, whether
     * a release asset is published, and the clock. */
    readonly o: { provider?: (id: ProviderId, auth: ProviderAuth, c?: ClientOptions) => Provider; source?: () => Source; dial?: (b: BoxRecord) => Promise<Duplex>; makingMs?: number; released?: (url: string) => Promise<boolean>; now?: () => number } = {},
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
    // A new key, or none: the last keep-alive's failure was the old key's.
    this.#unkept.clear();
    mkdirSync(join(this.home, "sandbox", "keys"), { recursive: true, mode: 0o700 });
    for (const p of PROVIDERS) {
      const b64 = sealed[p];
      const bytes = b64 ? new Uint8Array(Buffer.from(b64, "base64")) : undefined;
      if (bytes && this.#take(p, bytes)) writeFileSync(this.#keyFile(p), bytes, { mode: 0o600 });
      else if (!b64) {
        this.#auth.delete(p);
        this.#clients.delete(p);
        for (const k of [...this.#runs.keys()]) if (k === p || k.startsWith(`${p}-`)) this.#runs.delete(k);
        rmSync(this.#keyFile(p), { force: true });
      }
    }
    // The hub sends the keys at each link and when one is connected: the template is built then, in the background,
    // never at a person's message.
    void this.#probe().then(() => {
      for (const p of this.connected()) this.ahead(p);
    });
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
    // Its start rate frees by itself within a minute: asked again then, not in DOWN_MS.
    const ms = reason === "rate" ? RATE_MS : DOWN_MS;
    this.#down.set(p, { until: now + ms, why, reason });
    console.warn(`${nowIso()} WARN a hosted provider is set aside for ${ms / 60_000} minutes {"provider":"${p}","why":${JSON.stringify(why)}}`);
  }

  /** Every provider set aside is offered again at once: the hub's fresh word (a key that works again, a change). */
  retry(): void {
    this.#down.clear();
    this.#unkept.clear();
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

  /** `p` has no live box left (its last session ended, a failed keep-alive's own end among them): its keep-alive
   * failure is said for DOWN_MS more, so the row and the leads hear of it, then goes, with no box left to keep. */
  noneLive(p: ProviderId, now = Date.now()): void {
    const k = this.#unkept.get(p);
    if (k && k.until === undefined) k.until = now + DOWN_MS;
  }

  /** What the heartbeat says is wrong with each provider now (`load.sandboxTrouble`): set aside after a refusal or a
   * box that didn't come up, until when; or its boxes not kept alive. Only connected providers; empty when all is well. */
  trouble(now = Date.now()): SandboxTrouble[] {
    return this.connected().flatMap((p): SandboxTrouble[] => {
      const d = this.#down.get(p);
      if (d && d.until > now) return [{ provider: p, what: "start", reason: d.reason, why: d.why, until: d.until }];
      const k = this.#unkept.get(p);
      return k && (k.until ?? Infinity) > now ? [{ provider: p, what: "keep_alive", reason: k.reason, why: k.why }] : [];
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
    return templateName(hostedDockerfile());
  }

  /** The template a box starts from now. This recipe's own when the account has it (this machine's note of it, else
   * found at the provider by its name). While it isn't, the newest ready template of an older recipe (the last good:
   * fleetd itself reaches the box at its start, so an older one only has older pinned tools), said in the start's
   * progress (`said`) and the log, while this recipe's is built in the background (`ahead`). Only an account with no
   * template at all waits on a build. boat sizes a box at create, so one serves every size; a provider that fixed a
   * box's size in its template would build one per size (`<name>-<cpu>c<mem>g`). */
  async template(p: ProviderId, size: Size = DEFAULT_SIZE, said?: (step: HostedStep) => void): Promise<string> {
    await this.#probe();
    const { name, file, key } = this.#named(p, size);
    let kept: { name?: string; id?: string } = {};
    try {
      kept = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    if (kept.name === name && kept.id) return kept.id;
    // A run of another name (the plain template's, before the probe found this release's asset) is built ahead anew.
    let run = this.#runs.get(key);
    if (!run || run.name !== name) run = this.ahead(p, size)!;
    const { own, older } = await run.looked;
    // A build that is done answers at once; one that failed is tried again only when there is no other to start from.
    if (run.id ?? own) return (run.id ?? own)!;
    if (older) {
      const from = new Date(older.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      said?.({ older: from, building: !run.failed });
      console.log(`${nowIso()} INFO a box starts from an older hosted sandbox template {"provider":"${p}","name":"${name}","from":"${older.id}","building":${!run.failed}}`);
      return older.id;
    }
    if (run.failed) run = this.ahead(p, size)!;
    said?.("template");
    return run.done;
  }

  /** The template name for `p` and `size`, this machine's note of it, and its key among the runs: the recipe's, with
   * this node's fleetd in it where that is a release build (`baked`), whose boxes then start it without a fetch. */
  #named(p: ProviderId, size: Size) {
    const sized = (p as string) !== "boat" && !sameSize(size, DEFAULT_SIZE) ? `-${size.cpu}c${size.memGb}g` : "";
    const baked = this.#baked();
    const name = baked ? bakedName(this.templateName(), baked.sha256) : this.templateName();
    return { name: `${name}${sized}`, sized, baked, file: join(this.home, "sandbox", `template-${p}${sized}.json`), key: `${p}${sized}` };
  }

  /** This node's fleetd as a template holds it, once `#probe` found it: a release build's URL and SHA-256. Undefined
   * for a build of one's own (its URL names an asset no release has), a release whose asset isn't published there yet,
   * a machine that makes no boxes, or before the probe. */
  #bakedMemo: { url: string; sha256: string } | undefined;
  #probed: Promise<void> | undefined;
  /** When the last probe's HEAD missed: the next is asked PROBE_AGAIN_MS after it. */
  #missedAt: number | undefined;
  #baked(): { url: string; sha256: string } | undefined {
    return this.#bakedMemo;
  }

  /** Finds whether this node's fleetd is a published release asset (`source().url` answers), the only one a template's
   * build can fetch: a URL is every machine's (a build of one's own gets one that answers 404). A template of a build
   * that isn't one holds no fleetd, and its boxes fetch or take it at their start as before. A found asset is kept for
   * the process; a miss is asked again at a call PROBE_AGAIN_MS later, never at every start. */
  #probe(): Promise<void> {
    const now = this.o.now ?? Date.now;
    if (this.#probed && this.#missedAt !== undefined && now() - this.#missedAt >= PROBE_AGAIN_MS) {
      this.#probed = undefined;
      this.#missedAt = undefined;
    }
    return (this.#probed ??= (async () => {
      let s: Source;
      try {
        s = this.source();
      } catch {
        return;
      }
      if (!s.url) return;
      const released = this.o.released ?? (async (url: string) => (await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) })).ok);
      let ok = false;
      try {
        ok = await released(s.url);
      } catch {}
      if (ok) this.#bakedMemo = { url: s.url, sha256: s.sha256 };
      else {
        this.#missedAt = now();
        console.log(`${nowIso()} INFO this machine's fleetd isn't a published release (yet): its hosted template holds none, asked again in ${PROBE_AGAIN_MS / 60_000} minutes {"url":${JSON.stringify(noQuery(s.url))}}`);
      }
    })());
  }

  /** Builds this recipe's template in the background unless it is there or under way: the account's saved templates
   * are read first, and one ready under its name is noted, one still saving (another machine's build) waited for,
   * never saved over; else it is built. A run that failed stays failed (boxes start from the last good) until the next
   * call: the next link or connected key. Undefined when the template is noted already. */
  ahead(p: ProviderId, size: Size = DEFAULT_SIZE): Run | undefined {
    const { name, sized, baked, file, key } = this.#named(p, size);
    const was = this.#runs.get(key);
    if (was && !was.failed && was.name === name) return was;
    try {
      const kept = JSON.parse(readFileSync(file, "utf8")) as { name?: string; id?: string };
      if (kept.name === name && kept.id) return undefined;
    } catch {}
    let client: Provider;
    try {
      client = this.client(p);
    } catch (error) {
      const r: Run = { name, looked: Promise.resolve({}), done: Promise.reject(error), failed: true };
      r.done.catch(() => {});
      return r;
    }
    const recipe = hostedDockerfile(baked);
    const keep = (id: string) => {
      mkdirSync(join(this.home, "sandbox"), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ name, id }));
      run.id = id;
      return id;
    };
    // A lookup that fails builds, as one that finds none.
    const list = (client.saved?.("fleetd-") ?? Promise.resolve([] as Saved[])).catch(() => [] as Saved[]);
    const run: Run = {
      name,
      looked: list.then((all) => ({ ...(all.some((t) => t.name === name && t.status === "ready") ? { own: name } : {}), older: lastGood(all, name, sized) })),
      done: Promise.resolve(""),
    };
    run.done = list
      .then(async (all) => {
        const own = all.find((t) => t.name === name);
        if (own?.status === "ready") {
          console.log(`${nowIso()} INFO the hosted sandbox template is there already {"provider":"${p}","name":"${name}"}`);
          return keep(name);
        }
        if (own?.status === "saving" && client.settled) {
          console.log(`${nowIso()} INFO the hosted sandbox template is being saved by another machine {"provider":"${p}","name":"${name}"}`);
          return keep(await client.settled(name));
        }
        console.log(`${nowIso()} INFO building the hosted sandbox template {"provider":"${p}","name":"${name}"}`);
        let release = () => {};
        try {
          // Saved only once what a start runs is proven in it (recipe.ts templateCheck).
          const id = await client.build(recipe, { name, size, onLog: () => {}, labels: { [MACHINE_LABEL]: label(this.machineId) }, onBox: (box) => void (release = this.hold(box)), check: hostedCheck() });
          console.log(`${nowIso()} INFO the hosted sandbox template is built {"provider":"${p}","name":"${name}"}`);
          keep(id);
          void this.#prune(client, p, sized);
          return id;
        } finally {
          release();
        }
      })
      .catch((error: unknown) => {
        run.failed = true;
        console.warn(`${nowIso()} WARN the hosted sandbox template didn't build {"provider":"${p}","name":"${name}","error":${JSON.stringify((error as Error).message)}}`);
        // A step's own output (its exit code, stderr's tail) is for the log; a person reads that it didn't build.
        if (!(error instanceof ProviderError) || error.reason !== "failed") throw error;
        throw new ProviderError("failed", `${NAMES[p]}'s sandbox template didn't build`);
      });
    run.done.catch(() => {});
    this.#runs.set(key, run);
    return run;
  }

  /** Deletes the account's ready templates past the newest KEEP_TEMPLATES (each costs by the day past the plan's
   * included ones), and every template named as before builds proved what a start runs (`isUnproven`), which no box
   * starts from any more. Only templates (`lastGood`'s names and those), never a bot's computer image, never one still
   * saving, never one a box of this node is being created from. A machine still on an older release whose template went
   * starts from a newer one (`create`'s second try). */
  async #prune(client: Provider, p: ProviderId, sized: string): Promise<void> {
    if (!client.saved || !client.forget) return;
    try {
      const all = (await client.saved("fleetd-")).filter((t) => t.status !== "saving" && !this.#starting.has(t.name));
      const ready = all.filter((t) => t.status === "ready" && isTemplate(t.name, sized)).sort(newestFirst);
      for (const t of [...ready.slice(KEEP_TEMPLATES), ...all.filter((t) => isUnproven(t.name, sized))]) {
        await client.forget(t.name);
        console.log(`${nowIso()} INFO an old hosted sandbox template is deleted {"provider":"${p}","name":"${t.name}"}`);
      }
    } catch (error) {
      console.warn(`${nowIso()} WARN old hosted sandbox templates not deleted {"provider":"${p}","error":${JSON.stringify((error as Error).message)}}`);
    }
  }

  /** Forgets this machine's note and run of `p`'s template: the account no longer has the one it named. */
  #forget(p: ProviderId, size: Size = DEFAULT_SIZE): void {
    const { file, key } = this.#named(p, size);
    rmSync(file, { force: true });
    this.#runs.delete(key);
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
    // Each step's time to the log, at info when the box was slow to come up (shared/stages.ts).
    const stages = new Stages("hosted computer", session);
    let template = o.template ?? (await this.template(p, size, (step) => stepped(session, step)));
    stages.done("template");
    const make = () =>
      // A key per attempt, never the session's: boat keeps a key a day after its box is gone, and a session's next
      // box must be a new one.
      client.create({ template, key: `fleetd-${randomBytes(12).toString("hex")}`, labels: { [MACHINE_LABEL]: label(this.machineId), [SESSION_LABEL]: label(session) }, lifetimeMs: LIFETIME_MS, ...(size ? { size } : {}), ...(o.keep ? { keep: true } : {}) });
    let made: Awaited<ReturnType<Provider["create"]>>;
    try {
      made = await this.#from(template, make);
    } catch (error) {
      // The template this machine noted is gone (another machine deleted an old one, or a person did): looked up again,
      // once.
      if (o.template || !(error instanceof ProviderError) || error.code !== "snapshot_not_found") throw error;
      console.warn(`${nowIso()} WARN the hosted sandbox template a box was to start from is gone: looking again {"provider":"${p}","template":"${template}"}`);
      this.#forget(p, size);
      template = await this.template(p, size, (step) => stepped(session, step));
      made = await this.#from(template, make);
    }
    stages.done("create");
    const record: BoxRecord = { kind: "hosted", provider: p, boxId: made.id, secret: randomBytes(24).toString("base64url"), tcp };
    this.#making.add(made.id);
    // Its caller writes the record at once; until a while after, the reaper leaves the box.
    const made_ = () => setTimeout(() => this.#making.delete(made.id), this.o.makingMs ?? 60_000).unref?.();
    try {
      const boot = bootArgv(dirs);
      await client.start(made.id, { argv: boot.argv, env: { ...boot.env, FLEETD_BOX_SECRET: record.secret } });
      stages.done("start");
      // Until fleetd's guest answers: a provider's proxy may take the link before the bootstrap listens.
      const deadline = Date.now() + UP_MS;
      for (let wait = 250; ; wait = Math.min(wait * 2, DIAL_MAX_MS)) {
        const link = await this.#dialUp(record);
        let word: Awaited<ReturnType<typeof firstWord>>;
        try {
          word = await firstWord(link);
          if (word === "bootstrap") {
            stages.done("bootstrap up");
            const got = await deliver(link, this.source());
            if (got.cause) console.warn(`${nowIso()} WARN the box couldn't fetch fleetd itself: its bytes went over the link {"session":${JSON.stringify(session)},"cause":${JSON.stringify(got.cause)}}`);
            stages.done(`fleetd (${got.way})`);
          }
        } finally {
          link.close();
        }
        // The bootstrap, once it took fleetd, makes way for the guest: dialled again until the guest itself answers.
        if (word === "guest") break;
        if (Date.now() + wait >= deadline) throw new ProviderError("unreachable", `fleetd's guest didn't answer in the box within ${UP_MS / 1000} s`);
        await Bun.sleep(word === "bootstrap" ? 300 : wait);
      }
      stages.done("guest up");
      stages.end();
      return record;
    } catch (error) {
      await client.destroy(made.id).catch(() => {});
      throw error;
    } finally {
      made_();
    }
  }

  /** `make`, with `template` kept from `#prune` until it is answered. */
  async #from<T>(template: string, make: () => Promise<T>): Promise<T> {
    this.#starting.set(template, (this.#starting.get(template) ?? 0) + 1);
    try {
      return await make();
    } finally {
      const n = this.#starting.get(template)! - 1;
      if (n) this.#starting.set(template, n);
      else this.#starting.delete(template);
    }
  }

  /** The box's port, dialled until something there answers. */
  async #dialUp(b: BoxRecord) {
    const deadline = Date.now() + UP_MS;
    for (let wait = 250; ; wait = Math.min(wait * 2, DIAL_MAX_MS)) {
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
    return Box.open({ session, dial: () => this.dial(b), nodeSock: leadSocketPath(this.home), tcp: b.tcp, ...(b.relays?.length ? { relays: b.relays } : {}), lead: (s) => leadChannel(s, lead), tailnet, goneMs: 120_000 });
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

/** Whether `name` is a template whose build proved what a start runs before its save (`fleetd-t<hash>`, recipe.ts
 * templateName, or `fleetd-t<hash>-f<fleetd>` with a release's fleetd in it, then `sized`): never a name from before
 * builds proved it (one of those couldn't run a session), nor a bot's computer image. */
const isTemplate = (name: string, sized: string) => new RegExp(`^fleetd-t[0-9a-f]{12}(-f[0-9a-f]{12})?${sized.replace(/[^a-z0-9-]/g, "")}$`).test(name);
/** Whether `name` is a template from before builds proved what a start runs: `fleetd-<hash>` exactly, as templateName
 * named them until W756, then `sized`. A bot's computer image (`fleetd-<bot>-<key>`) or a person's own never is. */
const isUnproven = (name: string, sized: string) => new RegExp(`^fleetd-[0-9a-f]{12}${sized.replace(/[^a-z0-9-]/g, "")}$`).test(name);
const newestFirst = (a: Saved, b: Saved) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/** The newest ready template other than `name` (`isTemplate`'s), with when it was saved: another recipe's, or this
 * one's with another release's fleetd in it. */
function lastGood(all: Saved[], name: string, sized: string): { id: string; at: string } | undefined {
  const ready = all.filter((t) => t.status === "ready" && t.name !== name && isTemplate(t.name, sized)).sort(newestFirst);
  return ready[0] ? { id: ready[0].name, at: ready[0].at } : undefined;
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
