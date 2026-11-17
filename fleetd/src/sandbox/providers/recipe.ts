// The image a hosted box starts from. There is one recipe for every sandbox: the local VM's root image Dockerfile
// (sandbox/image, with the distro, git, the pinned Bun and the libraries agents' tests need). It is a base: a local VM
// gets the node's own fleetd and the machine's claude over its file share, and a hosted box has no share, so its
// template adds the pinned Claude Code and the fleetd binary on top (`hosted`). That template is built in the team's
// own provider account with the team's key (each client's `build`); fleetd publishes no image holding Claude Code.
//
// The recipe holds one FROM, then only RUN, ENV, WORKDIR and USER, so it builds with no context files on each
// provider: E2B's build API takes those as steps, Daytona takes the Dockerfile's text, and boat (which builds no
// images) replays them on a fresh box before saving it as a snapshot.

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
    if (line.endsWith("\\")) {
      cur += `${line.slice(0, -1)}\n`;
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
  /** The fleetd release binary for linux x64 and its SHA-256. */
  fleetd: { url: string; sha256: string };
};

/** The hosted template's Dockerfile: the base recipe, then the pinned Claude Code and fleetd, for every user. */
export function hosted(base: string, pins: HostedPins): string {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(pins.claude)) throw new Error(`claude's pin ${JSON.stringify(pins.claude)} isn't a version`);
  if (!/^[0-9a-f]{64}$/.test(pins.fleetd.sha256)) throw new Error("fleetd's pin needs its SHA-256 in hex");
  if (!/^https:\/\/[^\s'"]+$/.test(pins.fleetd.url)) throw new Error("fleetd's pin needs an https URL");
  parse(base);
  return `${base.trimEnd()}

# Hosted boxes only: Claude Code and fleetd, pinned (sandbox/providers/recipe.ts).
RUN curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh \\
 && HOME=/opt/claude bash /tmp/claude-install.sh ${pins.claude} \\
 && ln -sf "$(readlink -f /opt/claude/.local/bin/claude)" /usr/local/bin/claude \\
 && chmod -R a+rX /opt/claude && rm -f /tmp/claude-install.sh \\
 && claude --version | grep -q '^${pins.claude.replaceAll(".", "\\.")} '
RUN curl -fsSL ${pins.fleetd.url} -o /usr/local/bin/fleetd \\
 && echo '${pins.fleetd.sha256}  /usr/local/bin/fleetd' | sha256sum -c - \\
 && chmod 755 /usr/local/bin/fleetd
ENV DISABLE_AUTOUPDATER=1
`;
}

/** A template's name for a recipe: the same text, the same name, so a changed pin builds a new one. */
export function templateName(dockerfile: string): string {
  return `fleetd-${new Bun.CryptoHasher("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
}
