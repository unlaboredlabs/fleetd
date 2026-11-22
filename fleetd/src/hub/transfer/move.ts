// Move to the cloud (decision hosted.move-hub-to-cloud): this hub, whole, into an empty fleetd cloud team, from the
// app (Settings › Hub › Setup). The app signs in to the cloud and hands the hub the team's address and a device key of
// the team's owner (hub_move_start); the hub does the rest:
//
// 1. It pauses itself: leads take no turns, agents don't start, automations don't fire (`moveHold`), so nothing runs
//    twice and nothing said meanwhile is lost (it waits). The pause is `hub-moved.json` in the hub's home, the key in
//    it sealed to the hub's box key, so a restart keeps it.
// 2. It writes its export (export.ts) to a file of its home, its secrets under a passphrase it makes and sends only
//    in the start's header, then uploads it to the team's owner routes (cloud.ts) a piece at a time. A cut is waited
//    out piece by piece; an upload the cloud dropped starts again from the first piece.
// 3. It starts the import and follows the run until the cloud says done or failed.
// 4. Done: the pause stays (hub_move_resume lifts it, the data all kept), and each machine rejoins the team by
//    itself: the hub asks the cloud for a one-time code per machine and sends it over the machine's own link
//    (`node_action` `rejoin`, node/rejoin.ts). A machine offline then gets it the next time it links; one whose fleetd
//    is too old to take it is updated first. Once every machine has joined, the key is forgotten.
//
// Anything that stops it before the cloud has the import (a cut too long, a refusal, a team with data, too big, an
// older cloud, the sign-in gone) ends the upload there, lifts the pause and says why in plain words with one way
// forward: both sides are as they were. Nothing here logs the key, a code or the passphrase.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { HubMove, HubMoveFailure, HubMoveMachine, HubMoveMachineState, HubMovePhase, HubMoveStartInput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { loadOrCreateBoxKey } from "../../shared/sealed_box.ts";
import { openSealed, publicKeyOf, seal } from "../../shared/sealed_box_core.ts";
import { CAP_REJOIN } from "../../shared/node_link.ts";
import { VERSION } from "../../shared/version.ts";
import type { Hub } from "../api/hub.ts";
import { nodePort } from "../link/node_port.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { tasks } from "../tasks/index.ts";
import { updates } from "../update/tools.ts";
import { vault } from "../vault/index.ts";
import { CloudRefusal, CloudTransfer, CloudUnreached, type Fetch, type RunAnswer } from "./cloud.ts";
import { boxKeyAt, exportHub } from "./export.ts";
import { TransferError } from "./format.ts";
import { settingsPath } from "../../shared/settings_path.ts";

export const MOVE_FILE = "hub-moved.json";
const EXPORT_FILE = join("move", "export.tar");
/** A machine whose hand-off failed this many times is left with its reason, until the move is resumed and made again. */
const HANDOFF_TRIES = 5;
/** How many times an upload the cloud dropped starts again. */
const UPLOAD_RUNS = 3;

export type MoveDeps = {
  fetch: Fetch;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The passphrase the export's secrets travel under: random, made here, never shown. */
  passphrase: () => string;
  version: string;
  /** How long one cut may last before the move gives up. */
  cutMs: number;
  /** How often the run, and the machines' rejoin, are read. */
  pollMs: number;
  /** scrypt's cost for the export's secrets, for tests. */
  kdfN?: number;
};

const realDeps = (): MoveDeps => ({
  fetch: (url, init) => fetch(url, init),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    }),
  passphrase: () => randomBytes(32).toString("base64url"),
  version: VERSION,
  cutMs: 10 * 60_000,
  pollMs: 3_000,
});

type MachineKept = { name: string; state: HubMoveMachineState; why?: string; tries: number };

/** `hub-moved.json`: the pause, and what a restart needs to carry the move on. */
type Kept = {
  team: string;
  url: string;
  since: string;
  /** The owner's device key, sealed to this hub's box key (base64); gone once every machine has joined. */
  key?: string;
  runId?: string;
  /** The cloud took the start: the import may finish whatever this hub does. */
  started?: boolean;
  done?: boolean;
  skipped?: string[];
  machines?: Record<string, MachineKept>;
};

