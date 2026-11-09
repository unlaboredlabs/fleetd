// What the hub says about a machine's runner, from what its probe reported (crates/fleetd/src/node/runner/claude/
// guide.rs, version.rs, setup.rs `ClaudeSetup`'s Display): the words and commands a person reads in the doctor.
import { homedir } from "node:os";
import { SUPPORTED, TESTED } from "../../node/runner/claude.ts";
import type { RunnerInfo } from "../../shared/sessions.ts";

export const INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
const OLDEST: Version = [2, 1, 300];
const BELOW: Version = [2, 2, 0];

type Version = [number, number, number];
export type VersionVerdict = "ok" | "untested_older" | "untested_newer" | "unreadable";

function parse(version: string): Version | undefined {
  let word = version.split(/\s+/).find((w) => w !== "");
  if (word === undefined) return undefined;
  if (word.startsWith("v")) word = word.slice(1);
  const core = word.split(/[-+]/)[0] ?? "";
  const parts = core.split(".");
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return undefined;
  return parts.map(Number) as Version;
}

const below = (a: Version, b: Version) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

export function versionCheck(version: string): VersionVerdict {
  const found = parse(version);
  if (!found) return "unreadable";
  if (below(found, OLDEST)) return "untested_older";
  if (!below(found, BELOW)) return "untested_newer";
  return "ok";
}

/** A version fleetd wasn't tested with: what to say about `found` and the command that fixes it. */
export function versionProblem(found: string): [string, string | undefined] | undefined {
  const verdict = versionCheck(found);
  const f = found.trim();
  switch (verdict) {
    case "ok":
      return undefined;
    case "untested_older":
      return [
        `claude ${f} is older than fleetd is tested with (${SUPPORTED}); sessions run, and fleetd checks its protocol at every start.`,
        "claude update",
      ];
    case "untested_newer":
      return [
        `claude ${f} is newer than fleetd is tested with (${SUPPORTED}); sessions run, and if they misbehave, pin the tested version.`,
        `claude install ${TESTED}`,
      ];
    case "unreadable":
      return [
        `\`claude --version\` printed ${JSON.stringify(f)}, which fleetd can't read as a version; sessions run, and fleetd checks its protocol at every start.`,
        `${INSTALL} -s ${TESTED}`,
      ];
  }
}

/** The runner's words: the claude guide, the only runner there is (`node::runner::guide`). */
export const guide = {
  name: "claude",
  product: "Claude Code",
  install: INSTALL,
  pinTested: `claude install ${TESTED}`,
  protocol: "the stream-json protocol",
  /** How to log it in; behind a proxy, the proxy holds the login. */
  loginFix: (proxy: boolean) => (proxy ? "log in with your proxy as you normally do" : "claude auth login"),
  versionProblem,
  setup: setupText,
} as const;

/** `~/…` for paths under the hub's home directory. */
function tilde(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

const lastSegment = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? "";

/** The setup sessions use, in a person's words: version, login, proxy, config dir. */
export function setupText(info: RunnerInfo): string {
  const version = info.version?.split(/\s+/).find((w) => w !== "");
  if (version === undefined) return "claude is not usable";
  let out = `claude ${version}, `;
  const loginKind = info.login === "logged_in" ? (info.loginLabel ?? info.loginKind ?? "unknown kind") : undefined;
  if (loginKind !== undefined) out += `logged in (${loginKind})`;
  else if (info.problem !== undefined) out += "not logged in";
  else out += "login unknown";
  if (info.proxy !== undefined) {
    out += `, via proxy ${info.proxy}`;
    if (info.proxySource !== undefined) out += ` from ${info.proxySource}`;
  }
  // A node from before these fields reports none; it ran its sessions in fleetd's old profile.
  const dir = info.configDir ?? "~/.fleetd/claude";
  if (lastSegment(dir) !== ".claude") out += `, config ${tilde(dir)}`;
  return out;
}
