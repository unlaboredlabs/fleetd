// A bot's computer image: its repo's setup commands run once, kept as the disk its next sessions start from, so their
// setup doesn't run again (design prebuilt-images-evaluation §3). There is no recipe but the setup commands themselves,
// and the image is only a cache of having run them: a missing, building, failed or stale image means a clean start plus
// setup, as without images, never a failed start.
//
// - Its key: the base it builds on (the VM root image's key, or the hosted template's name), the commands, and the
//   contents of setup's `inputs` (lockfiles) at the bot's base branch. A key no image has is built in the background,
//   one build at a time on the machine; a build that failed isn't tried again until the key changes or a Rebuild.
// - Where: this machine's VMs (`vm`: ./microvm.ts buildImage, a VM's whole disk after setup ran in it, its checkout
//   left out), or on the hub's runner the hosted provider's snapshot (./hosted.ts buildSnapshot).
// - A session starts from it when its worktree's inputs give the same key: a local VM's disk stacks over a read-only
//   link of the image (`sessionLayer`), a hosted box is made from the snapshot. When setup wrote into the checkout
//   (node_modules, say: the image holds no checkout), it still runs there, over the image's caches and tools.
// - Bounded: once a bot's new image is ready its older ones go. A local session holds its own link to the file it
//   started from; a hosted one keeps its snapshot from going while its choice file names it.
// - Never in an image: the session's Claude dir, transcript, .gitconfig and order variables (they are this machine's,
//   shared in, ./provision.ts), and no value of the bot's secret variables: a build that finds one written to its disk
//   fails, naming the file.
import { createHash } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComputerImage, WorktreeSetup } from "../../shared/contracts.ts";
import { vmDir } from "../../sandbox/host/tools.ts";
import { nowIso, tailUtf16 } from "../util.ts";
import type { Place } from "./index.ts";

/** Changes when what an image holds changes, so no image of an older layout is stacked again. */
const FORMAT = 1;
/** A box's own disk, sparse: what it writes takes room, nothing else. */
export const DISK_GIB = 64;
/** The longest log a failed build keeps. */
export const LOG_MAX = 4000;

export type Where = "vm" | "e2b" | "boat" | "daytona";

export const imagesDir = (node: string) => join(vmDir(node), "images");
export const disksDir = (node: string) => join(vmDir(node), "disks");
/** A local box's own writable disk, kept between its boxes and gone with its task. */
export const sessionDisk = (node: string, session: string) => join(disksDir(node), `${session}.img`);
/** The image a local box stacks its disk over: its own link to the bot's image file. */
export const sessionLayer = (node: string, session: string) => join(disksDir(node), `${session}.layer.img`);
const choiceFile = (node: string, session: string) => join(disksDir(node), `${session}.image.json`);
const keptFile = (node: string, project: string) => join(imagesDir(node), `${project}.json`);

/** A sparse disk of DISK_GIB at `path`, unless one is there. The guest formats it the first time it boots. */
export function newDisk(path: string): void {
  if (existsSync(path)) return;
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", 0o600);
  try {
    ftruncateSync(fd, DISK_GIB * 2 ** 30);
  } finally {
    closeSync(fd);
  }
}

/** Session `session`'s disk, its image's link and its choice go: its task ended. */
export function dropDisk(node: string, session: string): void {
  for (const f of [sessionDisk(node, session), sessionLayer(node, session), choiceFile(node, session)]) rmSync(f, { force: true });
}

/** A session's start from its image didn't work (the snapshot went): it goes on without one. */
export function dropChoice(node: string, session: string): void {
  rmSync(choiceFile(node, session), { force: true });
  rmSync(sessionLayer(node, session), { force: true });
}

/** The image a session started from: where, what (the image file, or the provider's snapshot), and whether its setup
 * still runs in the checkout (`worktree`). */
export type Choice = { where: Where; ref: string; key: string; builtAt: string; worktree: boolean; commands?: string[] };

export function sessionImage(node: string, session: string): Choice | undefined {
  try {
    return JSON.parse(readFileSync(choiceFile(node, session), "utf8")) as Choice;
  } catch {
    return undefined;
  }
}

/**
 * The image session `session` starts from in `place`, `choice` what it chose (`Images.use`): a local box boots now and
 * says whether it stacked it. One that didn't (its image didn't mount, or no VM came up and it runs as a process) has
 * its choice dropped, and runs its setup: never a start with setup skipped and no image under it.
 */
export async function startsFrom(place: Pick<Place, "fromImage">, choice: Choice | undefined, node: string, session: string, cwd: string, env: Record<string, string | undefined>): Promise<Choice | undefined> {
  if (!choice || !place.fromImage || (await place.fromImage({ cwd, env }))) return choice;
  console.warn(`${nowIso()} WARN a session's box isn't over its bot's computer image (it didn't mount, or no VM came up): its setup runs {"sessionId":"${session}"}`);
  dropChoice(node, session);
  return undefined;
}

