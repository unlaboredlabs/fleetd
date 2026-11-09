// A session's Chrome (crates/fleetd/src/node/browser/chrome.rs): Playwright's headless shell from the node's own
// install (installed at a pinned Playwright release where it is missing), with its DevTools pipe on fds 3 and 4 and no
// debugging port. `sh` moves the pipe there from the stdin and stdout the node holds. A warm pool keeps one launched
// for the next session. Each session takes a process of its own with a fresh, empty profile, and both are thrown away
// when it ends.
//
// A project's lead is the exception (D221, D310): each project keeps one profile of its own (`Kept`), so the sites it
// signed into stay signed in. It lives under the node's home, is used by one browser at a time, keeps only sign-ins
// (cookies and site storage; no caches, history or saved passwords), and goes when the person forgets its sign-ins or
// deletes the project.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Cdp, type Transport } from "./cdp.ts";
import { HEIGHT, WIDTH } from "./session.ts";
import { agentScoreLine } from "../oom.ts";
import { keptDir } from "../actions/signins.ts";

const LAUNCH_TIMEOUT = 20_000;
const CLOSE_WAIT = 5_000;
/** How long forgetting a project's sign-ins waits for the browser on its profile to go. */
export const WIPE_WAIT = 20_000;
/** The Playwright release whose browser and ffmpeg builds the node installs. */
export const PLAYWRIGHT_VERSION = "1.64.1";

export const installDir = (home: string) => join(home, "browser", "ms-playwright");
/** The temp dir of an install in progress, beside the install itself. */
export const installTmp = (home: string) => join(home, "browser", "install-tmp");

/** Playwright's installer, its builds going to `root` and its downloads to `tmp`: a temp dir of the install's own on
 * disk, never a /tmp held in memory (a 120 MB zip). */
