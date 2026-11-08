// A session's Chrome (crates/fleetd/src/node/browser/chrome.rs): Playwright's headless shell from the node's own
// install, on a fresh profile, with its DevTools pipe on fds 3 and 4 and no debugging port. `sh` moves the pipe there
// from the stdin and stdout the node holds.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Cdp, type Transport } from "./cdp.ts";
import { HEIGHT, WIDTH } from "./session.ts";

const LAUNCH_TIMEOUT = 20_000;
const CLOSE_WAIT = 5_000;

export const installDir = (home: string) => join(home, "browser", "ms-playwright");

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
  constructor(
    readonly child: Subprocess<"pipe", "pipe", "pipe">,
    readonly profile: string,
    readonly cdp: Cdp,
  ) {}

  /** Closes it, and its whole process group if it doesn't go within CLOSE_WAIT; its fresh profile goes too. */
  async close(): Promise<void> {
    await this.cdp.call(undefined, "Browser.close").catch(() => {});
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
    rmSync(this.profile, { recursive: true, force: true });
  }
}

/** Launches Chrome on a fresh profile under `profiles` and waits until it answers on its pipe. */
export async function launch(chrome: string, profiles: string, sandboxed: boolean): Promise<Browser> {
  mkdirSync(profiles, { recursive: true, mode: 0o700 });
  const profile = mkdtempSync(join(profiles, "profile-"));
  let child: Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn(["/bin/sh", "-c", 'exec "$0" "$@" 3<&0 4>&1 </dev/null >/dev/null', chrome, ...args(chrome, profile, sandboxed)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (e) {
    rmSync(profile, { recursive: true, force: true });
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
  const browser = new Browser(child, profile, new Cdp(childTransport(child)));
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