/** A move stopped: the line the person reads, the way forward, and what to key on. */
class Stopped extends Error {
  constructor(readonly failure: HubMoveFailure) {
    super(failure.message);
  }
}

const stop = (reason: string, message: string, fix: string) => new Stopped({ reason, message, fix });
const CANCELLED: HubMoveFailure = { reason: "cancelled", message: "The move was stopped. Nothing changed on either side.", fix: "Press Move to start again." };

const size = (bytes: number) => {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1000 && u < units.length - 1) {
    n /= 1000;
    u++;
  }
  return `${u === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[u]}`;
};

/** What a refusal of the cloud's means for the person, by its reason. */
export function failureOf(error: unknown, team: string): HubMoveFailure {
  if (error instanceof Stopped) return error.failure;
  if (error instanceof CloudUnreached) {
    return { reason: "offline", message: "This hub lost its connection to fleetd cloud during the move.", fix: "Check this hub's internet connection, then press Move again." };
  }
  if (error instanceof TransferError) {
    return { reason: error.reason === "newer" ? "newer" : "failed", message: error.message, fix: "Update fleetd on this hub, then press Move again." };
  }
  if (error instanceof CloudRefusal) return refusalOf(error, team);
  return { reason: "failed", message: `The move stopped: ${(error as Error)?.message ?? String(error)}.`, fix: "Press Move again." };
}

function refusalOf(r: { status?: number; code: string; reason?: string | undefined; message: string; fix?: string | undefined }, team: string): HubMoveFailure {
  switch (r.reason) {
    case "not_empty":
      return { reason: "not_empty", message: `${team} already has bots or data, and a hub moves only into an empty team.`, fix: "Sign in again and move into a new team." };
    case "too_large":
      return { reason: "too_large", message: `This hub is too big for ${team}: ${r.message}`, fix: "Remove old recordings and attachments from this hub, then press Move again." };
    case "newer":
      return { reason: "newer", message: "fleetd cloud runs an older fleetd than this hub, so it can't take this hub's data yet.", fix: "Try again later: fleetd cloud updates within a day." };
    case "busy":
      return { reason: "refused", message: `Another move into ${team} is running.`, fix: "Wait for it to end, then press Move again." };
    case "cancelled":
      return { reason: "cancelled", message: "The move was stopped.", fix: "Press Move to start again." };
    case undefined:
      if (r.status === 401 || (r.status === 403 && (r.code === "unauthorized" || r.code === "" || r.code === "forbidden"))) {
        return r.status === 403 && r.code === "forbidden"
          ? { reason: "signed_out", message: `Only an owner of ${team} can move a hub into it.`, fix: "Sign in as the team's owner, then press Move again." }
          : { reason: "signed_out", message: "Your sign-in to fleetd cloud ended during the move.", fix: "Sign in again, then press Move." };
      }
  }
  return { reason: "refused", message: `fleetd cloud refused the move: ${r.message}`, fix: r.fix ?? "Press Move again." };
}

