// Bringing a machine's Claude Code to the version the hub names (crates/fleetd/src/node/runner/claude/install.rs,
// `node_action` `claude`), and keeping Claude Code's own background update off, so nothing changes under running
// agents but this. The native installer's `install <version>` never touches a version a running session uses. A
// Claude Code installed another way (Homebrew, npm, a package) is left as it is, with how to update it.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Env } from "../util.ts";
import { headUtf16 } from "../util.ts";

export const AUTOUPDATER_OFF: [string, string] = ["DISABLE_AUTOUPDATER", "1"];
export const ALREADY = "already runs Claude Code";
export const LEFT = "Claude Code is";
/** The longest an install gets: about 200 MB at 1 Mbit/s. */
export const INSTALL_WAIT_MS = 45 * 60_000;

export type InstalledBy = "native" | "homebrew" | "npm" | "package" | "other";
export type Installed = { kind: "current"; version: string } | { kind: "done"; from: string; to: string } | { kind: "left"; said: string };

/** What the install does to the machine; tests stand in a fake. */
export interface Claude {
  version(): Promise<string | undefined>;
  installedBy(): InstalledBy;
  install(version: string): Promise<void>;
}

export const number = (output: string) => output.trim().split(/\s+/)[0] ?? "";
export const installCommand = (target: string) => `curl -fsSL https://claude.ai/install.sh | bash -s ${target}`;

/** Brings Claude Code to `target`. A failure throws why, and the version there was stays. */
export async function bringTo(claude: Claude, target: string): Promise<Installed> {
  const found = await claude.version();
  if (found === undefined) return { kind: "left", said: `${LEFT} not installed here: install ${target} with \`${installCommand(target)}\`` };
  const from = number(found);
  if (from === target) return { kind: "current", version: from };
  const how = {
    native: undefined,
    homebrew: "managed by Homebrew: run `brew upgrade claude-code` to update it",
    npm: `installed from npm: run \`npm install -g @anthropic-ai/claude-code@${target}\` to update it`,
    package: "installed by the system's package manager: upgrade `claude-code` with it to update it",
    other: `installed another way: install ${target} the same way, or with \`${installCommand(target)}\``,
  }[claude.installedBy()];
  if (how) return { kind: "left", said: `${LEFT} ${how} (it runs ${from})` };
  try {
    await claude.install(target);
  } catch (error) {
    throw new Error(`\`claude install ${target}\` failed (${(error as Error).message}), so ${from} stays`);
  }
  const now = await claude.version();
  if (now !== undefined && number(now) === target) return { kind: "done", from, to: target };
  throw new Error(`\`claude install ${target}\` finished, but \`claude --version\` says ${now ? number(now) : "nothing"}, so new sessions still start on it`);
}

/** Who installed the binary at `target`, the launcher's resolved path. */
export function installedBy(target: string): InstalledBy {
  if (basename(dirname(target)) === "versions" && basename(dirname(dirname(target))) === "claude") return "native";
  if (["/Cellar/", "/Caskroom/", "/homebrew/", "/linuxbrew/"].some((d) => target.includes(d))) return "homebrew";
  if (target.includes("/node_modules/@anthropic-ai/")) return "npm";
  if (target.startsWith("/usr/") || target.startsWith("/opt/claude")) return "package";
  return "other";
}

/** The real Claude Code: the node's launcher, run with the node's environment. */
export class RealClaude implements Claude {
  constructor(
    readonly binary: string,
    readonly env: Env,
  ) {}
  #run(args: string[], timeoutMs: number) {
    const proc = Bun.spawn([this.binary, ...args], {
      env: { ...this.env, [AUTOUPDATER_OFF[0]]: AUTOUPDATER_OFF[1] },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).finally(() => clearTimeout(timer));
  }
  async version(): Promise<string | undefined> {
    try {
      const [out, , code] = await this.#run(["--version"], 30_000);
      return code === 0 && out.trim() ? out.trim() : undefined;
    } catch {
      return undefined;
    }
  }
  installedBy(): InstalledBy {
    try {
      return installedBy(realpathSync(this.binary));
    } catch {
      return "other";
    }
  }
  async install(version: string): Promise<void> {
    const [out, err, code] = await this.#run(["install", version], INSTALL_WAIT_MS);
    if (code === 0) return;
    const said = [err, out].map((s) => s.trim()).find(Boolean)?.split("\n").pop() ?? `exit status: ${code}`;
    throw new Error(headUtf16(said, 200));
  }
}

/** Claude Code's own background update is off in its user settings (`settings.json` `env`). */
export function autoupdaterOff(settings: string): boolean {
  try {
    const v = (JSON.parse(readFileSync(settings, "utf8")) as { env?: Record<string, unknown> }).env?.[AUTOUPDATER_OFF[0]];
    return (typeof v === "string" && v !== "0" && v !== "") || v === 1;
  } catch {
    return false;
  }
}

/** Turns Claude Code's background update off in its user settings, keeping every other setting. Whether it changed
 * the file; throws why an unreadable one is left alone. */
export function turnAutoupdaterOff(settings: string): boolean {
  if (autoupdaterOff(settings)) return false;
  // A settings.json linked from dotfiles stays a link: the file it points at is the one rewritten.
  let path = settings;
  try {
    path = realpathSync(settings);
  } catch {}
  let root: unknown = {};
  if (existsSync(path)) {
    try {
      root = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`${path} isn't valid JSON (${(error as Error).message})`);
    }
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) throw new Error(`${path} isn't a JSON object`);
  const obj = root as Record<string, unknown>;
  const env = (obj.env ??= {});
  if (typeof env !== "object" || env === null || Array.isArray(env)) throw new Error(`${path}'s \`env\` isn't an object`);
  (env as Record<string, unknown>)[AUTOUPDATER_OFF[0]] = AUTOUPDATER_OFF[1];
  mkdirSync(dirname(path), { recursive: true });
  // Through a sibling and a rename, keeping its permissions (a settings file may hold a key).
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  const tmp = join(dirname(path), `.${basename(path)}.fleetd-tmp`);
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  return true;
}
