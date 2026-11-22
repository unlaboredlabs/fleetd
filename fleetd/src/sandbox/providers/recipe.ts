// The image a hosted box starts from: the base Dockerfile (sandbox/image, with the distro, git, the pinned Bun and the
// libraries agents' tests need), and on top of it the pinned Claude Code and the fleetd binary (`hosted`). That template is built in the team's
// own provider account with the team's key (each client's `build`); fleetd publishes no image holding Claude Code.
//
// The recipe holds one FROM, then only RUN, ENV, WORKDIR and USER, so it builds with no context files on any
// provider: boat (which builds no images) replays them on a fresh box before saving it as a snapshot, and a provider
// with a build API would take them as its steps.
import base from "../image/Dockerfile" with { type: "text" };
import { TESTED } from "../../node/runner/claude_pins.ts";
import { noQuery, shq } from "./shell.ts";

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
  /** The fleetd release binary for linux x64 and its SHA-256, at FLEETD_PATH: a box's bootstrap starts that one when
   * it is the node's own build, and fetches the node's otherwise (node/sandbox/remote/bootstrap.ts), so a template
   * built for one release still serves the next. */
  fleetd?: { url: string; sha256: string };
};

/** Claude Code's linux x64 build of each version a hosted template installs (TESTED of runner/claude.ts), by its
 * SHA-256 as its release's manifest.json gives it (downloads.claude.ai/claude-code-releases/<version>/manifest.json,
 * `platforms["linux-x64"].checksum`): the binary is fetched and checked, never an install script's latest word. A
 * bump of TESTED adds its line here. */
export const CLAUDE_LINUX_X64: Readonly<Record<string, string>> = {
  "2.1.314": "4487042b4c4f5d88d4568f68ae98aae0b1ffae58864cf57fb868641bc5f84594",
};
export const CLAUDE_DOWNLOADS = "https://downloads.claude.ai/claude-code-releases";
/** Where every hosted template has its Claude Code, which a hosted start runs (node/place/hosted.ts BOX_CLAUDE): its
 * own, not /usr/local/bin's, which a provider's image or a bot's setup may hold another of. The pinned binary is
 * linked here; templates from before it was pinned had its installer's launcher at the same path. */
export const CLAUDE_PATH = "/opt/claude/.local/bin/claude";

/** What a template must hold before it is saved, run as the box's own user (the one a session runs as) in the build's
 * box, its last step (each provider's `build`, BuildOptions.check): the Claude Code a start runs, at CLAUDE_PATH and
 * at `claude`'s version, and the Bun a box's bootstrap runs under. A build that fails it saves nothing, so a template
 * a start couldn't run in is never one to start from (W756: one without CLAUDE_PATH was, on 2026-11-20). */
export function templateCheck(claude: string): string {
  return `test -x ${word(CLAUDE_PATH)} && ${word(CLAUDE_PATH)} --version | grep -q ${versionLine(claude)} && bun --version >/dev/null`;
}

/** `v` as one word of a recipe's shell line, quoted for sh: every value a line here takes (a URL, a path, a version)
 * goes through it. Refused when it can't be quoted safely: a control character, a newline among them, would end the
 * Dockerfile's line and start an instruction of its own. The error leaves out a URL's query (a signed link's). */
export function word(v: string): string {
  if (/[\x00-\x1f\x7f]/.test(v)) throw new Error(`the recipe can't take ${JSON.stringify(noQuery(v))}: it has a control character, a newline or a tab`);
  return shq(v);
}

/** grep's pattern, quoted, for `claude --version`'s line at version `v`. */
const versionLine = (v: string) => word(`^${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `);

/** The shell line that fetches `url` to `path`, checks its SHA-256 and makes it executable, each value quoted. */
export function fetched(url: string, sha256: string, path: string): string {
  return `curl -fsSL ${word(url)} -o ${word(path)} \\
 && echo ${word(`${sha256}  ${path}`)} | sha256sum -c - \\
 && chmod 755 ${word(path)}`;
}

/** Where a hosted template holds fleetd (`HostedPins.fleetd`), which a box's bootstrap looks at first. */
export const FLEETD_PATH = "/usr/local/bin/fleetd";

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
  const claudeSha = CLAUDE_LINUX_X64[pins.claude];
  if (!claudeSha) throw new Error(`claude ${pins.claude} has no pinned SHA-256 in CLAUDE_LINUX_X64 (sandbox/providers/recipe.ts)`);
  const f = pins.fleetd;
  if (f && !/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error("fleetd's pin needs its SHA-256 in hex");
  // Quoted (`word`), a signed link's `&`s stay in its URL: unquoted, sh cut it at each and ran the rest as commands.
  if (f && !/^https:\/\/\S+$/.test(f.url)) throw new Error("fleetd's pin needs an https URL with no space in it");
  parse(base);
  const claude = `/opt/claude/claude-${pins.claude}`;
  const fleetd = f ? `RUN ${fetched(f.url, f.sha256, FLEETD_PATH)}\n` : "";
  return `${base.trimEnd()}

# Hosted boxes only: Claude Code, the tailnet's tunnel${f ? " and fleetd" : ""}, pinned and checked (sandbox/providers/recipe.ts).
RUN mkdir -p ${word(CLAUDE_PATH.slice(0, CLAUDE_PATH.lastIndexOf("/")))} \\
 && ${fetched(`${CLAUDE_DOWNLOADS}/${pins.claude}/linux-x64/claude`, claudeSha, claude)} \\
 && ln -sf ${word(claude)} ${word(CLAUDE_PATH)} && ln -sf ${word(claude)} ${word("/usr/local/bin/claude")} \\
 && chmod -R a+rX ${word("/opt/claude")} && ${word(CLAUDE_PATH)} --version | grep -q ${versionLine(pins.claude)}
RUN ${fetched(TUNNEL.url, TUNNEL.sha256, TUNNEL.path)}
${fleetd}ENV DISABLE_AUTOUPDATER=1
`;
}

/** A template's name for a recipe: the same text, the same name, so a changed pin builds a new one. `fleetd-t`: one
 * built with `templateCheck` passed before its save (the names before it, `fleetd-<hash>`, weren't, and one of them
 * couldn't run a session: none of those is a template to start from). */
export function templateName(dockerfile: string): string {
  return `fleetd-t${new Bun.CryptoHasher("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
}

/** The hosted template's Dockerfile as fleetd builds it: its base (../image/Dockerfile) and the Claude Code fleetd was
 * tested with. Whoever builds a team's template names it from this (`templateName`), so every builder finds the same
 * one. */
export const hostedDockerfile = (fleetd?: HostedPins["fleetd"]): string => hosted(base, { claude: TESTED, ...(fleetd ? { fleetd } : {}) });
/** The check every hosted template's build passes before its save: `templateCheck` at the Claude Code fleetd was tested
 * with. */
export const hostedCheck = (): string => templateCheck(TESTED);

/** The name a hosted template holding fleetd `sha256` (`hostedDockerfile(fleetd)`) is saved under: its recipe's own
 * name (`templateName(hostedDockerfile())`, which a bot's computer image keys on, so a release builds none of those
 * again) and its fleetd build's, so each release has one of its own. */
export const bakedName = (recipe: string, sha256: string): string => `${recipe}-f${sha256.slice(0, 12)}`;