/** Whether a session's setup may start from, and so build, its bot's image: a task's worktree on its branch, whose
 * setup is the bot's and whose base is the bot's. A reader's or reviewer's detached worktree (its base a PR's head, its
 * setup its own installs) neither uses nor builds one. */
export const takesImage = (local: { branch?: string }): boolean => !!local.branch;

/** A file's contents for the key, or undefined when it isn't there. */
type Reader = (path: string) => Uint8Array | undefined;

/** The key of an image of `setup` built on `base` for `where`, its inputs as `read` gives them; undefined without
 * commands. */
export function imageKey(setup: WorktreeSetup, base: string, where: Where, read: Reader): string | undefined {
  const commands = setup.commands ?? [];
  if (!commands.length) return undefined;
  const hash = createHash("sha256").update(`format ${FORMAT}\0${where}\0${base}\0`);
  for (const c of commands) hash.update("command\0").update(c).update("\0");
  for (const input of setup.inputs ?? []) {
    hash.update("input\0").update(input);
    const bytes = read(input);
    hash.update(bytes ? createHash("sha256").update(bytes).digest() : "\0absent\0");
  }
  return hash.digest("hex");
}

/** A worktree's files as the key reads them. */
export const fromFiles =
  (cwd: string): Reader =>
  (p) => {
    try {
      return readFileSync(join(cwd, p));
    } catch {
      return undefined;
    }
  };

