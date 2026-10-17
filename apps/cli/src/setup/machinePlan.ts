import path from "node:path";
import type { MachineId } from "@fleetd/contracts";
import type { NodeConfig } from "@fleetd/node/config.ts";
import { gitIdentityEnv, type GitIdentity } from "./state.ts";
import { applyFleetdSettings } from "./t3Settings.ts";
import { type Platform, q, renderUnit, type Role, serviceManager, type ServiceSpec, unitPath } from "./units.ts";

/**
 * npm `t3` release installed on machines. vendor/t3/PIN (2fbd4318fc) has no published build of its own; this is the
 * newest one at or before it (nightly 3238 = commit 70d60e03a7). Move both together.
 */
export const T3_NPM_VERSION = "0.1.1-nightly.20261017.3238";
export const DEFAULT_T3_PORT = 3774;
const MIN_NODE_MAJOR = 24;

/** Where fleetd puts things on a machine, under the SSH user's home. */
export const machineLayout = (home: string) => {
  const fleetd = path.posix.join(home, ".fleetd");
  const share = path.posix.join(home, ".local", "share", "fleetd");
  return {
    fleetd,
    nodeHome: path.posix.join(fleetd, "node"),
    nodeConfig: path.posix.join(fleetd, "node", "node.json"),
    // Its own T3 home, so a T3 the user already runs on the machine (~/.t3) is never touched.
    t3Home: path.posix.join(fleetd, "t3"),
    t3Settings: path.posix.join(fleetd, "t3", "userdata", "settings.json"),
    claudeDir: path.posix.join(fleetd, "claude"),
    /** The fleetd instance's Claude login (e.g. CLAUDE_CODE_OAUTH_TOKEN=…), 0600, filled in by the user. */
    envFile: path.posix.join(fleetd, "t3.env"),
    logs: path.posix.join(fleetd, "logs"),
    cliDir: path.posix.join(share, "cli"),
    binDir: path.posix.join(share, "bin"),
    wrapper: path.posix.join(share, "bin", "fleetd"),
    npmPrefix: path.posix.join(share, "npm"),
    t3Bin: path.posix.join(share, "npm", "bin", "t3"),
    t3Package: path.posix.join(share, "npm", "lib", "node_modules", "t3", "package.json"),
  };
};
export type MachineLayout = ReturnType<typeof machineLayout>;

/** What the read-only probe reports about the machine. Files are keyed by absolute path; null when absent. */
export interface Facts {
  readonly home: string;
  readonly configHome: string;
  readonly user: string;
  readonly uid: number;
  readonly platform: string;
  readonly nodePath: string;
  readonly nodeVersion: string;
  readonly path: string;
  readonly claude: string | null;
  readonly linger: string;
  readonly files: Readonly<Record<string, string | null>>;
  /** Size in bytes, null when absent: for files whose content the probe must not read. */
  readonly sizes: Readonly<Record<string, number | null>>;
  readonly digests: Readonly<Record<string, string | null>>;
}

/** Paths the probe reads, with `{home}` and `{config}` filled in on the machine. */
export const probeSpec = (suffix: string) => {
  const l = machineLayout("{home}");
  const dirs = { home: "{home}", configHome: "{config}" };
  const units = (["t3", "node"] as const).flatMap((role) => [unitPath("linux", dirs, role, suffix), unitPath("darwin", dirs, role, suffix)]);
  return {
    // The Claude login file is only sized: the probe never reads a secret.
    read: [l.t3Settings, l.nodeConfig, l.wrapper, l.t3Package, ...units],
    size: [l.envFile],
    digest: [l.cliDir],
  };
};

/**
 * Read-only, CommonJS so any Node runs it from stdin. Prints one JSON line of Facts; a digest is a sha256 over a
 * directory's sorted relative paths and contents, the same as `bundleDigest`.
 */
