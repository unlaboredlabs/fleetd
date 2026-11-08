// Every command `fleetd machine add` runs on a worker, derived from what a read-only probe found there, and the
// commands `machine remove` undoes it with (crates/fleetd/src/cli/setup/machine_plan.rs).
import type { GitIdentity } from "../common.ts";
import { sortKeys } from "../json.ts";
import type { Platform } from "./shared.ts";
import { q, renderUnit, type Role, ServiceManager, type ServiceSpec, systemdName, unitPath } from "./units.ts";

/** How a person installs claude (node/runner/claude/version.rs `INSTALL`). */
export const CLAUDE_INSTALL = ["curl -fsSL https://claude.ai/install.sh", "bash"].join(" | ");
export const CLAUDE_SUPPORTED = ">=2.1.300, <2.2.0";
export const CLAUDE_TESTED = "2.1.314";
const NODE_CONFIG_OWNED = ["hub", "machineId", "name", "claudeConfigDir"];

export type MachineLayout = {
  fleetd: string;
  nodeHome: string;
  nodeConfig: string;
  envFile: string;
  logs: string;
  binDir: string;
  bin: string;
  legacyShare: string[];
};

export const machineLayout = (home: string) => {
  const h = home.replace(/\/+$/, "");
  return machineLayoutAt(h, `${h}/.fleetd`);
};

export function machineLayoutAt(rawHome: string, rawFleetd: string): MachineLayout {
  const home = rawHome.replace(/\/+$/, "");
  const fleetd = rawFleetd.replace(/\/+$/, "");
  return {
    nodeHome: `${fleetd}/node`,
    nodeConfig: `${fleetd}/node/node.json`,
    envFile: `${fleetd}/claude.env`,
    logs: `${fleetd}/logs`,
    binDir: `${fleetd}/bin`,
    bin: `${fleetd}/bin/fleetd`,
    legacyShare: fleetd === `${home}/.fleetd` ? ["bin", "cli"].map((d) => `${home}/.local/share/fleetd/${d}`) : [],
    fleetd,
  };
}

export type Facts = {
  home: string;
  fleetd: string;
  configHome: string;
  user: string;
  uid: number;
  platform: string;
  arch: string;
  path: string;
  claude?: string;
  claudeVersion?: string;
  linger: string;
  gui: string;
  loadedUnit: string;
  files: Map<string, string>;
  sizes: Map<string, number | undefined>;
  digests: Map<string, string>;
};

export const factsLayout = (f: Facts) => (f.fleetd === "" ? machineLayout(f.home) : machineLayoutAt(f.home, f.fleetd));

/** The probe: POSIX sh only. `fleetd`: this machine's relocated fleetd dir, for `--local` only. */
export function probeCommand(fleetd?: string): string {
  const l = machineLayoutAt("$H", "$F");
  const dirs = { home: "$H", configHome: "$C" };
  const reads = [l.nodeConfig, unitPath("linux", dirs, "node"), unitPath("darwin", dirs, "node")];
  const quoted = (paths: string[]) => paths.map((p) => `"${p}"`).join(" ");
  return [
    `H=$HOME; C=\${XDG_CONFIG_HOME:-$HOME/.config}; F=${fleetd === undefined ? "$H/.fleetd" : q(fleetd)}`,
    `echo "home $H"; echo "fleetd $F"; echo "config $C"; echo "user $(id -un)"; echo "uid $(id -u)"; echo "os $(uname -s)"; echo "arch $(uname -m)"; echo "path $PATH"`,
    `CL=$(command -v claude || true); for c in "$H/.local/bin/claude" "$H/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do [ -n "$CL" ] && break; [ -x "$c" ] && CL=$c; done`,
    `if [ -n "$CL" ]; then echo "claude $CL"; echo "claude_version $("$CL" --version 2>/dev/null | head -n 1)"; fi`,
    `L=unknown; if command -v loginctl >/dev/null 2>&1; then L=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true); fi; echo "linger \${L:-unknown}"`,
    `U=; if [ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null 2>&1; then U=$(${ServiceManager.linuxCtl("$(id -u)")} show -p FragmentPath --value ${systemdName("node")} 2>/dev/null || true); fi; echo "loaded_unit $U"`,
    `G=unknown; if [ "$(uname -s)" = Darwin ]; then if launchctl print "gui/$(id -u)" >/dev/null 2>&1; then G=yes; else G=no; fi; fi; echo "gui $G"`,
    `for f in ${quoted(reads)}; do if [ -f "$f" ]; then printf 'file %s ' "$f"; base64 < "$f" | tr -d '\\n'; echo; fi; done`,
    `for f in ${quoted([l.envFile])}; do if [ -e "$f" ]; then echo "size $f $(wc -c < "$f" | tr -d ' ')"; fi; done`,
    `for f in ${quoted([l.bin])}; do if [ -f "$f" ]; then echo "digest $f $( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d ' ' -f 1)"; fi; done`,
  ].join("\n");
}

