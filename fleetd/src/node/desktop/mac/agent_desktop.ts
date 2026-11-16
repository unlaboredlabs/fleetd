// vercel-labs' agent-desktop, the agents' GUI vocabulary on the Mac (crates/fleetd/src/node/desktop/mac/
// agent_desktop.rs): it reads an app's accessibility tree into refs (`snapshot --app Finder -i`) and acts on them
// (`click @s8f3k2p9:e12`). The node installs a pinned release under `<node home>/desktop/mac/agent-desktop/<version>`
// and runs it itself, one command per `desktop` action `agent_desktop`, so it acts in the node's own GUI session under
// the node's grants (it is the node's child), and never from an agent's shell. Each session gets its own
// agent-desktop home (its snapshots and refs), thrown away at its end.
//
// An app launched with `--cdp` opens a DevTools port on the Mac's loopback. The node keeps it there: a launch that names
// another address is refused, and the app is closed when the session ends. A `batch` that launches with `--cdp` is
// refused, since the node could not tell which app to close.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The agent-desktop release the node installs. */
export const VERSION = "1.1.0";

/** The release's archive for this Mac and its sha256, as the release's checksums.txt lists them. */
export function archive(arch: string = process.arch): [target: string, sha256: string] {
  return arch === "arm64"
    ? ["aarch64-apple-darwin", "3048e00aa0741bf25ffe0326f78c966408be4490ce13513f3f94ecf2a0b5270d"]
    : ["x86_64-apple-darwin", "b6352ac66aa49e0280c6f690de791dc03c827623a838950856b20ddbebcdc382"];
}

export const archiveUrl = (target: string) =>
  `https://github.com/vercel-labs/agent-desktop/releases/download/v${VERSION}/agent-desktop-v${VERSION}-${target}.tar.gz`;

/** How long one command may run: under the hub's wait for a call it forwards to the Mac (45 s), so the agent always
 * gets the command's own answer. A longer `wait` is the agent's to take in steps. */
export const COMMAND_TIMEOUT = 40_000;

/** The start of what a command printed that the agent gets back. */
export const OUTPUT_CHARS = 100_000;

export const macDir = (home: string) => join(home, "desktop", "mac");
export const installDir = (home: string) => join(macDir(home), "agent-desktop", VERSION);

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The pinned binary, once installed. */
export function find(home: string): string | undefined {
  const dir = installDir(home);
  const bin = join(dir, "agent-desktop");
  try {
    if (readFileSync(join(dir, "VERSION"), "utf8").trim() !== VERSION) return undefined;
  } catch {
    return undefined;
  }
  return isFile(bin) && isFile(join(dir, "agent-desktop-macos-helper")) ? bin : undefined;
}

let installing: Promise<string> | undefined;

/** Installs the pinned release (its archive, checked against the digest pinned here; it holds the CLI and its macOS
 * helper, which must sit beside it), unless it is there already. One install at a time. */
export function install(home: string, fetcher: typeof fetch = fetch, arch: string = process.arch): Promise<string> {
  const found = find(home);
  if (found) return Promise.resolve(found);
  installing ??= installOnce(home, fetcher, arch).finally(() => (installing = undefined));
  return installing;
}