export const PROBE_SCRIPT = `
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const spec = JSON.parse(process.argv[2]);
const home = os.homedir();
const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
const at = (p) => p.replaceAll("{home}", home).replaceAll("{config}", configHome);
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const which = (bin) => (process.env.PATH || "").split(":").map((d) => path.join(d, bin)).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } }) || null;
const digest = (dir) => {
  if (!fs.existsSync(dir)) return null;
  const hash = crypto.createHash("sha256");
  for (const rel of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
    const file = path.join(dir, rel);
    if (fs.statSync(file).isFile()) hash.update(rel + "\\0").update(fs.readFileSync(file)).update("\\0");
  }
  return hash.digest("hex");
};
let linger = "unknown";
if (process.platform === "linux") {
  try { linger = cp.execFileSync("loginctl", ["show-user", os.userInfo().username, "-p", "Linger", "--value"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown"; } catch {}
}
const files = {}, sizes = {}, digests = {};
for (const p of spec.read) files[at(p)] = read(at(p));
for (const p of spec.size) { try { sizes[at(p)] = fs.statSync(at(p)).size; } catch { sizes[at(p)] = null; } }
for (const p of spec.digest) digests[at(p)] = digest(at(p));
console.log(JSON.stringify({ home, configHome, user: os.userInfo().username, uid: process.getuid(), platform: process.platform,
  nodePath: process.execPath, nodeVersion: process.version, path: process.env.PATH || "", claude: which("claude"), linger, files, sizes, digests }));
`;

/** Finds a Node even where a non-interactive SSH shell's PATH lacks it (Homebrew, ~/.local), then runs the probe from stdin. */
export const probeCommand = (suffix: string) =>
  [
    `N=$(command -v node || true)`,
    `for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do [ -n "$N" ] && break; [ -x "$c" ] && N=$c; done`,
    `[ -n "$N" ] || { echo '{"error":"no-node"}'; exit 0; }`,
    `exec "$N" - ${q(JSON.stringify(probeSpec(suffix)))}`,
  ].join("; ");

export interface MachineAddInput {
  readonly machineId: MachineId;
  readonly tags: ReadonlyArray<string>;
  readonly hubUrl: string;
  readonly unitSuffix: string;
  readonly t3Port: number;
  readonly t3Version: string;
  readonly gitIdentity: GitIdentity | undefined;
  /** `bundleDigest` of the CLI bundle this hub copies to the machine. */
  readonly bundleDigest: string;
  readonly cliVersion: string;
  /** The hub already holds a node key for this machine id. */
  readonly hubHasNodeKey: boolean;
}

export type Stdin =
  | { readonly kind: "text"; readonly label: string; readonly text: string }
  | { readonly kind: "bundle" }
  | { readonly kind: "enrollToken" };

export interface Step {
  readonly title: string;
  /** POSIX shell, run on the machine as the SSH user. */
  readonly command: string;
  readonly stdin?: Stdin;
  /** The file this step writes with stdin as its content. */
  readonly writes?: string;
}

export interface MachinePlan {
  readonly platform: Platform;
  readonly layout: MachineLayout;
  readonly steps: ReadonlyArray<Step>;
  /** Things the user should know or do by hand (linger, the Claude login). */
  readonly notes: ReadonlyArray<string>;
  /** The node will (re)connect during this run, so `machine add` waits for a fresh machine.online. */
  readonly nodeRestarts: boolean;
}

const writeFile = (title: string, file: string, text: string, mode: string): Step => ({
  title,
  command: `mkdir -p ${q(path.posix.dirname(file))} && cat > ${q(`${file}.fleetd-tmp`)} && chmod ${mode} ${q(`${file}.fleetd-tmp`)} && mv ${q(`${file}.fleetd-tmp`)} ${q(file)}`,
  stdin: { kind: "text", label: path.posix.basename(file), text },
  writes: file,
});

const hasWhitespace = (value: string) => /\s/u.test(value);

/**
 * Every remote command `fleetd machine add` runs, in order, for a machine in the state `facts` describes. Steps whose
 * result is already in place are left out, so a re-run on a set-up machine only checks that both services run.
 */