export function emptyFacts(): Facts {
  return {
    home: "",
    fleetd: "",
    configHome: "",
    user: "",
    uid: 0,
    platform: "",
    arch: "",
    path: "",
    linger: "",
    gui: "",
    loadedUnit: "",
    files: new Map(),
    sizes: new Map(),
    digests: new Map(),
  };
}

/** The probe's output. Throws the reason it can't be read. */
export function parseFacts(output: string): Facts {
  const facts = emptyFacts();
  for (const line of output.split("\n")) {
    const sp = line.indexOf(" ");
    const [key, rest] = sp < 0 ? [line, ""] : [line.slice(0, sp), line.slice(sp + 1)];
    switch (key) {
      case "home":
        facts.home = rest;
        break;
      case "fleetd":
        facts.fleetd = rest;
        break;
      case "config":
        facts.configHome = rest;
        break;
      case "user":
        facts.user = rest;
        break;
      case "uid":
        if (!/^\+?[0-9]+$/.test(rest.trim())) throw new Error(`uid '${rest}'`);
        facts.uid = Number(rest.trim());
        break;
      case "os": {
        const os = rest.trim();
        facts.platform = os === "Linux" ? "linux" : os === "Darwin" ? "darwin" : os.toLowerCase();
        break;
      }
      case "arch": {
        const a = rest.trim();
        facts.arch = a === "x86_64" || a === "amd64" ? "x64" : a === "aarch64" || a === "arm64" ? "arm64" : a;
        break;
      }
      case "path":
        facts.path = rest;
        break;
      case "claude":
        if (rest !== "") facts.claude = rest;
        break;
      case "claude_version":
        if (rest.trim() !== "") facts.claudeVersion = rest.trim();
        break;
      case "linger":
        facts.linger = rest.trim();
        break;
      case "gui":
        facts.gui = rest.trim();
        break;
      case "loaded_unit":
        facts.loadedUnit = rest.trim();
        break;
      case "file": {
        const at = rest.indexOf(" ");
        const [path, data] = at < 0 ? [rest, ""] : [rest.slice(0, at), rest.slice(at + 1)];
        facts.files.set(path, Buffer.from(data.trim(), "base64").toString("utf8"));
        break;
      }
      case "size": {
        const at = rest.lastIndexOf(" ");
        const [path, size] = at < 0 ? [rest, ""] : [rest.slice(0, at), rest.slice(at + 1)];
        facts.sizes.set(path, /^[0-9]+$/.test(size) ? Number(size) : undefined);
        break;
      }
      case "digest": {
        const at = rest.lastIndexOf(" ");
        const [path, digest] = at < 0 ? [rest, ""] : [rest.slice(0, at), rest.slice(at + 1)];
        facts.digests.set(path, digest);
        break;
      }
    }
  }
  if (facts.home === "" || facts.platform === "") throw new Error("the probe printed no home or OS");
  return facts;
}