export class Mover {
  private kept: Kept | undefined;
  private phase: HubMovePhase = "idle";
  private bytes: number | undefined;
  private total: number | undefined;
  private failure: HubMoveFailure | undefined;
  private job: AbortController | undefined;
  private handing: Promise<void> | undefined;
  private following = false;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly hub: Hub,
    private readonly deps: MoveDeps,
  ) {
    this.kept = this.read();
  }

  private get file() {
    return join(this.hub.config.home, MOVE_FILE);
  }

  private read(): Kept | undefined {
    try {
      return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Kept) : undefined;
    } catch {
      return undefined;
    }
  }

  private save(): void {
    if (this.kept === undefined) {
      rmSync(this.file, { force: true });
      return;
    }
    const part = `${this.file}.part`;
    writeFileSync(part, JSON.stringify(this.kept, null, 2), { mode: 0o600 });
    renameSync(part, this.file);
  }

  /** Why the hub's leads, agents and automations wait now; undefined while it isn't paused. */
  hold(): string | undefined {
    const k = this.kept;
    if (k === undefined) return undefined;
    return k.done ? `this hub moved to fleetd cloud (${k.team})` : `this hub is moving to fleetd cloud (${k.team})`;
  }

  /** Resolves once the pause is lifted (or `signal` aborts). */
  whenResumed(signal: AbortSignal): Promise<void> {
    if (this.kept === undefined || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  private lifted(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
    // What waited on the pause goes on: queued agents start, lead wakes are delivered (they wait on whenResumed).
    tasks(this.hub).retrySoon();
  }

  status(): HubMove {
    const k = this.kept;
    const phase: HubMovePhase = this.phase !== "idle" ? this.phase : k?.done ? "done" : k !== undefined ? "loading" : "idle";
    const machines: HubMoveMachine[] = k?.machines
      ? Object.entries(k.machines).map(([machineId, m]) => ({ machineId, name: m.name, state: m.state, ...(m.why ? { why: m.why } : {}) }))
      : store(this.hub)
          .machinesList()
          .map((m) => ({ machineId: m.machineId, name: m.name || m.machineId, state: "waiting" }));
    return {
      phase,
      machines,
      ...(k ? { team: k.team, url: k.url, paused: { team: k.team, url: k.url, since: k.since } } : {}),
      ...(this.phase === "uploading" || this.phase === "packing" ? { ...(this.bytes !== undefined ? { bytes: this.bytes } : {}), ...(this.total !== undefined ? { totalBytes: this.total } : {}) } : {}),
      ...(this.failure && phase === "failed" ? { failure: this.failure } : {}),
      ...(k?.skipped && k.skipped.length > 0 ? { skipped: k.skipped } : {}),
    };
  }

  private busy(): boolean {
    return this.phase === "packing" || this.phase === "uploading" || this.phase === "loading";
  }

  private sealKey(key: string): string {
    return Buffer.from(seal(publicKeyOf(loadOrCreateBoxKey(this.hub.config.home)), new TextEncoder().encode(key))).toString("base64");
  }

  private openKey(): string | undefined {
    const sealed = this.kept?.key;
    const box = boxKeyAt(this.hub.config.home);
    if (sealed === undefined || box === undefined) return undefined;
    const plain = openSealed(box, new Uint8Array(Buffer.from(sealed, "base64")));
    return plain === null ? undefined : new TextDecoder().decode(plain);
  }

  private client(): CloudTransfer | undefined {
    const key = this.openKey();
    return key === undefined || this.kept === undefined ? undefined : new CloudTransfer(this.kept.url, key, this.deps.fetch);
  }

  start(input: HubMoveStartInput): HubMove {
    if (this.busy()) throw new ToolError("failed", "This hub is moving already.", "Wait for it to end.");
    if (this.kept?.done) throw new ToolError("failed", `This hub moved to ${this.kept.team} already.`, "Press Undo first to move it again.");
    if (this.kept !== undefined) throw new ToolError("failed", `This hub is finishing a move into ${this.kept.team}.`, "Wait for it to end.");
    const url = input.url.replace(/\/+$/, "");
    if (!/^(https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?|http:\/\/127\.0\.0\.1:\d{1,5})$/.test(url)) throw new ToolError("invalid", "That isn't a fleetd cloud team's address.");
    if (input.key.length < 8 || input.key.length > 500) throw new ToolError("invalid", "That isn't a device key.");
    const team = input.team.trim().slice(0, 63) || url;
    this.failure = undefined;
    this.bytes = undefined;
    this.total = undefined;
    // The pause first, so nothing happens on this hub that the export wouldn't carry.
    this.kept = { team, url, since: isoMs(this.hub.clock.now()), key: this.sealKey(input.key) };
    this.save();
    this.phase = "packing";
    const job = new AbortController();
    this.job = job;
    void this.run(job.signal);
    return this.status();
  }

  /** Stops a move before the cloud has started its import; refused once it has. */
  cancel(): HubMove {
    if (!this.busy()) return this.status();
    if (this.kept?.started) throw new ToolError("failed", "fleetd cloud is loading this hub's data now, which can't be stopped halfway.", "Wait for it to end.");
    this.job?.abort();
    return this.status();
  }

  /** Undo: the pause lifts and this hub runs as before; its data was never changed. */
  resume(): HubMove {
    if (this.busy()) throw new ToolError("failed", "This hub is moving now.", this.kept?.started ? "Wait for it to end." : "Stop the move first.");
    this.kept = undefined;
    this.save();
    this.phase = "idle";
    this.failure = undefined;
    this.lifted();
    return this.status();
  }

  /** At the hub's start: a move a restart cut off ends plainly, one the cloud took is followed, one done hands off. */
  recover(): void {
    const k = this.kept;
    if (k === undefined) return;
    rmSync(join(this.hub.config.home, EXPORT_FILE), { force: true });
    if (k.done) return void this.follow();
    if (k.started && k.runId) {
      this.phase = "loading";
      const job = new AbortController();
      this.job = job;
      void this.finish(job.signal, k.runId);
      return;
    }
    const c = this.client();
    const restarted: HubMoveFailure = { reason: "restarted", message: "This hub restarted during the move, so the move stopped. Nothing changed on either side.", fix: "Press Move again." };
    if (!c || !k.runId) return this.fail(restarted);
    // The restart may have cut its start's answer off: the run says whether the cloud took it.
    const runId = k.runId;
    this.phase = "loading";
    void c.run(runId).then(
      async (run) => {
        if (run.state === "uploading") {
          await c.drop(runId).catch(() => {});
          this.fail(restarted);
        } else {
          this.kept!.started = true;
          this.save();
          await this.finish(this.hub.shutdown.signal, runId);
        }
      },
      () => this.unsure(k.team, restarted),
    );
  }

  private fail(failure: HubMoveFailure): void {
    this.failure = failure;
    this.phase = "failed";
    this.kept = undefined;
    this.save();
    this.lifted();
  }

  private async run(signal: AbortSignal): Promise<void> {
    const team = this.kept!.team;
    const file = join(this.hub.config.home, EXPORT_FILE);
    const c = this.client();
    try {
      if (!c) throw stop("failed", "This hub couldn't keep the team's key for the move.", "Press Move again.");
      await this.pack(file, signal);
      const runId = await this.upload(c, file, signal);
      if (signal.aborted) throw stop("cancelled", "The move was stopped. Nothing changed on either side.", "Press Move to start again.");
      this.phase = "loading";
      const started = await this.start_(c, runId, signal);
      this.passphrase = undefined;
      if (started === "started") {
        // The cloud may finish the import from here on, whatever this hub does.
        this.kept!.started = true;
        this.save();
        await this.finish(signal, runId);
      } else if (started === "unsure") await this.settle(c, runId, team, signal.aborted ? CANCELLED : undefined);
      else throw started;
    } catch (error) {
      this.passphrase = undefined;
      const runId = this.kept?.runId;
      if (runId !== undefined && !this.kept?.started) await c?.drop(runId).catch(() => {});
      if (runId !== undefined && this.kept?.started) {
        // The start may have reached the cloud even though its answer didn't: the run says.
        await this.finish(signal, runId);
        return;
      }
      this.fail(signal.aborted ? { reason: "cancelled", message: "The move was stopped. Nothing changed on either side.", fix: "Press Move to start again." } : failureOf(error, team));
    } finally {
      rmSync(file, { force: true });
      rmSync(`${file}.part`, { force: true });
      if (this.job?.signal === signal) this.job = undefined;
    }
  }

  private passphrase: string | undefined;

  /**
   * The start: "started" once the cloud took it (a second start refused as started already counts), the refusal for
   * one it refused (it never started), "unsure" when its answer never came (the run says).
   */
  private async start_(c: CloudTransfer, runId: string, signal: AbortSignal): Promise<"started" | "unsure" | Error> {
    try {
      await this.retrying(() => c.start(runId, this.passphrase!), signal);
      return "started";
    } catch (error) {
      if (error instanceof CloudRefusal) return error.status === 409 && error.reason === undefined ? "started" : error;
      return "unsure";
    }
  }

  /**
   * A start whose answer never came: the run says whether the cloud took it. Still uploading, it never did: the upload
   * goes and the pause lifts. Taken, it is followed. Unread, the pause stays and the person looks at the team first.
   */
  private async settle(c: CloudTransfer, runId: string, team: string, stopped?: HubMoveFailure): Promise<void> {
    let run: RunAnswer | undefined;
    try {
      run = await this.retrying(() => c.run(runId), this.hub.shutdown.signal);
    } catch {
      run = undefined;
    }
    if (run === undefined) return this.unsure(team, failureOf(new CloudUnreached("no answer"), team));
    if (run.state === "uploading") {
      await c.drop(runId).catch(() => {});
      return this.fail(stopped ?? { reason: "offline", message: "fleetd cloud never got the start of the move. Nothing changed on either side.", fix: "Check this hub's internet connection, then press Move again." });
    }
    this.kept!.started = true;
    this.save();
    await this.finish(this.hub.shutdown.signal, runId);
  }

  /** The cloud may have the import, and this hub can't tell: the pause stays, and Undo is the person's once they've looked. */
  private unsure(team: string, why: HubMoveFailure): void {
    this.failure = { reason: why.reason, message: `${why.message} fleetd cloud may still have loaded this hub's data.`, fix: `Open ${team} to see whether its bots arrived; if they didn't, press Undo here.` };
    this.phase = "failed";
  }

  private async pack(file: string, signal: AbortSignal): Promise<void> {
    this.phase = "packing";
    const v = vault(this.hub);
    const items = this.hub.db.conn.query<{ n: number }, []>("SELECT count(*) AS n FROM vault_items").get()?.n ?? 0;
    if (items > 0 && v.keys.locked) {
      throw stop("vault_locked", "This hub's vault is locked, so its logins and cards can't move.", "Unlock the vault in Settings › Vault, then press Move again.");
    }
    this.passphrase = this.deps.passphrase();
    mkdirSync(join(this.hub.config.home, "move"), { recursive: true, mode: 0o700 });
    const part = `${file}.part`;
    const out = await open(part, "w", 0o600);
    let written = 0;
    try {
      await exportHub({
        home: this.hub.config.home,
        fleetd: this.deps.version,
        now: () => this.hub.clock.now(),
        write: async (chunk) => {
          if (signal.aborted) throw stop("cancelled", "The move was stopped.", "Press Move to start again.");
          for (let at = 0; at < chunk.length; ) at += (await out.write(chunk, at)).bytesWritten;
          written += chunk.length;
          this.bytes = 0;
          this.total = written;
        },
        secrets: { passphrase: this.passphrase, box: boxKeyAt(this.hub.config.home), root: (id) => v.keys.key(id), ...(this.deps.kdfN ? { kdfN: this.deps.kdfN } : {}) },
      });
      await out.sync();
    } finally {
      await out.close();
    }
    renameSync(part, file);
  }

  /** The export into a new upload run, piece by piece; a run the cloud dropped starts again. Returns the run. */
  private async upload(c: CloudTransfer, file: string, signal: AbortSignal): Promise<string> {
    const team = this.kept!.team;
    const total = statSync(file).size;
    this.phase = "uploading";
    this.total = total;
    this.bytes = 0;
    const ours = this.hub.db.conn.query<{ name: string }, []>("SELECT name FROM migrations_applied").all().map((m) => m.name);
    for (let runs = 1; ; runs++) {
      const begun = await this.retrying(() => c.begin(), signal);
      const runId = begun.runId;
      this.kept!.runId = runId;
      this.save();
      const drop = async (why: Stopped) => {
        await c.drop(runId).catch(() => {});
        delete this.kept!.runId;
        throw why;
      };
      if (begun.maxBytes !== undefined && total > begun.maxBytes) {
        await drop(stop("too_large", `This hub's data is ${size(total)}, and ${team} has room for ${size(begun.maxBytes)}.`, "Remove old recordings and attachments from this hub, then press Move again."));
      }
      if (begun.migrations !== undefined) {
        const theirs = new Set(begun.migrations);
        if (ours.some((m) => !theirs.has(m))) await drop(stop("newer", "fleetd cloud runs an older fleetd than this hub, so it can't take this hub's data yet.", "Try again later: fleetd cloud updates within a day."));
      }
      let gone = false;
      this.bytes = 0;
      for (let n = 1, at = 0; at < total; n++) {
        const bytes = new Uint8Array(await Bun.file(file).slice(at, Math.min(total, at + begun.pieceBytes)).arrayBuffer());
        try {
          await this.retrying(() => c.put(runId, n, bytes), signal);
        } catch (error) {
          // The cloud dropped this upload (it ended, or another one reaped it): it goes up again from the start.
          if (error instanceof CloudRefusal && (error.status === 404 || (error.status === 409 && error.reason === undefined && error.code === "conflict"))) {
            gone = true;
            break;
          }
          throw error;
        }
        at += bytes.length;
        this.bytes = at;
      }
      if (!gone) return runId;
      if (runs >= UPLOAD_RUNS) throw stop("refused", "fleetd cloud kept dropping this hub's upload.", "Press Move again in a few minutes.");
    }
  }

  /** `work`, again while the cloud isn't reached, until it has been out for `cutMs`. */
  private async retrying<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    let since: number | undefined;
    for (let wait = 1_000; ; wait = Math.min(wait * 2, 15_000)) {
      if (signal.aborted) throw stop("cancelled", "The move was stopped.", "Press Move to start again.");
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof CloudUnreached)) throw error;
        const now = this.hub.clock.now();
        since ??= now;
        if (now - since >= this.deps.cutMs) throw error;
        await this.deps.sleep(wait, signal);
      }
    }
  }

  /** Follows a started import to its end: done keeps the pause and hands the machines over; failed lifts it. */
  private async finish(signal: AbortSignal, runId: string): Promise<void> {
    const c = this.client();
    const team = this.kept?.team ?? "the team";
    let run: RunAnswer;
    try {
      if (!c) throw stop("failed", "This hub lost the team's key.", "Sign in again; if the team got this hub's bots, press Undo here and use the team.");
      for (;;) {
        run = await this.retrying(() => c.run(runId), signal);
        if (run.state === "done" || run.state === "failed" || run.state === "uploading") break;
        await this.deps.sleep(this.deps.pollMs, signal);
        if (signal.aborted) return;
      }
    } catch (error) {
      if (signal.aborted) return;
      // The cloud took the import and may finish it: the pause stays, and the person looks there before Undo.
      this.unsure(team, failureOf(error, team));
      return;
    }
    if (run.state === "uploading") {
      // The cloud never took the start (an older note of this hub's said it had): the upload goes, the pause lifts.
      await c.drop(runId).catch(() => {});
      this.fail({ reason: "failed", message: "fleetd cloud never started loading this hub's data. Nothing changed on either side.", fix: "Press Move again." });
      return;
    }
    if (run.state === "failed") {
      this.fail(run.error ? refusalOf(run.error, team) : { reason: "failed", message: "fleetd cloud couldn't load this hub's data.", fix: "Press Move again." });
      return;
    }
    const summary = run.summary ?? {};
    const listed = Array.isArray(summary.machines) ? (summary.machines as { machineId?: unknown; name?: unknown }[]) : [];
    const machines: Record<string, MachineKept> = {};
    for (const m of listed) if (typeof m.machineId === "string") machines[m.machineId] = { name: typeof m.name === "string" && m.name ? m.name : m.machineId, state: "waiting", tries: 0 };
    const skipped = Array.isArray(summary.skipped) ? summary.skipped.filter((s): s is string => typeof s === "string") : [];
    this.kept = { ...this.kept!, done: true, machines, ...(skipped.length > 0 ? { skipped } : {}) };
    this.save();
    this.phase = "done";
    this.follow();
  }

  /** The machines' hand-off, round after round, until every one has joined or the pause is lifted. */
  private follow(): void {
    if (this.following) return;
    this.following = true;
    const signal = this.hub.shutdown.signal;
    void (async () => {
      try {
        while (!signal.aborted && this.kept?.done) {
          await this.handOff();
          const left = Object.values(this.kept?.machines ?? {});
          if (left.every((m) => m.state === "joined")) break;
          await this.deps.sleep(this.deps.pollMs, signal);
        }
      } finally {
        this.following = false;
      }
    })();
  }

  /** One round: what the team says has joined, then a code over its link to each machine linked here and able to take one. */
  handOff(): Promise<void> {
    this.handing ??= this.round().finally(() => (this.handing = undefined));
    return this.handing;
  }

  private async round(): Promise<void> {
    const k = this.kept;
    if (!k?.done || !k.runId || !k.machines) return;
    const machines = k.machines;
    const c = this.client();
    if (!c) return;
    const runId = k.runId;
    const set = (id: string, state: HubMoveMachineState, why?: string) => {
      const m = machines[id]!;
      m.state = state;
      if (why === undefined) delete m.why;
      else m.why = why;
    };
    try {
      for (const m of (await c.joined(runId)).machines) if (m.joined && machines[m.machineId]) set(m.machineId, "joined");
    } catch {
      return;
    }
    const port = nodePort(this.hub);
    const pending = Object.entries(machines).filter(([, m]) => m.state !== "joined");
    const ready: string[] = [];
    for (const [id, m] of pending) {
      if (!port.onLink(id)) {
        if (m.state !== "rejoining") set(id, "offline");
        continue;
      }
      if (!port.can(id, CAP_REJOIN)) {
        if (m.state !== "updating") {
          set(id, "updating", `${m.name} runs an older fleetd that can't move by itself, so it is updating first.`);
          const started = updates(this.hub).start(undefined, false);
          if (!("run" in started)) set(id, "updating", `${m.name} runs an older fleetd that can't move by itself. Update it (${settingsPath("Machines", "Updates")}); it moves once it runs the hub's fleetd.`);
        }
        continue;
      }
      // Its node said it enrolled there: it restarts onto the team, which says so once it is linked.
      if (m.state === "rejoining" || m.tries >= HANDOFF_TRIES) continue;
      ready.push(id);
    }
    if (ready.length > 0) {
      let codes;
      try {
        codes = await c.codes(runId);
      } catch {
        this.save();
        return;
      }
      const hubUrl = codes.hubUrl ?? k.url;
      await Promise.all(
        ready.map(async (id) => {
          const m = machines[id]!;
          const code = codes.machines.find((x) => x.machineId === id);
          if (code?.joined) return set(id, "joined");
          if (!code?.code) return set(id, "waiting", `${k.team} has no place for ${m.name}.`);
          set(id, "rejoining");
          try {
            const reply = await port.request(id, { t: "node_action", action: "rejoin", rejoin: { hub: hubUrl, code: code.code } });
            if (reply.ok === true) return;
            m.tries++;
            set(id, "waiting", `${m.name} couldn't rejoin yet: ${String(reply.message ?? "no reason given")}.`);
          } catch (error) {
            m.tries++;
            set(id, port.onLink(id) ? "waiting" : "offline", port.onLink(id) ? `${m.name} didn't answer: ${(error as Error).message}.` : undefined);
          }
        }),
      );
    }
    if (Object.values(machines).every((m) => m.state === "joined")) delete k.key;
    this.save();
  }
}

const realMover = (hub: Hub) => hub.area("hub_move", (h) => new Mover(h, h.peek<MoveDeps>("hub_move_deps") ?? realDeps()));

/** The hub's move: `hub.area("hub_move")`; a test sets `hub_move_deps` first. */
export const mover = (hub: Hub): Mover => realMover(hub);

/** Why the hub's leads, agents and automations wait for its move; undefined when they don't. */
export const moveHold = (hub: Hub): string | undefined => mover(hub).hold();