async function installOnce(home: string, fetcher: typeof fetch, arch: string): Promise<string> {
  const [target, sha256] = archive(arch);
  const dir = installDir(home);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let bytes: Uint8Array;
  try {
    const res = await fetcher(archiveUrl(target));
    if (!res.ok) throw new Error(`HTTP status ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new Error(`cannot download agent-desktop: ${(e as Error).message}`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256) throw new Error(`agent-desktop's archive is not the pinned one (sha256 ${digest})`);
  const file = join(dir, "agent-desktop.tar.gz");
  writeFileSync(file, bytes);
  const out = Bun.spawnSync(["tar", "-xzf", file, "-C", dir, "agent-desktop", "agent-desktop-macos-helper"], { stdin: "ignore", stderr: "pipe" });
  rmSync(file, { force: true });
  if (!out.success) throw new Error(`unpacking agent-desktop failed: ${out.stderr.toString().trim()}`);
  writeFileSync(join(dir, "VERSION"), VERSION);
  const bin = find(home);
  if (!bin) throw new Error("agent-desktop's archive lacks its CLI or its helper");
  return bin;
}

/** agent-desktop's arguments as a shell would split them: words, with '…' and "…" quoting and \ escaping. */
export function split(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "'") {
      inWord = true;
      for (;;) {
        const n = chars[++i];
        if (n === undefined) throw new Error("a ' that doesn't close");
        if (n === "'") break;
        word += n;
      }
    } else if (c === '"') {
      inWord = true;
      for (;;) {
        const n = chars[++i];
        if (n === undefined) throw new Error('a " that doesn\'t close');
        if (n === '"') break;
        if (n === "\\") {
          const e = chars[++i];
          if (e === undefined) throw new Error('a " that doesn\'t close');
          word += e === '"' || e === "\\" ? e : `\\${e}`;
        } else word += n;
      }
    } else if (c === "\\") {
      inWord = true;
      const n = chars[++i];
      if (n !== undefined) word += n;
    } else if (/\s/u.test(c)) {
      if (inWord) {
        words.push(word);
        word = "";
        inWord = false;
      }
    } else {
      inWord = true;
      word += c;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** The commands that only read the screen and its apps: a session that doesn't hold the Mac's lease may run them. */
const OBSERVING = new Set([
  "version", "status", "skills", "permissions", "snapshot", "find", "get", "is", "wait", "screenshot",
  "list-apps", "list-windows", "list-displays", "list-surfaces", "list-notifications",
]);

/** The commands that act on a ref through the accessibility API, headless (no pointer, no focus) unless `--headed`:
 * agent-desktop 1.1.0's "Act on a ref" group, less double-click and triple-click, which are physical gestures. Their
 * app is the one the ref's snapshot read. */
const HEADLESS_REF = new Set([
  "click", "right-click", "type", "set-value", "clear", "focus", "select", "toggle", "check", "uncheck", "expand",
  "collapse", "scroll", "scroll-to",
]);

/** The commands that are headless only when they name their app: `press --app` posts its keys to that app (unscoped,
 * it goes to whatever is in front), `launch <app>` and `close-app <app>` name it as their first word. */
const HEADLESS_APP_FLAG = new Set(["press"]);
const HEADLESS_APP_WORD = new Set(["launch", "close-app"]);

/** What a command needs before it runs: nothing (`read`: it only reads), a claim on the app it names (`app`: it acts
 * on that app alone, headless), or the Mac's lease (`lease`: real pointer or keys, focus, or anything not known to be
 * headless), with a claim on its app too where it names one. */
export type Needs = "read" | "app" | "lease";

/** The app a command names: by name or bundle id (`--app`, or its first word), or by a ref's snapshot (`@s8f3k2p9:e12`
 * is snapshot `s8f3k2p9`'s), which the session saw read one app. */
export type Target = { app?: string; snapshot?: string };

/** One command, checked before it runs: its arguments, whether it only observes, whether it launches with `--cdp`
 * (the node closes that app when the session ends), what it needs, and the app it names. */
export type Command = { args: string[]; observing: boolean; cdp: boolean; needs: Needs; target?: Target };

/** The snapshot of a ref (`@s8f3k2p9:e12`); undefined for anything else. */
export const refSnapshot = (word: string) => /^@(s[A-Za-z0-9]+):e\d+$/.exec(word)?.[1];

/** What `args` needs, and the app it names. */
function needsOf(args: string[]): { needs: Needs; target?: Target } {
  const name = args[0]!;
  const has = (flag: string) => args.some((a) => a === flag || a.startsWith(`${flag}=`));
  const value = (flag: string) => {
    for (let i = 1; i < args.length; i++) {
      if (args[i] === flag) return args[i + 1];
      if (args[i]!.startsWith(`${flag}=`)) return args[i]!.slice(flag.length + 1);
    }
    return undefined;
  };
  const app = value("--app");
  const snapshot = args.slice(1).map(refSnapshot).find((s) => s !== undefined);
  const target = app || snapshot ? { ...(app ? { app } : {}), ...(snapshot ? { snapshot } : {}) } : undefined;
  const lease = { needs: "lease" as const, ...(target ? { target } : {}) };
  if (has("--headed")) return lease;
  if (OBSERVING.has(name)) return name === "permissions" && (has("--request") || has("--guide")) ? lease : { needs: "read" };
  if (HEADLESS_REF.has(name)) return snapshot || app ? { needs: "app", target: target! } : lease;
  if (HEADLESS_APP_FLAG.has(name)) return app ? { needs: "app", target: { app } } : lease;
  if (HEADLESS_APP_WORD.has(name)) {
    const word = args[1];
    // `launch --activate` brings the app to the front.
    if (word === undefined || word.startsWith("-") || has("--activate")) return lease;
    return { needs: "app", target: { app: word } };
  }
  return lease;
}

/** `text` as one agent-desktop command; throws why the node won't run it. */
export function command(text: string): Command {
  const args = split(text);
  const name = args[0];
  if (name === undefined) throw new Error("agent_desktop needs its arguments, the command first (`snapshot --app Finder -i`)");
  if (name.startsWith("-")) {
    throw new Error(`put agent-desktop's command first and its flags after it (\`click @ref --headed\`, not \`${name} click @ref\`)`);
  }
  const has = (flag: string) => args.some((a) => a === flag || a.startsWith(`${flag}=`));
  const cdp = name === "launch" && has("--cdp");
  if (args.some((a) => a.includes("--remote-debugging-address"))) {
    throw new Error("a DevTools port stays on the Mac's loopback: launch with --cdp alone, without --remote-debugging-address");
  }
  if (name === "batch" && text.includes("cdp")) {
    throw new Error("run `launch <app> --cdp` on its own, not in a batch, so the node can close the app when your session ends");
  }
  const needs = needsOf(args);
  return { args, observing: needs.needs === "read", cdp, ...needs };
}

/** The app a snapshot read, from a command's JSON answer (`data.snapshot_id` with `data.app`): undefined for any other
 * answer. */
export function snapshotApp(output: string): [snapshot: string, app: string] | undefined {
  try {
    const data = (JSON.parse(output.trim()) as { ok?: unknown; data?: { snapshot_id?: unknown; app?: unknown } }).data;
    return typeof data?.snapshot_id === "string" && typeof data.app === "string" && data.app ? [data.snapshot_id, data.app] : undefined;
  } catch {
    return undefined;
  }
}

/** The bundle id of app `name` (its display name or its bundle id, any case) in `list-apps`'s JSON answer; undefined
 * when it isn't running, or the answer can't be read. */
export function bundleOf(output: string, name: string): string | undefined {
  try {
    const data = (JSON.parse(output.trim()) as { data?: unknown }).data;
    const apps = Array.isArray(data) ? data : (data as { apps?: unknown } | undefined)?.apps;
    if (!Array.isArray(apps)) return undefined;
    const want = name.toLowerCase();
    for (const app of apps as { name?: unknown; bundle_id?: unknown }[]) {
      if (typeof app?.bundle_id !== "string" || !app.bundle_id) continue;
      if (app.bundle_id.toLowerCase() === want || (typeof app.name === "string" && app.name.toLowerCase() === want)) return app.bundle_id;
    }
  } catch {}
  return undefined;
}

/** The pid of the app a `launch --cdp` started, from its JSON answer (`data.pid`, with `data.cdp` set). */
export function launchedPid(output: string): number | undefined {
  try {
    const answer = JSON.parse(output.trim()) as { ok?: unknown; data?: { cdp?: unknown; pid?: unknown } };
    const pid = answer.data?.pid;
    if (answer.ok !== true || answer.data?.cdp === undefined || answer.data.cdp === null) return undefined;
    return typeof pid === "number" && Number.isInteger(pid) && pid >= 0 && pid <= 0xffffffff ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** What a command printed, cut for the agent; `code` undefined when it was stopped. */
export function answer(stdout: string, stderr: string, code: number | undefined): string {
  let text = stdout.trim() || stderr.trim();
  if (!text) {
    text =
      code === 0
        ? "agent-desktop printed nothing."
        : code !== undefined
          ? `agent-desktop exited with code ${code} and printed nothing.`
          : `agent-desktop was stopped after ${COMMAND_TIMEOUT / 1000} s and printed nothing: wait in shorter steps (--timeout-ms), or read a smaller part (snapshot --skeleton, --root <ref>)`;
  }
  const chars = [...text];
  if (chars.length > OUTPUT_CHARS) {
    text = `${chars.slice(0, OUTPUT_CHARS).join("")}\n[cut at ${OUTPUT_CHARS} characters: read a smaller part, with snapshot --skeleton, --root <ref> or -i]`;
  }
  return text;
}

/** Runs one command with the session's own agent-desktop home, at most COMMAND_TIMEOUT, and stopped as soon as `stop`
 * aborts: its exit code (undefined when it was stopped), what it printed and what it said on stderr. It answers only
 * once the command's process has exited. */
export async function run(
  bin: string,
  sessionHome: string,
  args: string[],
  timeoutMs = COMMAND_TIMEOUT,
  stop?: AbortSignal,
): Promise<{ code?: number; stdout: string; stderr: string }> {
  if (stop?.aborted) throw new Error("the session has ended");
  try {
    mkdirSync(sessionHome, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(`cannot make ${sessionHome}: ${(e as Error).message}`);
  }
  if (!existsSync(bin)) throw new Error(`cannot run agent-desktop: ${bin} isn't there`);
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd: sessionHome,
      env: { ...process.env, AGENT_DESKTOP_HOME: sessionHome },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    throw new Error(`cannot run agent-desktop: ${(e as Error).message}`);
  }
  let stopped = false;
  const kill = () => {
    stopped = true;
    proc.kill("SIGKILL");
  };
  const timer = setTimeout(kill, timeoutMs);
  stop?.addEventListener("abort", kill);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  stop?.removeEventListener("abort", kill);
  return { ...(stopped || code === null ? {} : { code }), stdout, stderr };
}