/** The OS and architecture of the running fleetd, as the probe names them. */
export const localTarget = (): [string, string] => [process.platform === "darwin" ? "darwin" : process.platform, process.arch];

export type MachineAddInput = {
  machineId: string;
  hubUrl: string;
  gitIdentity?: GitIdentity;
  binaryDigest: string;
  binaryTarget: [string, string];
  version: string;
  hubHasNodeKey: boolean;
  service: boolean;
  claudeConfigDir?: string;
  mac: boolean;
};

export type Stdin = { kind: "text"; label: string; text: string } | { kind: "binary" } | { kind: "enrollToken" };
export type Step = { title: string; command: string; stdin?: Stdin; writes?: string };

const step = (title: string, command: string): Step => ({ title, command });

export type MachinePlan = {
  platform: Platform;
  layout: MachineLayout;
  steps: Step[];
  notes: string[];
  nodeRestarts: boolean;
  runByHand?: string;
};

const dirname = (p: string) => {
  const at = p.lastIndexOf("/");
  return at < 0 ? "." : at === 0 ? "/" : p.slice(0, at);
};
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function writeCommand(file: string, mode: string): string {
  const tmp = q(`${file}.fleetd-tmp`);
  return `mkdir -p ${q(dirname(file))} && cat > ${tmp} && chmod ${mode} ${tmp} && mv ${tmp} ${q(file)}`;
}

const writeFile = (title: string, file: string, text: string, mode: string): Step => ({
  title,
  command: writeCommand(file, mode),
  stdin: { kind: "text", label: basename(file), text },
  writes: file,
});

export const noGuiSession = (user: string, terminal: boolean) =>
  `${user} isn't logged in on this Mac's screen, and launchd runs fleetd's node only inside that login (su and ssh don't make one). Fix: log in as ${user} at the Mac (Apple menu › Lock Screen, then pick ${user}; or over Screen Sharing)${terminal ? ", open Terminal there" : ""}`;

export const guiSessionProblem = (facts: Facts, service: boolean, terminal: boolean) =>
  service && facts.platform === "darwin" && facts.gui === "no" ? noGuiSession(facts.user, terminal) : undefined;

export const stepNeedsGuiSession = (platform: Platform, code: number) => platform === "darwin" && code === 125;

type Verdict = "ok" | "older" | "newer" | "unreadable";

/** `claude --version`'s output against the range fleetd is tested with. */
export function claudeVerdict(printed: string): Verdict {
  const word = printed.split(/\s+/).filter(Boolean)[0];
  const core = word?.replace(/^v/, "").split(/[-+]/)[0];
  const parts = core?.split(".");
  if (!parts || parts.length !== 3 || !parts.every((p) => /^\+?[0-9]+$/.test(p))) return "unreadable";
  const [a, b, c] = parts.map(Number) as [number, number, number];
  const cmp = (x: [number, number, number]) => a - x[0] || b - x[1] || c - x[2];
  if (cmp([2, 1, 300]) < 0) return "older";
  if (cmp([2, 2, 0]) >= 0) return "newer";
  return "ok";
}

export function verdictProblem(v: Verdict, raw: string): string {
  const found = raw.trim();
  if (v === "older") {
    return `claude ${found} is older than fleetd is tested with (${CLAUDE_SUPPORTED}); sessions run, and fleetd checks its protocol at every start.`;
  }
  if (v === "newer") {
    return `claude ${found} is newer than fleetd is tested with (${CLAUDE_SUPPORTED}); sessions run, and if they misbehave, pin the tested version.`;
  }
  if (v === "unreadable") {
    return `\`claude --version\` printed ${JSON.stringify(found)}, which fleetd can't read as a version; sessions run, and fleetd checks its protocol at every start.`;
  }
  return "";
}

