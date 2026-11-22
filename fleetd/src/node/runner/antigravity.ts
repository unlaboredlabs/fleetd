// Google Antigravity as a session's agent: a profile whose model is one of Antigravity's runs `agy acp`, its own Agent
// Client Protocol server, in place of claude; the session's host speaks ACP to it (./host/acp.ts). It runs signed in as
// the machine's Antigravity is (its own sign-in, which fleetd never reads), or on a Gemini API key: the project's
// `GEMINI_API_KEY` Vault variable, with `GOOGLE_GEMINI_BASE_URL` for an endpoint of its own. A machine without agy gets
// it from Google's release channel, its checksum checked, at the first session that needs it. The launch itself, which
// a box shares, is ./antigravity_spec.ts.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homeDir, type Env } from "../util.ts";
import { AUTOUPDATE_OFF, loginEnv, planOf, SIGNED_IN_ASK } from "./antigravity_spec.ts";

export * from "./antigravity_spec.ts";

/** The oldest agy fleetd runs: ACP's resume, steering and `_meta` system prompt. */
const OLDEST = [1, 5, 0];

/** FLEETD_AGY_BIN (a stand-in for tests), else `agy` from PATH, else `~/.local/bin/agy` (where Google's installer and
 * fleetd's put it). */
export function agyBinary(): string {
  if (process.env.FLEETD_AGY_BIN) return process.env.FLEETD_AGY_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, "agy"))) return join(dir, "agy");
  return localBinary();
}
const localBinary = () => join(homeDir(), ".local/bin/agy");

/** `x.y.z` at or past OLDEST. */
export function versionOk(printed: string): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(printed);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (v[i] !== OLDEST[i]) return v[i]! > OLDEST[i]!;
  return true;
}

/** `agy --version`, or undefined when it doesn't run. */
export async function version(binary: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([binary, "--version"], { env: { ...process.env, [AUTOUPDATE_OFF[0]]: AUTOUPDATE_OFF[1] }, cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return code === 0 && out.trim() ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

const RELEASES = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
/** Google's release channel's name for this machine (its install.sh `platform`). */
export function platform(os = process.platform, arch = process.arch, musl = existsSync("/lib/libc.musl-x86_64.so.1") || existsSync("/lib/libc.musl-aarch64.so.1")): string {
  const a = arch === "arm64" ? "arm64" : "amd64";
  if (os === "darwin") return `darwin_${a}`;
  return `linux_${a}${musl ? "_musl" : ""}`;
}

/** What fetching and unpacking take; tests stand in a fake. */
export type Fetch = (url: string) => Promise<Uint8Array>;
const fetchBytes: Fetch = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

/** Installs the newest agy at `~/.local/bin/agy` as Google's install.sh does (its manifest, the payload's sha512 checked,
 * a tarball's `antigravity` unpacked), without touching shell profiles. Answers the binary's path. */
export async function install(get: Fetch = fetchBytes, target = localBinary()): Promise<string> {
  const manifest = JSON.parse(new TextDecoder().decode(await get(`${RELEASES}/${platform()}.json`))) as { version?: string; url?: string; sha512?: string };
  if (!manifest.url || !manifest.sha512) throw new Error("Antigravity's release manifest names no download");
  const payload = await get(manifest.url);
  if (createHash("sha512").update(payload).digest("hex") !== manifest.sha512) throw new Error("the Antigravity download doesn't match its checksum");
  const dir = join(target, "..");
  mkdirSync(dir, { recursive: true });
  const staged = join(dir, `.agy-${process.pid}`);
  rmSync(staged, { recursive: true, force: true });
  if (manifest.url.includes(".tar.gz")) {
    mkdirSync(staged);
    writeFileSync(join(staged, "agy.tar.gz"), payload);
    const tar = Bun.spawnSync(["tar", "-xzf", join(staged, "agy.tar.gz"), "-C", staged], { stderr: "pipe" });
    if (tar.exitCode !== 0) throw new Error(`unpacking Antigravity failed: ${tar.stderr.toString().trim()}`);
    const unpacked = join(staged, "antigravity");
    if (!existsSync(unpacked)) throw new Error("the Antigravity download holds no `antigravity` binary");
    chmodSync(unpacked, 0o755);
    renameSync(unpacked, target);
    rmSync(staged, { recursive: true, force: true });
  } else {
    writeFileSync(staged, payload, { mode: 0o755 });
    renameSync(staged, target);
  }
  return target;
}

/** The agy this node already found runs, so later sessions start without asking it again. */
let checked: string | undefined;

/** The agy a session runs: the one found, else a fresh install. Throws, in a person's words, when neither works. */
export async function ensure(get?: Fetch): Promise<string> {
  if (checked !== undefined && existsSync(checked)) return checked;
  // The agy found first, then fleetd's own: an older one ahead on PATH doesn't send every start to an install.
  for (const candidate of process.env.FLEETD_AGY_BIN ? [agyBinary()] : new Set([agyBinary(), localBinary()])) {
    const printed = await version(candidate);
    if (printed !== undefined && versionOk(printed)) return (checked = candidate);
  }
  if (process.env.FLEETD_AGY_BIN) throw new Error(`${process.env.FLEETD_AGY_BIN} doesn't run as agy ${OLDEST.join(".")} or newer`);
  try {
    return (checked = await install(get));
  } catch (error) {
    throw new Error(`Antigravity isn't installed here and fleetd couldn't install it: ${(error as Error).message}`);
  }
}

const SIGNED_IN_WAIT_MS = 30_000;

/** Whether the machine's agy is signed in: its plan's name ("Google AI Pro"), or undefined when it isn't. Asks
 * Antigravity's own `authenticate`, which reads the stored sign-in and calls no model; in the login's environment, so a
 * machine that isn't signed in never opens a browser of its own. Throws when agy doesn't answer. */
export async function signedIn(binary: string, env: Env): Promise<string | undefined> {
  const proc = Bun.spawn([binary, "acp"], { env: loginEnv(env), cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), SIGNED_IN_WAIT_MS);
  try {
    for (const line of SIGNED_IN_ASK) proc.stdin.write(`${line}\n`);
    proc.stdin.flush();
    const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("agy exited before it said whether it is signed in");
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const plan = planOf(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (plan !== undefined) return plan ?? undefined;
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      proc.stdin.end();
    } catch {}
    proc.kill();
  }
}