export function installCommand(root: string, tmp: string): { cmd: string[]; env: Record<string, string> } {
  return {
    cmd: ["npx", "--yes", `playwright@${PLAYWRIGHT_VERSION}`, "install", "chromium-headless-shell", "ffmpeg"],
    env: { PLAYWRIGHT_BROWSERS_PATH: root, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
  };
}

/** Installs the pinned builds with Playwright's own installer, which checks their downloads. Needs Node.js; minutes on
 * a slow link. Throws why it failed. */
export async function install(home: string): Promise<void> {
  const root = installDir(home);
  mkdirSync(root, { recursive: true });
  // One a killed install left is cleared first.
  const tmp = installTmp(home);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const { cmd, env } = installCommand(root, tmp);
  try {
    let child: Subprocess<"ignore", "ignore", "pipe">;
    try {
      child = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    } catch (e) {
      throw new Error(`cannot run npx (Node.js) to install the browser: ${(e as Error).message}`);
    }
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`installing the browser failed: ${[...err].slice(-500).join("")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The newest `<prefix>-<revision>` directory under `root` that finished installing. */
function newest(root: string, prefix: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  return entries
    .map((name) => ({ name, revision: Number(name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : Number.NaN) }))
    .filter((e) => Number.isInteger(e.revision) && existsSync(join(root, e.name, "INSTALLATION_COMPLETE")))
    .sort((a, b) => b.revision - a.revision)
    .map((e) => join(root, e.name))[0];
}

/** Playwright's headless shell in an install directory. */
export function findChrome(root: string): string | undefined {
  const dir = newest(root, "chromium_headless_shell");
  if (!dir) return undefined;
  return ["chrome-headless-shell-linux64", "chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64"]
    .map((platform) => join(dir, platform, "chrome-headless-shell"))
    .find((bin) => existsSync(bin));
}

export function args(chrome: string, profile: string, sandboxed: boolean): string[] {
  const out = [
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=Translate,AutofillServerCommunication,PasswordManagerOnboarding",
    "--password-store=basic",
    "--use-mock-keychain",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
    `--window-size=${WIDTH},${HEIGHT}`,
    `--user-data-dir=${profile}`,
  ];
  if (!chrome.includes("headless-shell")) out.push("--headless=new");
  if (!sandboxed) out.push("--no-sandbox");
  out.push("about:blank");
  return out;
}

/** The pipe over the child's stdin (Chrome's fd 3) and stdout (its fd 4), NUL-framed. */
function childTransport(child: Subprocess<"pipe", "pipe", "pipe">): Transport {
  let onMessage: (text: string) => void = () => {};
  const closes: (() => void)[] = [];
  let open = true;
  void (async () => {
    let buffered = Buffer.alloc(0);
    for await (const chunk of child.stdout) {
      buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk]);
      for (let at = buffered.indexOf(0); at >= 0; at = buffered.indexOf(0)) {
        const frame = buffered.subarray(0, at).toString("utf8");
        buffered = buffered.subarray(at + 1);
        onMessage(frame);
      }
    }
    open = false;
    for (const fn of closes.splice(0)) fn();
  })();
  return {
    send(text) {
      if (!open) return false;
      child.stdin.write(`${text}\0`);
      child.stdin.flush();
      return true;
    },
    onMessage: (fn) => (onMessage = fn),
    onClose: (fn) => closes.push(fn),
    close: () => {
      open = false;
      void child.stdin.end();
    },
  };
}

/** A launched Chrome: its process, profile and pipe. */
export class Browser {
  /** The project's profile it runs on, held until it is gone. */
  lease: KeptLease | undefined;

  constructor(
    readonly child: Subprocess<"pipe", "pipe", "pipe">,
    readonly profile: string,
    readonly cdp: Cdp,
    /** A fresh profile, deleted with the browser; a kept one stays, pruned. */
    readonly throwaway = true,
  ) {}

  /** Whether it still runs. */
  alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null && !this.cdp.isClosed();
  }

  /**
   * Closes it, and its whole process group if it doesn't go within CLOSE_WAIT: a Chrome on a kept profile is asked to
   * close first, so it writes out the cookies it holds in memory. Its fresh profile goes; a kept one keeps only what
   * it keeps, and its lease is let go.
   */
  async close(): Promise<void> {
    await Promise.race([this.cdp.call(undefined, "Browser.close").catch(() => {}), Bun.sleep(CLOSE_WAIT)]);
    const exited = await Promise.race([this.child.exited.then(() => true), Bun.sleep(CLOSE_WAIT).then(() => false)]);
    if (!exited) {
      // Only its own group: the process group `sh` and Chrome started in.
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {
        this.child.kill("SIGKILL");
      }
      await this.child.exited;
    }
    this.cdp.shut();
    if (this.throwaway) rmSync(this.profile, { recursive: true, force: true });
    else pruneKept(this.profile);
    this.lease?.release();
    this.lease = undefined;
  }
}

/** Launches Chrome on a fresh profile under `profiles`, or on `kept` (a project's), and waits until it answers on its
 * pipe. */
export async function launch(chrome: string, profiles: string, sandboxed: boolean, kept?: string): Promise<Browser> {
  let profile: string;
  if (kept) {
    readyKept(kept);
    profile = kept;
  } else {
    mkdirSync(profiles, { recursive: true, mode: 0o700 });
    profile = mkdtempSync(join(profiles, "profile-"));
  }
  let child: Subprocess<"pipe", "pipe", "pipe">;
  try {
    // At the agent OOM score, so memory pressure takes the browser before the node (oom.ts).
    child = Bun.spawn(["/bin/sh", "-c", `${agentScoreLine()}exec "$0" "$@" 3<&0 4>&1 </dev/null >/dev/null`, chrome, ...args(chrome, profile, sandboxed)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (e) {
    if (!kept) rmSync(profile, { recursive: true, force: true });
    throw new Error(`cannot start ${chrome}: ${(e as Error).message}`);
  }
  // Keep draining stderr, or Chrome blocks once the pipe fills; its first lines say why a launch failed.
  const said: string[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      for (const line of decoder.decode(chunk).split("\n")) if (line && said.length < 5) said.push(line);
    }
  })();
  const browser = new Browser(child, profile, new Cdp(childTransport(child)), !kept);
  const ready = await Promise.race([
    browser.cdp.call(undefined, "Browser.getVersion").then(
      () => true,
      () => false,
    ),
    Bun.sleep(LAUNCH_TIMEOUT).then(() => false),
  ]);
  if (!ready) {
    await browser.close();
    throw new Error(`Chrome did not answer on its pipe${said.length ? `: ${said.join(" / ")}` : ""}`);
  }
  return browser;
}

/** What a session's browser is: the node's Chrome, or a test's, with its close. */
export type Launched = { cdp: Cdp; close?: () => Promise<void>; alive?: () => boolean; lease?: KeptLease };

/**
 * Launched browsers waiting for a session (chrome.rs `Pool`): taking one costs no launch, and the pool starts a new one
 * behind it. A host that refuses Chrome's sandbox (no user namespaces, as Ubuntu's AppArmor has it) gets
 * `--no-sandbox` from then on, with a warning, unless node.json requires the sandbox.
 */
export class Pool<B extends Launched = Launched> {
  private readonly ready: B[] = [];
  private filling = false;
  private noSandbox = false;
  /** Why the last refill gave up, until a launch works again. */
  refillFailed: string | undefined;

  constructor(
    /** Launches one browser, sandboxed or not, on a fresh profile or on `kept`. */
    private readonly launchOne: (sandboxed: boolean, kept?: string) => Promise<B>,
    readonly size: number,
    /** node.json `browser.sandbox`: true requires it, false turns it off; absent, wherever this host allows it. */
    private readonly sandbox: boolean | undefined = undefined,
  ) {}

  /** Whether the pool's browsers run without Chrome's sandbox: configured so, or this host refused it. */
  unsandboxed(): boolean {
    return this.sandbox === false || this.noSandbox;
  }

  private async launch(kept?: string): Promise<B> {
    if (this.unsandboxed()) return this.launchOne(false, kept);
    try {
      return await this.launchOne(true, kept);
    } catch (e) {
      if (this.sandbox !== undefined) throw e;
      const browser = await this.launchOne(false, kept);
      console.warn(`${new Date().toISOString()} WARN Chrome's sandbox refused on this host: browsers run with --no-sandbox {"error":${JSON.stringify((e as Error).message)}}`);
      this.noSandbox = true;
      return browser;
    }
  }

  /** A warm browser, or one launched now when none is; the pool refills behind it. */
  async take(): Promise<B> {
    let browser: B | undefined;
    while ((browser = this.ready.shift())) {
      if (browser.alive?.() ?? true) break;
      // One that died while it waited goes; try the next.
      await browser.close?.().catch(() => {});
    }
    const taken = browser ?? (await this.launch());
    this.refill();
    return taken;
  }

  /** A browser on a project's kept profile, launched now: the warm ones have fresh profiles. It holds `lease` until it
   * is gone. */
  async takeKept(lease: KeptLease): Promise<B> {
    let browser: B;
    try {
      browser = await this.launch(lease.dir);
    } catch (e) {
      lease.release();
      throw e;
    }
    browser.lease = lease;
    return browser;
  }

  /** Launches browsers in the background until the pool holds its size. */
  refill(): void {
    if (this.filling || this.ready.length >= this.size) return;
    this.filling = true;
    void (async () => {
      try {
        while (this.ready.length < this.size) {
          try {
            this.ready.push(await this.launch());
            this.refillFailed = undefined;
          } catch (e) {
            this.refillFailed = (e as Error).message;
            console.warn(`${new Date().toISOString()} WARN browser pool not refilled {"error":${JSON.stringify(this.refillFailed)}}`);
            return;
          }
          if (this.drained) break;
        }
      } finally {
        this.filling = false;
        if (this.drained) await this.drain();
      }
    })();
  }

  private drained = false;

  warm(): number {
    return this.ready.length;
  }

  /** Closes every waiting browser, and any the refill is launching. */
  async drain(): Promise<void> {
    this.drained = true;
    for (const browser of this.ready.splice(0)) await browser.close?.().catch(() => {});
  }
}