export function verdictFix(v: Verdict): string {
  if (v === "older") return "claude update";
  if (v === "newer") return `claude install ${CLAUDE_TESTED}`;
  if (v === "unreadable") return `${CLAUDE_INSTALL} -s ${CLAUDE_TESTED}`;
  return "";
}

const gitIdentityEnv = (id?: GitIdentity): [string, string][] =>
  id === undefined
    ? []
    : [
        ["GIT_AUTHOR_NAME", id.name],
        ["GIT_AUTHOR_EMAIL", id.email],
        ["GIT_COMMITTER_NAME", id.name],
        ["GIT_COMMITTER_EMAIL", id.email],
      ];

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Every command `machine add` runs, in order. Throws the reason it can't plan. */
export function planMachineAdd(facts: Facts, input: MachineAddInput): MachinePlan {
  if (facts.platform !== "linux" && facts.platform !== "darwin") {
    throw new Error(`fleetd sets up Linux (systemd) and macOS (launchd) machines, not ${facts.platform}`);
  }
  const platform: Platform = facts.platform;
  const [os, arch] = input.binaryTarget;
  if (facts.platform !== os || facts.arch !== arch) {
    throw new Error(
      facts.platform === "linux" && facts.arch === "arm64"
        ? "the machine is linux-arm64, and fleetd has no Linux ARM build yet"
        : `the machine is ${facts.platform}-${facts.arch} and this fleetd is a ${os}-${arch} build: fleetd has builds for Linux on x64 and macOS on x64 and arm64 only`,
    );
  }
  if (/\s/.test(facts.home)) throw new Error(`the machine's home (${facts.home}) must not contain spaces`);
  const claude = input.mac ? undefined : facts.claude;
  if (!input.mac && claude === undefined) {
    throw new Error(
      `claude is not installed on the machine; fleetd runs its agents through it. Fix: on the machine, run ${CLAUDE_INSTALL}`,
    );
  }
  const printed = facts.claudeVersion ?? "";
  const verdict: Verdict = claude === undefined ? "ok" : claudeVerdict(printed);
  const l = factsLayout(facts);
  const dirs = { home: facts.home, configHome: facts.configHome };
  const unitFile = (role: Role) => unitPath(platform, dirs, role);
  const services = new ServiceManager(platform, facts.uid, unitFile);
  const pathDirs = [l.binDir, claude !== undefined ? dirname(claude) : `${l.nodeHome}/mac/node/bin`];
  for (const d of facts.path.split(":")) if (d !== "" && !pathDirs.includes(d)) pathDirs.push(d);
  const env: [string, string][] = [
    ["HOME", facts.home],
    ["PATH", pathDirs.join(":")],
    ["LANG", "C.UTF-8"],
    ...gitIdentityEnv(input.gitIdentity),
  ];
  const nodeSpec: ServiceSpec = {
    role: "node",
    description: "fleetd node",
    program: [l.bin, "node", "run", "--home", l.nodeHome],
    env,
    workingDirectory: facts.home,
    logPath: `${l.logs}/node.log`,
  };
  const steps: Step[] = [];
  const notes: string[] = [];
  steps.push(
    step("create fleetd's directories", `mkdir -p ${[l.nodeHome, l.logs, l.binDir].map(q).join(" ")} && chmod 700 ${q(l.fleetd)}`),
  );
  const binaryChanges = facts.digests.get(l.bin) !== input.binaryDigest;
  if (binaryChanges) {
    let command = writeCommand(l.bin, "755");
    if (l.legacyShare.length > 0) command += ` && rm -rf ${l.legacyShare.map(q).join(" ")}`;
    steps.push({ title: `install fleetd ${input.version}`, command, stdin: { kind: "binary" } });
  }
  const text = renderUnit(platform, nodeSpec);
  const existingUnit = facts.files.get(unitFile("node"));
  if (
    input.service &&
    l.fleetd !== machineLayout(facts.home).fleetd &&
    existingUnit !== undefined &&
    !existingUnit.includes(l.nodeHome)
  ) {
    throw new Error(`the ${basename(unitFile("node"))} service on this machine runs another fleet's node. Fix: pass --no-service`);
  }
  if (input.service && facts.loadedUnit !== "" && facts.loadedUnit !== unitFile("node")) {
    throw new Error(
      `this user's systemd manager runs ${systemdName("node")} from ${facts.loadedUnit}, another fleetd's node, not from this home (${facts.home}); nothing was changed. Fix: run this from that home, or pass --no-service and start the node by hand`,
    );
  }
  const nodeChanged = input.service && existingUnit !== text;
  const nodeExisted = input.service && existingUnit !== undefined;
  if (nodeChanged) steps.push(writeFile("write the node service", unitFile("node"), text, "644"));
  let existingNode: Record<string, unknown> | undefined;
  const nodeText = facts.files.get(l.nodeConfig);
  if (nodeText !== undefined) {
    try {
      const parsed = JSON.parse(nodeText);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) existingNode = parsed;
    } catch {}
  }
  const get = (k: string) => existingNode?.[k];
  const configDir = input.claudeConfigDir ?? get("claudeConfigDir") ?? null;
  const desired: Record<string, unknown> = {
    hub: input.hubUrl,
    machineId: input.machineId,
    name: input.machineId,
    claudeConfigDir: configDir,
  };
  const enrolled = get("enrolled") === true && same(get("machineId"), desired.machineId) && same(get("hub"), desired.hub);
  const enrolls = !input.hubHasNodeKey || !enrolled;
  const configChange = !enrolls && NODE_CONFIG_OWNED.some((k) => !same(get(k), desired[k]));
  if (enrolls) {
    const argv = [l.bin, "node", "join", "--hub", input.hubUrl, "--token-file", "-", "--machine", input.machineId];
    if (typeof desired.claudeConfigDir === "string") argv.push("--claude-config-dir", desired.claudeConfigDir);
    if (input.mac) argv.push("--mac");
    argv.push("--home", l.nodeHome, "--enroll-only");
    const [config, kept] = [q(l.nodeConfig), q(`${l.nodeConfig}.before-join`)];
    const [keep, putBack] =
      existingNode !== undefined ? [`cp -p ${config} ${kept}; `, `mv -f ${kept} ${config}; `] : ["", ""];
    const [stopFirst, startAgain] = nodeExisted
      ? [`${services.remove("node")}; `, `${services.restart("node", nodeChanged)}; `]
      : ["", ""];
    const join = argv.map(q).join(" ");
    steps.push({
      title: "enroll the node with a one-time token (sent on stdin)",
      command: `${keep}${stopFirst}if ${join}; then rm -f ${kept}; else code=$?; ${putBack}${startAgain}exit $code; fi`,
      stdin: { kind: "enrollToken" },
    });
  } else if (configChange) {
    const config: Record<string, unknown> = { ...(existingNode ?? {}) };
    for (const k of NODE_CONFIG_OWNED) if (desired[k] !== null && desired[k] !== undefined) config[k] = desired[k];
    steps.push(writeFile("update the node's settings", l.nodeConfig, `${JSON.stringify(sortKeys(config), null, 2)}\n`, "600"));
  }
  const nodeRestarts = input.service && (enrolls || configChange || nodeChanged || binaryChanges);
  const runByHand = input.service
    ? undefined
    : `${env
        .filter(([k]) => k.startsWith("GIT_"))
        .map(([k, v]) => `${k}=${q(v)}`)
        .join(" ")} ${q(l.bin)} node run --home ${q(l.nodeHome)}`.trimStart();
  if (input.service) {
    steps.push(
      nodeRestarts
        ? step("(re)start the node", services.restart("node", nodeChanged && nodeExisted))
        : step("make sure the node runs", services.ensureRunning("node")),
    );
  }
  if (verdict !== "ok") {
    notes.push(`${verdictProblem(verdict, printed)} If sessions misbehave, run on the machine: ${verdictFix(verdict)}`);
  }
  if (input.service && platform === "linux" && facts.linger !== "yes") {
    notes.push(
      `linger is ${facts.linger} for ${facts.user}, so the node stops when ${facts.user} logs out. Fix: sudo loginctl enable-linger ${facts.user}`,
    );
  }
  if (platform === "darwin") {
    notes.push(`launchd runs the node while ${facts.user} is logged in at this Mac's screen; after a restart, log that user in again.`);
  }
  if (input.gitIdentity === undefined) {
    notes.push(
      `no commit identity for this machine's agents. Fix: on the hub, fleetd init --git-identity "Name <id+user@users.noreply.github.com>", then add this machine again; a machine joining by itself gets it in the line fleetd pair --worker prints.`,
    );
  }
  return { platform, layout: l, steps, notes, nodeRestarts, ...(runByHand === undefined ? {} : { runByHand }) };
}

