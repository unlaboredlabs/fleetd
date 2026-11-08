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

/** One command, checked before it runs: its arguments, whether it only observes, and whether it launches with `--cdp`
 * (the node closes that app when the session ends). */
export type Command = { args: string[]; observing: boolean; cdp: boolean };

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
  const observing = OBSERVING.has(name) && !(name === "permissions" && (has("--request") || has("--guide")));
  return { args, observing, cdp };
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

/** Runs one command with the session's own agent-desktop home, at most COMMAND_TIMEOUT: its exit code (undefined when
 * it was stopped), what it printed and what it said on stderr. */
export async function run(bin: string, sessionHome: string, args: string[], timeoutMs = COMMAND_TIMEOUT): Promise<{ code?: number; stdout: string; stderr: string }> {
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
  const timer = setTimeout(() => {
    stopped = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { ...(stopped || code === null ? {} : { code }), stdout, stderr };
}