/** Where a project's kept profile lives (actions/signins.ts): `browser/kept/<project>`, or a former Navi's
 * `browser/navis/<project>`. */
export { keptDir };

/** What a kept profile doesn't keep, in its `Default` dir: the HTTP and code caches (a page as a site showed it, a
 * filled value it echoed too), history, the session to restore, and the stores of saved passwords and form entries.
 * Sign-ins live in its cookies and site storage, which stay. */
export const NOT_KEPT = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Sessions",
  "Current Session",
  "Current Tabs",
  "Last Session",
  "Last Tabs",
  "History",
  "History-journal",
  "Visited Links",
  "Top Sites",
  "Top Sites-journal",
  "Favicons",
  "Favicons-journal",
  "Shortcuts",
  "Shortcuts-journal",
  "Network Action Predictor",
  "Network Action Predictor-journal",
  "Web Data",
  "Web Data-journal",
  "Login Data",
  "Login Data-journal",
  "Login Data For Account",
  "Login Data For Account-journal",
];

/** Deletes what a kept profile doesn't keep, with no browser on it. */
export function pruneKept(dir: string): void {
  for (const name of NOT_KEPT) rmSync(join(dir, "Default", name), { recursive: true, force: true });
}

/** Chrome's preferences for a kept profile: it saves no password or form entry, so a value `fill_credential` typed
 * stays only in the session that typed it, which refuses reading it back (credentials.ts). */