/** Whether claude is logged in on the machine, asked as the node runs it; prints `claude auth status --json`. */
export function loginStatusCommand(l: MachineLayout, claude: string, configDir?: string): string {
  const dir = configDir === undefined ? "" : `CLAUDE_CONFIG_DIR=${q(configDir)} `;
  const inner = `set -a; [ -f ${q(l.envFile)} ] && . ${q(l.envFile)}; set +a; ${dir}exec ${q(claude)} auth status --json`;
  return `env -i HOME="$HOME" PATH="$PATH" USER="$USER" LANG=C.UTF-8 /bin/sh -c ${q(inner)}`;
}

export const loginCommand = (claude: string, configDir?: string) =>
  configDir === undefined ? `${q(claude)} auth login` : `CLAUDE_CONFIG_DIR=${q(configDir)} ${q(claude)} auth login`;

/** A machine fleetd has never touched: what `--dry-run` plans against. */
export function freshFacts(user: string, arch: string): Facts {
  return {
    ...emptyFacts(),
    home: `/home/${user}`,
    configHome: `/home/${user}/.config`,
    user,
    uid: 1000,
    platform: "linux",
    arch,
    path: "/usr/local/bin:/usr/bin:/bin",
    claude: `/home/${user}/.local/bin/claude`,
    claudeVersion: `${CLAUDE_TESTED} (Claude Code)`,
    linger: "yes",
  };
}

