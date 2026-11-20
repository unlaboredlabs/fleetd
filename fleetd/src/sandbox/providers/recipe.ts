// The image a hosted box starts from. There is one recipe for every sandbox: the local VM's root image Dockerfile
// (sandbox/image, with the distro, git, the pinned Bun and the libraries agents' tests need). It is a base: a local VM
// gets the node's own fleetd and the machine's claude over its file share, and a hosted box has no share, so its
// template adds the pinned Claude Code and the fleetd binary on top (`hosted`). That template is built in the team's
// own provider account with the team's key (each client's `build`); fleetd publishes no image holding Claude Code.
//
// The recipe holds one FROM, then only RUN, ENV, WORKDIR and USER, so it builds with no context files on any
// provider: boat (which builds no images) replays them on a fresh box before saving it as a snapshot, and a provider
// with a build API would take them as its steps.
import base from "../image/Dockerfile" with { type: "text" };
import { TESTED } from "../../node/runner/claude_pins.ts";

export type Step = { op: "RUN" | "ENV" | "WORKDIR" | "USER"; args: string[] };
export type Recipe = { from: string; steps: Step[] };

/** The Dockerfile's FROM and steps. Throws on anything else: a COPY, ADD, ARG, heredoc or second stage. */
export function parse(dockerfile: string): Recipe {
  const lines: string[] = [];
  let cur = "";
  for (const raw of dockerfile.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (cur === "" && (/^\s*#/.test(line) || line.trim() === "")) continue;
    if (/^\s*#/.test(line)) continue; // a comment inside a continued instruction
    // As Docker reads it: a backslash at a line's end joins the next line onto it, so a RUN split over lines is one
    // shell line (kept with its newline, sh would run each line as a command of its own).
    if (line.endsWith("\\")) {
      cur += line.slice(0, -1);
      continue;
    }
    lines.push((cur + line).trim());
    cur = "";
  }
  if (cur.trim()) lines.push(cur.trim());
  let from: string | undefined;
  const steps: Step[] = [];
  for (const l of lines) {
    const m = /^(\w+)\s+([\s\S]*)$/.exec(l);
    if (!m) throw new Error(`the recipe has a line fleetd can't read: ${l.slice(0, 80)}`);
    const op = m[1]!.toUpperCase();
    const rest = m[2]!.trim();
    if (op === "FROM") {
      if (from !== undefined) throw new Error("the recipe has a second FROM: hosted templates take one stage");
      from = rest;
      continue;
    }
    if (from === undefined) throw new Error(`the recipe's first instruction is ${op}, not FROM`);
    if (op === "RUN") {
      if (rest.startsWith("[")) throw new Error("the recipe's RUN in JSON form isn't supported: write it as a shell line");
      if (/(?<!<)<<(?!<)-?\s*['"]?\w+/.test(rest)) throw new Error("the recipe has a heredoc: write the file with printf in a RUN");
      steps.push({ op, args: [rest] });
    } else if (op === "ENV") steps.push({ op, args: envPairs(rest) });
    else if (op === "WORKDIR" || op === "USER") steps.push({ op, args: [rest] });
    else throw new Error(`the recipe has ${op}: hosted templates take only RUN, ENV, WORKDIR and USER after FROM`);
  }
  if (from === undefined) throw new Error("the recipe has no FROM");
  return { from, steps };
}

/** `ENV A=1 B="two words"` (or the old `ENV A 1`) as [name, value, name, value…]. */
function envPairs(rest: string): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]*)$/.exec(rest);
    if (!m) throw new Error(`the recipe's ENV ${rest.slice(0, 40)} can't be read`);
    return [m[1]!, m[2]!];
  }
  const out: string[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)\s*/gy;
  let m: RegExpExecArray | null;
  let at = 0;
  while ((m = re.exec(rest))) {
    let v = m[2]!;
    if (v.startsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    else if (v.startsWith("'")) v = v.slice(1, -1);
    out.push(m[1]!, v);
    at = re.lastIndex;
    if (at >= rest.length) break;
  }
  if (at < rest.length) throw new Error(`the recipe's ENV ${rest.slice(0, 40)} can't be read`);
  return out;
}

/** What a hosted box needs on top of the base: Claude Code at the version fleetd was tested with, and fleetd itself. */
export type HostedPins = {
  /** `TESTED` of runner/claude.ts. */
  claude: string;
  /** The fleetd release binary for linux x64 and its SHA-256. The hosted kind leaves it out: each box gets the node's
   * own fleetd at its start (node/sandbox/remote/bootstrap.ts), so a template outlives fleetd's updates. */
  fleetd?: { url: string; sha256: string };
};

/** The tunnel that carries a box's tailnet connections to its guest (node/sandbox/tailnet_box.ts): hev-socks5-tunnel
 * (MIT), its static x86_64 build, pinned. */
export const TUNNEL = {
  url: "https://github.com/heiher/hev-socks5-tunnel/releases/download/2.20.0/hev-socks5-tunnel-linux-x86_64",
  sha256: "e41895a668b2c1d3f80d3e84ea4f1280cd2c54dd8adfadc59d29351d1a76c528",
  path: "/usr/local/bin/hev-socks5-tunnel",
} as const;

/** The hosted template's Dockerfile: the base recipe, then the pinned Claude Code, the tailnet's tunnel and fleetd,
 * for every user. */
export function hosted(base: string, pins: HostedPins): string {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(pins.claude)) throw new Error(`claude's pin ${JSON.stringify(pins.claude)} isn't a version`);
  const f = pins.fleetd;
  if (f && !/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error("fleetd's pin needs its SHA-256 in hex");
  if (f && !/^https:\/\/[^\s'"]+$/.test(f.url)) throw new Error("fleetd's pin needs an https URL");
  parse(base);
  const fleetd = f
    ? `RUN curl -fsSL ${f.url} -o /usr/local/bin/fleetd \\
 && echo '${f.sha256}  /usr/local/bin/fleetd' | sha256sum -c - \\
 && chmod 755 /usr/local/bin/fleetd
`
    : "";
  return `${base.trimEnd()}

# Hosted boxes only: Claude Code, the tailnet's tunnel${f ? " and fleetd" : ""}, pinned (sandbox/providers/recipe.ts). boat runs these steps with sudo, where
# the installer wants to be told that a system-wide install is meant.
RUN curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh \\
 && HOME=/opt/claude CLAUDE_INSTALL_ALLOW_SUDO=1 bash /tmp/claude-install.sh ${pins.claude} \\
 && ln -sf "$(readlink -f /opt/claude/.local/bin/claude)" /usr/local/bin/claude \\
 && chmod -R a+rX /opt/claude && rm -f /tmp/claude-install.sh \\
 && claude --version | grep -q '^${pins.claude.replaceAll(".", "\\.")} '
RUN curl -fsSL ${TUNNEL.url} -o ${TUNNEL.path} \\
 && echo '${TUNNEL.sha256}  ${TUNNEL.path}' | sha256sum -c - \\
 && chmod 755 ${TUNNEL.path}
${fleetd}ENV DISABLE_AUTOUPDATER=1
`;
}

/** A template's name for a recipe: the same text, the same name, so a changed pin builds a new one. */
export function templateName(dockerfile: string): string {
  return `fleetd-${new Bun.CryptoHasher("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
}

/** The hosted template's Dockerfile as fleetd builds it: its base (../image/Dockerfile) and the Claude Code fleetd was
 * tested with. Whoever builds a team's template names it from this (`templateName`), so every builder finds the same
 * one. */
export const hostedDockerfile = (): string => hosted(base, { claude: TESTED });