const KEPT_PREFS = {
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
  profile: { password_manager_enabled: false },
  autofill: { enabled: false, profile_enabled: false, credit_card_enabled: false },
};

/** `over` written into `into`, object by object. */
function merge(into: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(over)) {
    const was = into[k];
    into[k] =
      v && typeof v === "object" && !Array.isArray(v) && was && typeof was === "object" && !Array.isArray(was)
        ? merge(was as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return into;
}

/** Readies a kept profile for its next launch: made (only the node reads it) when new, its preferences set, and the
 * lock and leftovers of the browser before it cleared (the lease says none runs on it now; one killed leaves both). */
export function readyKept(dir: string): void {
  try {
    mkdirSync(join(dir, "Default"), { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(`cannot ready the project's profile ${dir}: ${(e as Error).message}`);
  }
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      lstatSync(join(dir, lock));
      rmSync(join(dir, lock), { force: true });
    } catch {}
  }
  // Left by a browser that was killed (the node stopped) rather than closed.
  pruneKept(dir);
  const prefs = join(dir, "Default", "Preferences");
  let merged: Record<string, unknown> = {};
  try {
    const read = JSON.parse(readFileSync(prefs, "utf8")) as unknown;
    if (read && typeof read === "object" && !Array.isArray(read)) merged = read as Record<string, unknown>;
  } catch {}
  try {
    writeFileSync(prefs, JSON.stringify(merge(merged, structuredClone(KEPT_PREFS))));
  } catch (e) {
    throw new Error(`cannot ready the project's profile ${dir}: ${(e as Error).message}`);
  }
}

/** A project's profile, held by the one browser running on it (or a wipe) until it lets go. */
export type KeptLease = { dir: string; release(): void };

/** The projects' kept profiles, one browser on each at a time: a second session of the same project is refused rather
 * than started on a profile Chrome holds. */
export class Kept {
  /** By project: who holds it now, and those waiting for it to let go (a wipe). */
  private readonly held = new Map<string, { waiters: (() => void)[] }>();

  constructor(private readonly home: string) {}

  private dirOf(project: string): string {
    const dir = keptDir(this.home, project);
    if (!dir) throw new Error(`${project} is no project's id`);
    return dir;
  }

  /** The project's profile for a browser, unless one runs on it. Throws why not. */
  take(project: string): KeptLease {
    const dir = this.dirOf(project);
    if (this.held.has(project)) throw new Error("This project's browser is open in another session");
    const entry = { waiters: [] as (() => void)[] };
    this.held.set(project, entry);
    let released = false;
    return {
      dir,
      release: () => {
        if (released) return;
        released = true;
        if (this.held.get(project) === entry) this.held.delete(project);
        for (const fn of entry.waiters.splice(0)) fn();
      },
    };
  }

  /** Deletes the project's profile, once the browser on it (ending now) has let go. Nothing there is no error. */
  async wipe(project: string): Promise<void> {
    const dir = this.dirOf(project);
    const holder = this.held.get(project);
    if (holder) {
      const freed = await Promise.race([
        new Promise<boolean>((r) => holder.waiters.push(() => r(true))),
        Bun.sleep(WIPE_WAIT).then(() => false),
      ]);
      if (!freed) throw new Error("its browser is still closing; try again in a minute");
    }
    // Held by the wipe while it deletes: no browser starts on it meanwhile.
    const lease = this.take(project);
    try {
      wipeDir(dir);
    } finally {
      lease.release();
    }
  }

  /** How many projects' profiles are held now. */
  locks(): number {
    return this.held.size;
  }
}

/** Deletes a kept profile directory, if there is one. */
export function wipeDir(dir: string): void {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    throw new Error(`cannot delete ${dir}: ${(e as Error).message}`);
  }
}