/** Commands that undo `machine add`. */
export function planMachineRemove(
  platform: Platform,
  home: string,
  fleetd: string | undefined,
  configHome: string,
  uid: number,
  ownService: boolean,
  purge: boolean,
): Step[] {
  const l = fleetd === undefined ? machineLayout(home) : machineLayoutAt(home, fleetd);
  const unitFile = (role: Role) => unitPath(platform, { home, configHome }, role);
  const services = new ServiceManager(platform, uid, unitFile);
  const steps: Step[] = [];
  if (ownService) {
    steps.push(step("stop and remove the node service", `${services.remove("node")}; rm -f ${q(unitFile("node"))}`));
    const hosts = `${l.nodeHome}/hosts`;
    steps.push(
      step(
        "stop the agents the node left running",
        `if [ -d ${q(hosts)} ]; then ${q(l.bin)} session-host stop-all ${q(hosts)} || true; fi`,
      ),
    );
  }
  if (purge) {
    steps.push(
      step(
        "delete the node's key and settings, its claude.env and its logs",
        `rm -rf ${[l.nodeHome, l.envFile, l.logs, ...l.legacyShare].map(q).join(" ")}`,
      ),
    );
  }
  if (platform === "linux") {
    steps.push(step("forget the removed units", `XDG_RUNTIME_DIR=/run/user/${uid} systemctl --user daemon-reload`));
  }
  return steps;
}