/** The files at commit `ref` of the checkout `root`. */
export const atCommit =
  (root: string, ref: string): Reader =>
  (p) => {
    const r = Bun.spawnSync(["git", "-C", root, "show", `${ref}:${p}`], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout : undefined;
  };

const git = (root: string, args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
};

/**
 * The commit new worktrees of the checkout `root` start from: the bot's base branch (`base`, as the hub or a task's
 * worktree names it: `main`), its remote's copy first, as a new worktree takes it; without one, the remote's default
 * branch, else the checkout's own HEAD.
 */
export function baseRef(root: string, base?: string): string {
  const has = (ref: string) => Bun.spawnSync(["git", "-C", root, "rev-parse", "--verify", "-q", `${ref}^{commit}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  if (base) for (const ref of base.startsWith("origin/") ? [base] : [`origin/${base}`, base]) if (has(ref)) return ref;
  const r = Bun.spawnSync(["git", "-C", root, "rev-parse", "--abbrev-ref", "origin/HEAD"], { stdout: "pipe", stderr: "ignore" });
  const ref = r.stdout.toString().trim();
  return r.exitCode === 0 && ref.startsWith("origin/") ? ref : "HEAD";
}

/** One build: the bot's checkout at its base (`cwd`, a worktree of the build's own), its commands and variables. */
export type Job = {
  project: string;
  key: string;
  cwd: string;
  setup: WorktreeSetup;
  /** The bot's variables (no order's: a build has none). */
  env: Record<string, string>;
  /** The values no image may hold: the bot's secret variables'. */
  secrets: string[];
  log: (text: string) => void;
};

/** What a build made: the image file or snapshot, its size, and whether setup wrote into the checkout. */
export type Built = { ref: string; bytes?: number; worktree: boolean };

/** Where a machine's images are built and kept. */
export type Backend = {
  where: Where;
  /** What its images build on: the VM root image's key, or the hosted template's name. */
  base: string;
  build(job: Job): Promise<Built>;
  /** An image goes (a file, or a provider's snapshot). */
  drop(ref: string): Promise<void>;
};

type Kept = {
  /** The bot's base branch, as last named (the hub's settings, a task's worktree). */
  base?: string;
  ready?: { key: string; ref: string; where: Where; builtAt: string; bytes?: number; worktree: boolean };
  failed?: { key: string; at: string; log: string };
};

export type ImagesOptions = {
  home: string;
  /** Where this machine's images go now; undefined: nowhere (no VMs, not the runner). */
  backend: () => Backend | undefined;
  /** A bot's checkout on this machine (the node's project). */
  root: (project: string) => string | undefined;
  /** Its variables, and its secrets' values. */
  vars: (project: string) => { env: Record<string, string>; secrets: string[] };
  /** Its image changed (a build started, ended or failed). */
  changed?: (project: string, image: ComputerImage) => void;
};

export class Images {
  /** Each bot's build under way or waiting for the machine's one build, and what comes after it. */
  #running = new Map<string, { key: string; startedAt: string; again?: { setup: WorktreeSetup; force: boolean; base?: string } }>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly o: ImagesOptions) {}

  #kept(project: string): Kept {
    try {
      return JSON.parse(readFileSync(keptFile(this.o.home, project), "utf8")) as Kept;
    } catch {
      return {};
    }
  }

  #save(project: string, k: Kept): void {
    mkdirSync(imagesDir(this.o.home), { recursive: true, mode: 0o700 });
    const at = keptFile(this.o.home, project);
    writeFileSync(`${at}.tmp`, JSON.stringify(k), { mode: 0o600 });
    renameSync(`${at}.tmp`, at);
  }

  /** The commit the bot's image builds from: its base branch's, `base` when named (and kept for later), else the last
   * one named. */
  #ref(project: string, root: string, base?: string): string {
    const k = this.#kept(project);
    // A branch's name, never a commit (a detached worktree's base): the bot's base is where its work lands.
    const named = base && !/^[0-9a-f]{40}$/u.test(base) ? base : undefined;
    if (named && named !== k.base) this.#save(project, { ...k, base: named });
    return baseRef(root, named ?? k.base);
  }

  /** The bot's image as the Computer page shows it, `base` its base branch. One due (none for its key yet, and none
   * failed for it) starts building. */
  status(project: string, setup: WorktreeSetup, base?: string): ComputerImage {
    this.ensure(project, setup, false, base);
    return this.#view(project, setup);
  }

  #view(project: string, setup: WorktreeSetup): ComputerImage {
    const b = this.o.backend();
    if (!b || !(setup.commands ?? []).length) return { state: "none" };
    const k = this.#kept(project);
    const ready = k.ready && k.ready.where === b.where ? k.ready : undefined;
    const has = { where: b.where, ...(ready ? { builtAt: ready.builtAt, ...(ready.bytes !== undefined ? { bytes: ready.bytes } : {}) } : {}) };
    const run = this.#running.get(project);
    if (run) return { state: "building", startedAt: run.startedAt, ...has };
    if (k.failed && (!ready || k.failed.at > ready.builtAt)) return { state: "failed", failedAt: k.failed.at, log: k.failed.log, ...has };
    return ready ? { state: "ready", ...has } : { state: "none", where: b.where };
  }

  /** Builds the bot's image when its key has none (or `force`: a Rebuild). A build under way finishes first, and the
   * last request after it then runs. */
  ensure(project: string, setup: WorktreeSetup, force = false, base?: string): ComputerImage {
    const b = this.o.backend();
    if (!b || !(setup.commands ?? []).length) return { state: "none" };
    const root = this.o.root(project);
    const run = this.#running.get(project);
    if (run || !root) {
      if (run) run.again = { setup, force: force || !!run.again?.force, ...(base ? { base } : {}) };
      return this.#view(project, setup);
    }
    const ref = this.#ref(project, root, base);
    const key = imageKey(setup, b.base, b.where, atCommit(root, ref))!;
    const k = this.#kept(project);
    if (!force && (k.ready?.key === key || k.failed?.key === key)) return this.#view(project, setup);
    this.#running.set(project, { key, startedAt: nowIso() });
    const view = this.#view(project, setup);
    this.o.changed?.(project, view);
    const next = this.#queue.then(() => this.#build(project, setup, b, key, ref));
    this.#queue = next.catch(() => {});
    return view;
  }

  async #build(project: string, setup: WorktreeSetup, b: Backend, key: string, ref: string): Promise<void> {
    const root = this.o.root(project);
    const dir = join(imagesDir(this.o.home), "build", project);
    const wt = join(dir, "wt");
    let log = "";
    const { env, secrets } = this.o.vars(project);
    const mask = (t: string) => secrets.reduce((acc, s) => (s ? acc.split(s).join("[secret]") : acc), t);
    const say = (t: string) => void (log = tailUtf16(`${log}${mask(t).trimEnd()}\n`, LOG_MAX * 4));
    try {
      if (!root) throw new Error("the bot's checkout isn't on this machine");
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        git(root, ["worktree", "prune"]);
      } catch {}
      git(root, ["worktree", "add", "--detach", "-q", wt, ref]);
      console.log(`${nowIso()} INFO building a bot's computer image {"projectId":"${project}","where":"${b.where}"}`);
      const at = Date.now();
      const built = await b.build({ project, key, cwd: wt, setup, env, secrets, log: say });
      const k = this.#kept(project);
      const old = k.ready;
      k.ready = { key, ref: built.ref, where: b.where, builtAt: nowIso(), ...(built.bytes !== undefined ? { bytes: built.bytes } : {}), worktree: built.worktree };
      delete k.failed;
      this.#save(project, k);
      console.log(`${nowIso()} INFO a bot's computer image is ready {"projectId":"${project}","where":"${b.where}","ms":${Date.now() - at},"bytes":${built.bytes ?? 0}}`);
      // The store keeps one image a bot: the ones before it go. A local session holds its own link to the file it started
      // from; a hosted one's snapshot stays while it names it.
      if (old && old.ref !== built.ref && (b.where === "vm" || !this.#inUse(old.ref))) await b.drop(old.ref).catch(() => {});
      await this.#prune(project, b, built.ref);
    } catch (error) {
      say(`fleetd: ${(error as Error).message}`);
      const k = this.#kept(project);
      k.failed = { key, at: nowIso(), log: tailUtf16(log.trimEnd(), LOG_MAX) };
      this.#save(project, k);
      console.warn(`${nowIso()} WARN a bot's computer image didn't build: its agents start clean and run setup {"projectId":"${project}","error":${JSON.stringify(mask((error as Error).message))}}`);
    } finally {
      if (root && existsSync(wt)) {
        try {
          git(root, ["worktree", "remove", "--force", wt]);
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
      const run = this.#running.get(project);
      this.#running.delete(project);
      this.o.changed?.(project, this.#view(project, setup));
      if (run?.again) this.ensure(project, run.again.setup, run.again.force, run.again.base);
    }
  }

  /** Whether a session's choice names `ref`. */
  #inUse(ref: string): boolean {
    let names: string[] = [];
    try {
      names = readdirSync(disksDir(this.o.home)).filter((n) => n.endsWith(".image.json"));
    } catch {}
    return names.some((n) => sessionImage(this.o.home, n.slice(0, -".image.json".length))?.ref === ref);
  }

  /** The bot's image files that aren't `keep`: a build cut off by a restart, an older one. Its sessions hold their own
   * links. */
  async #prune(project: string, b: Backend, keep: string): Promise<void> {
    if (b.where !== "vm") return;
    let names: string[] = [];
    try {
      names = readdirSync(imagesDir(this.o.home));
    } catch {}
    for (const n of names) {
      const f = join(imagesDir(this.o.home), n);
      if (n.startsWith(`${project}-`) && f !== keep) rmSync(f, { force: true });
    }
  }

  /**
   * The image session `session` of bot `project` starts from, its worktree `cwd` given: the bot's ready image when the
   * worktree's inputs give its key, recorded as the session's choice (and, for a local VM, linked as its layer) the
   * first time; undefined otherwise, when it starts clean and the image due is built for later sessions. A session
   * that started without one goes on without one. `where`: where the session runs, this machine's VMs or a provider;
   * `base`: its worktree's base branch, the bot's.
   */
  use(project: string, setup: WorktreeSetup, cwd: string, session: string, where: Where | undefined, base?: string): Choice | undefined {
    const had = sessionImage(this.o.home, session);
    if (had) return had.where === where ? had : undefined;
    const b = this.o.backend();
    if (!b || !(setup.commands ?? []).length) return undefined;
    // A session placed elsewhere than this machine's images go (a hosted box of a machine that runs VMs) starts clean.
    if (b.where !== where) return undefined;
    // A session whose box has a disk already started without one.
    if (b.where === "vm" && existsSync(sessionDisk(this.o.home, session))) return undefined;
    const ready = this.#kept(project).ready;
    const key = imageKey(setup, b.base, b.where, fromFiles(cwd));
    if (!ready || ready.where !== b.where || ready.key !== key) {
      this.ensure(project, setup, false, base);
      return undefined;
    }
    const choice: Choice = { where: b.where, ref: ready.ref, key: ready.key, builtAt: ready.builtAt, worktree: ready.worktree, commands: setup.commands ?? [] };
    try {
      mkdirSync(disksDir(this.o.home), { recursive: true, mode: 0o700 });
      if (b.where === "vm") {
        rmSync(sessionLayer(this.o.home, session), { force: true });
        linkSync(ready.ref, sessionLayer(this.o.home, session));
      }
      writeFileSync(choiceFile(this.o.home, session), JSON.stringify(choice), { mode: 0o600 });
    } catch (error) {
      console.warn(`${nowIso()} WARN a session starts clean, not from its bot's image: ${(error as Error).message} {"sessionId":"${session}"}`);
      dropDisk(this.o.home, session);
      return undefined;
    }
    return choice;
  }

  /** The bot left this machine: its images go. */
  async removeProject(project: string): Promise<void> {
    const k = this.#kept(project);
    const b = this.o.backend();
    if (k.ready && b && b.where === k.ready.where && (b.where === "vm" || !this.#inUse(k.ready.ref))) await b.drop(k.ready.ref).catch(() => {});
    rmSync(keptFile(this.o.home, project), { force: true });
    if (b) await this.#prune(project, b, "");
  }

  /** Waits for the builds under way (tests). */
  idle(): Promise<unknown> {
    return this.#queue;
  }
}

let current: Images | undefined;
/** The node's images (none where nothing builds them). */
export const useImages = (i: Images | undefined) => void (current = i);
export const images = () => current;
