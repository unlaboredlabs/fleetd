// Google Antigravity as a session's agent: a profile whose model is one of Antigravity's runs `agy acp`, its own Agent
// Client Protocol server, in place of claude; the session's host speaks ACP to it (./host/acp.ts). It runs signed in as
// the machine's Antigravity is (its own sign-in, which fleetd never reads), or on a Gemini API key: the project's
// `GEMINI_API_KEY` Vault variable, with `GOOGLE_GEMINI_BASE_URL` for an endpoint of its own. A machine without agy gets
// it from Google's release channel, its checksum checked, at the first session that needs it.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Effort } from "../../shared/contracts.ts";
import { homeDir, type Env } from "../util.ts";
import type { AcpSpec } from "./host/acp.ts";

export const RUNNER = "antigravity";
/** The agy fleetd was tested with, and the oldest it runs: ACP's resume, steering and `_meta` system prompt. */
export const TESTED = "1.5.14";
const OLDEST = [1, 5, 0];

/** A profile's model that runs any model Antigravity offers (hub/projects/profiles.ts ANTIGRAVITY_MODELS lists the
 * Gemini ones): `antigravity/claude-opus-5-5`. */
export const PREFIX = "antigravity/";

/** The model `agy` takes for a profile's model; undefined when it runs on Claude. */
export function agyModel(model: string): string | undefined {
  if (model.startsWith(PREFIX)) return model.slice(PREFIX.length) || undefined;
  return model.startsWith("gemini-") ? model : undefined;
}

/** The thinking level of a profile's effort: Antigravity's highest is `xhigh`. */
export const thinking = (effort: Effort) => (effort === "max" ? "xhigh" : effort);

export const KEY_ENV = "GEMINI_API_KEY";
export const ENDPOINT_ENV = "GOOGLE_GEMINI_BASE_URL";
/** Google credentials a session never takes from the machine's environment: the sign-in mode runs on agy's own sign-in,
 * the key mode on the project's key alone. */
const GOOGLE_VARS = [KEY_ENV, ENDPOINT_ENV, "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "AGY_ADC_AUTH", "GEMINI_HOME"];
/** Updates come from fleetd (`install`), never under a running agent. */
export const AUTOUPDATE_OFF: [string, string] = ["AGY_CLI_DISABLE_AUTO_UPDATE", "1"];

/** FLEETD_AGY_BIN (a stand-in for tests), else `agy` from PATH, else `~/.local/bin/agy` (where Google's installer and
 * fleetd's put it). */
export function agyBinary(): string {
  if (process.env.FLEETD_AGY_BIN) return process.env.FLEETD_AGY_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, "agy"))) return join(dir, "agy");
  return localBinary();
}
const localBinary = () => join(homeDir(), ".local/bin/agy");

/** How a session signs in: the project's key when it has one, else the machine's own Antigravity sign-in. */
export type Auth = { kind: "signin" } | { kind: "key"; key: string; endpoint?: string };
export const authOf = (vars: Env): Auth =>
  vars[KEY_ENV] ? { kind: "key", key: vars[KEY_ENV]!, ...(vars[ENDPOINT_ENV] ? { endpoint: vars[ENDPOINT_ENV] } : {}) } : { kind: "signin" };

/** agy's argv: a key session keeps its conversations in an Antigravity home of its own (`home`), so the person's own
 * agy keeps its sign-in and settings. */
export const args = (auth: Auth, home: string): string[] => (auth.kind === "key" ? ["acp", "--gemini-dir", home] : ["acp"]);

/** The environment agy starts with: `env` without Google credentials, then the key's and fleetd's own. */
export function spawnEnv(env: Env, auth: Auth): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (!GOOGLE_VARS.includes(k)) out[k] = v;
  if (auth.kind === "key") {
    out[KEY_ENV] = auth.key;
    if (auth.endpoint) out[ENDPOINT_ENV] = auth.endpoint;
  }
  out[AUTOUPDATE_OFF[0]] = AUTOUPDATE_OFF[1];
  return out;
}

/** Claude's `--mcp-config` servers as ACP's `mcpServers`: stdio ones with `env`, http ones with `headers`, each a list. */
export function mcpServers(config: string): unknown[] {
  const servers = (JSON.parse(config) as { mcpServers?: Record<string, Record<string, any>> }).mcpServers ?? {};
  const pairs = (o: unknown) => Object.entries((o ?? {}) as Record<string, string>).map(([name, value]) => ({ name, value: String(value) }));
  return Object.entries(servers).map(([name, s]) =>
    s.type === "http" || s.type === "sse"
      ? { type: s.type, name, url: s.url, headers: pairs(s.headers) }
      : { name, command: s.command, args: s.args ?? [], env: pairs(s.env) },
  );
}

/** What the host's ACP driver runs the session with (./host/acp.ts). */
export function spec(o: {
  cwd: string;
  addDirs: string[];
  mcpConfig: string;
  systemPrompt?: string;
  model: string;
  effort: Effort;
  auth: Auth;
  approval: boolean;
  deny: string[];
  stateFile: string;
}): AcpSpec {
  return {
    cwd: o.cwd,
    addDirs: o.addDirs,
    mcpServers: mcpServers(o.mcpConfig),
    ...(o.systemPrompt ? { systemPrompt: o.systemPrompt } : {}),
    model: agyModel(o.model) ?? o.model,
    effort: thinking(o.effort),
    ...(o.auth.kind === "key" ? { authMethod: "gemini-api-key" } : {}),
    approval: o.approval,
    deny: o.deny,
    stateFile: o.stateFile,
  };
}

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
  const found = agyBinary();
  if (found === checked) return found;
  const printed = await version(found);
  if (printed !== undefined && versionOk(printed)) return (checked = found);
  if (process.env.FLEETD_AGY_BIN) throw new Error(`${found} doesn't run as agy ${OLDEST.join(".")} or newer`);
  try {
    return (checked = await install(get));
  } catch (error) {
    throw new Error(`Antigravity isn't installed here and fleetd couldn't install it: ${(error as Error).message}`);
  }
}