export const planMachineAdd = (facts: Facts, input: MachineAddInput): MachinePlan | { readonly error: string } => {
  const major = Number(/^v(\d+)\./u.exec(facts.nodeVersion)?.[1] ?? 0);
  if (major < MIN_NODE_MAJOR) return { error: `Node ${MIN_NODE_MAJOR} or newer is needed on the machine; it has ${facts.nodeVersion} at ${facts.nodePath}` };
  if (facts.platform !== "linux" && facts.platform !== "darwin") return { error: `fleetd sets up Linux (systemd) and macOS (launchd) machines, not ${facts.platform}` };
  const platform: Platform = facts.platform;
  if (hasWhitespace(facts.home) || hasWhitespace(facts.nodePath)) {
    return { error: `the machine's home (${facts.home}) and Node path (${facts.nodePath}) must not contain spaces` };
  }

  const l = machineLayout(facts.home);
  const dirs = { home: facts.home, configHome: facts.configHome };
  const unitFile = (role: Role) => unitPath(platform, dirs, role, input.unitSuffix);
  const services = serviceManager(platform, facts.uid, input.unitSuffix, unitFile);
  const nodeDir = path.posix.dirname(facts.nodePath);
  const servicePath = [l.binDir, nodeDir, ...facts.path.split(":").filter((dir) => dir !== l.binDir && dir !== nodeDir && dir.length > 0)].join(":");
  const t3Url = `http://127.0.0.1:${input.t3Port}`;
  const common = { HOME: facts.home, PATH: servicePath, LANG: "C.UTF-8", ...gitIdentityEnv(input.gitIdentity) };

  const t3Spec: ServiceSpec = {
    role: "t3",
    suffix: input.unitSuffix,
    description: "T3 Code for fleetd",
    program: [facts.nodePath, l.t3Bin, "serve", "--base-dir", l.t3Home, "--host", "127.0.0.1", "--port", String(input.t3Port), "--no-browser"],
    env: {
      ...common,
      T3CODE_HOME: l.t3Home,
      // Every Claude process this T3 starts keeps its config apart from the user's own ~/.claude.
      CLAUDE_CONFIG_DIR: l.claudeDir,
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "2",
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_NO_BROWSER: "true",
      // Leads run `fleetd` from their shell and reach the hub through this node.
      FLEETD_NODE_SOCK: path.posix.join(l.nodeHome, "node.sock"),
    },
    envFile: l.envFile,
    workingDirectory: facts.home,
    logPath: path.posix.join(l.logs, "t3.log"),
  };
  const nodeSpec: ServiceSpec = {
    role: "node",
    suffix: input.unitSuffix,
    description: "fleetd node",
    program: [facts.nodePath, path.posix.join(l.cliDir, "bin.js"), "node", "run", "--home", l.nodeHome],
    env: common,
    workingDirectory: facts.home,
    logPath: path.posix.join(l.logs, "node.log"),
  };

  // The node runs T3's CLI with a scrubbed environment, so T3's home goes in through env(1).
  const t3Cmd = ["/usr/bin/env", `T3CODE_HOME=${l.t3Home}`, facts.nodePath, l.t3Bin];
  const t3RestartCmd = services.restartArgv("t3");
  const desiredNode: Omit<NodeConfig, "enrolled"> = {
    hub: input.hubUrl,
    machineId: input.machineId,
    name: input.machineId,
    tags: input.tags,
    t3Home: l.t3Home,
    t3Url,
    t3Cmd,
    t3RestartCmd,
  };

  const steps: Array<Step> = [];
  const notes: Array<string> = [];
  steps.push({ title: "create fleetd's directories", command: `mkdir -p ${[l.nodeHome, l.claudeDir, l.logs, l.binDir, l.npmPrefix].map(q).join(" ")} && chmod 700 ${q(l.fleetd)}` });

  const cliChanges = facts.digests[l.cliDir] !== input.bundleDigest;
  if (cliChanges) {
    const next = `${l.cliDir}.new`;
    steps.push({
      title: `install the fleetd CLI ${input.cliVersion}`,
      command: `rm -rf ${q(next)} && mkdir -p ${q(next)} && tar -xf - -C ${q(next)} && rm -rf ${q(l.cliDir)} && mv ${q(next)} ${q(l.cliDir)}`,
      stdin: { kind: "bundle" },
    });
  }
  const wrapper = `#!/bin/sh\nexec ${q(facts.nodePath)} ${q(path.posix.join(l.cliDir, "bin.js"))} "$@"\n`;
  if (facts.files[l.wrapper] !== wrapper) steps.push(writeFile("write the fleetd command", l.wrapper, wrapper, "755"));

  const installedT3 = (() => {
    try {
      return (JSON.parse(facts.files[l.t3Package] ?? "null") as { version?: string } | null)?.version;
    } catch {
      return undefined;
    }
  })();
  const t3Installs = installedT3 !== input.t3Version;
  if (t3Installs) {
    steps.push({
      title: `install T3 ${input.t3Version} from npm`,
      // npm's own shebang needs node on PATH. `t3 --version` fetches T3's verified executable into its home now, not at first start.
      command:
        `PATH=${q(nodeDir)}:"$PATH" npm_config_cache=${q(path.posix.join(facts.home, ".npm"))} ${q(path.posix.join(nodeDir, "npm"))} install --global --prefix ${q(l.npmPrefix)} --no-fund --no-audit --loglevel=error t3@${input.t3Version}` +
        ` && T3CODE_HOME=${q(l.t3Home)} ${q(facts.nodePath)} ${q(l.t3Bin)} --version`,
    });
  }

  let settings: string;
  try {
    settings = applyFleetdSettings(facts.files[l.t3Settings] ?? null, { claudeDir: l.claudeDir });
  } catch (error) {
    return { error: `${l.t3Settings} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix or remove it, then run again` };
  }
  const settingsChange = settings !== facts.files[l.t3Settings];
  if (settingsChange) steps.push(writeFile("configure the fleetd Claude instance in T3's settings", l.t3Settings, settings, "600"));
  const loginSize = facts.sizes[l.envFile] ?? null;
  if (loginSize === null) {
    steps.push({ title: "create the fleetd instance's Claude login file (empty, 0600)", command: `[ -e ${q(l.envFile)} ] || (umask 077 && : > ${q(l.envFile)})` });
  }

  const unitChanges = (["t3", "node"] as const).map((role) => {
    const text = renderUnit(platform, role === "t3" ? t3Spec : nodeSpec);
    const existing = facts.files[unitFile(role)] ?? null;
    if (existing !== text) steps.push(writeFile(`write the ${role === "t3" ? "T3" : "node"} service`, unitFile(role), text, "644"));
    return { role, changed: existing !== text, existed: existing !== null };
  });
  const [t3Unit, nodeUnit] = unitChanges as [(typeof unitChanges)[number], (typeof unitChanges)[number]];

  steps.push(
    t3Unit.changed || settingsChange || t3Installs
      ? { title: "(re)start T3", command: services.restart("t3", t3Unit.changed && t3Unit.existed) }
      : { title: "make sure T3 runs", command: services.ensureRunning("t3") },
  );
  steps.push({
    title: "wait for T3 to answer",
    command: `${q(facts.nodePath)} -e ${q(
      `const u=process.argv[1]+"/.well-known/t3/environment";const end=Date.now()+180000;(async()=>{for(;;){try{const r=await fetch(u);if(r.ok){console.log((await r.json()).serverVersion);return}}catch{}if(Date.now()>end){console.error("T3 did not answer at "+u+" within 3 min");process.exit(1)}await new Promise(r=>setTimeout(r,1000))}})()`,
    )} ${t3Url}`,
  });

  const existingNode = (() => {
    try {
      return JSON.parse(facts.files[l.nodeConfig] ?? "null") as NodeConfig | null;
    } catch {
      return null;
    }
  })();
  const enrolls = !input.hubHasNodeKey || existingNode?.enrolled !== true || existingNode.machineId !== input.machineId || existingNode.hub !== input.hubUrl;
  // Field by field, so key order in the file does not matter; cmdRoots is the user's to set and is kept.
  const owned = (c: Omit<NodeConfig, "enrolled">) => JSON.stringify([c.hub, c.machineId, c.name, c.tags, c.t3Home, c.t3Url, c.t3Cmd, c.t3RestartCmd ?? null]);
  const nodeConfigChange = !enrolls && existingNode !== null && owned(existingNode) !== owned(desiredNode);
  if (enrolls) {
    steps.push({
      title: "enroll the node with a one-time token (sent on stdin)",
      command:
        (nodeUnit.existed ? `${services.remove("node")}; ` : "") +
        [
          facts.nodePath, path.posix.join(l.cliDir, "bin.js"), "node", "join", "--hub", input.hubUrl, "--token-file", "-", "--machine", input.machineId,
          "--t3-home", l.t3Home, "--t3-url", t3Url, "--t3-cmd", t3Cmd.join(" "), "--t3-restart-cmd", t3RestartCmd.join(" "),
          ...(input.tags.length > 0 ? ["--tags", input.tags.join(",")] : []), "--home", l.nodeHome, "--enroll-only",
        ].map(q).join(" "),
      stdin: { kind: "enrollToken" },
    });
  } else if (nodeConfigChange) {
    const cmdRoots = existingNode?.cmdRoots === undefined ? {} : { cmdRoots: existingNode.cmdRoots };
    steps.push(writeFile("update the node's settings", l.nodeConfig, `${JSON.stringify({ ...desiredNode, ...cmdRoots, enrolled: true }, null, 2)}\n`, "600"));
  }
  // A new CLI is new node code: the running node keeps the old one until it restarts.
  const nodeRestarts = enrolls || nodeConfigChange || nodeUnit.changed || cliChanges;
  steps.push(
    nodeRestarts
      ? { title: "(re)start the node", command: services.restart("node", nodeUnit.changed && nodeUnit.existed) }
      : { title: "make sure the node runs", command: services.ensureRunning("node") },
  );

  if (platform === "linux" && facts.linger !== "yes") {
    notes.push(`linger is ${facts.linger} for ${facts.user}, so both services stop when ${facts.user} logs out. Have an admin run: sudo loginctl enable-linger ${facts.user}`);
  }
  if (platform === "darwin") notes.push(`launchd runs both services while ${facts.user} is logged in; keep that user logged in on this Mac.`);
  if (facts.claude === null) notes.push("no `claude` on the machine's PATH: install Claude Code there before fleetd runs turns on it.");
  if (loginSize === null || loginSize === 0) {
    notes.push(`the fleetd instance logs in from ${l.envFile} (0600): put CLAUDE_CODE_OAUTH_TOKEN=… (from \`claude setup-token\`) or ANTHROPIC_BASE_URL=… and ANTHROPIC_AUTH_TOKEN=… there, then restart T3.`);
  }
  if (input.gitIdentity === undefined) notes.push('no commit identity on the hub: run `fleetd init --git-identity "Name <id+user@users.noreply.github.com>"`, then add this machine again.');
  return { platform, layout: l, steps, notes, nodeRestarts };
};

/** A machine fleetd has never touched: what `--dry-run` plans against, since it does not connect. */
export const freshFacts = (user: string): Facts => ({
  home: `/home/${user}`,
  configHome: `/home/${user}/.config`,
  user,
  uid: 1000,
  platform: "linux",
  nodePath: "/usr/bin/node",
  nodeVersion: "v24.0.0",
  path: "/usr/local/bin:/usr/bin:/bin",
  claude: `/home/${user}/.local/bin/claude`,
  linger: "yes",
  files: {},
  sizes: {},
  digests: {},
});

/** Commands that undo `machine add`: the node always, T3 and its data only with `purgeT3`. */
export const planMachineRemove = (
  record: { readonly platform: Platform; readonly home: string; readonly configHome: string; readonly uid: number; readonly unitSuffix: string },
  purgeT3: boolean,
): ReadonlyArray<Step> => {
  const l = machineLayout(record.home);
  const unitFile = (role: Role) => unitPath(record.platform, record, role, record.unitSuffix);
  const services = serviceManager(record.platform, record.uid, record.unitSuffix, unitFile);
  const steps: Array<Step> = [
    { title: "stop and remove the node service", command: `${services.remove("node")}; rm -f ${q(unitFile("node"))}` },
    { title: "delete the node's key and settings, and the fleetd CLI", command: `rm -rf ${[l.nodeHome, l.cliDir, l.wrapper].map(q).join(" ")}` },
  ];
  if (purgeT3) {
    steps.push(
      { title: "stop and remove the T3 service", command: `${services.remove("t3")}; rm -f ${q(unitFile("t3"))}` },
      {
        title: "delete T3, its data and the fleetd Claude config",
        command: `rm -rf ${[l.t3Home, l.claudeDir, l.envFile, l.npmPrefix, l.logs].map(q).join(" ")}; rmdir ${[l.binDir, path.posix.dirname(l.binDir), l.fleetd].map(q).join(" ")} 2>/dev/null || true`,
      },
    );
  }
  if (record.platform === "linux") steps.push({ title: "forget the removed units", command: `XDG_RUNTIME_DIR=/run/user/${record.uid} systemctl --user daemon-reload` });
  return steps;
};
