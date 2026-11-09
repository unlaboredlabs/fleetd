// Each doctor check as a pure function of what the hub read: a status, a plain message, and at most one fix, a
// command for a person to run (crates/fleetd/src/hub/doctor/checks.rs), with the same ids and words.
import type {
  ClaudeHubApi,
  ClaudeSealedOn,
  ClaudeSubscription,
  ClaudeTest,
  CloudKeyTest,
  CloudMachineState,
  CloudPathTest,
  DoctorCheck,
  DoctorFix,
  DoctorStatus,
  GithubApp,
  OnePasswordTest,
} from "../../shared/contracts.ts";
import type { MacHealth, NodeDisk, NodeProbe, ScreenHealth } from "../../shared/node_link.ts";
import type { RunnerInfo, WorktreeBase } from "../../shared/sessions.ts";
import { doctorAlert, fetchFailedText, fixLabel, start } from "./base.ts";
import { addCommand, type HubSetup, type MachineSetup, restartCommand } from "./config.ts";
import { guide } from "./guide.ts";

/** 1Password's service accounts page, where a new one is made and the old one revoked (hub/setup ONEPASSWORD_ACCOUNTS). */
export const ONEPASSWORD_ACCOUNTS = "https://start.1password.com/developer-tools/active";

/** At most `max` characters, the last one an ellipsis when cut (hub/usage/time.rs `clip`). */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : text;
}

function manual(label: string, command?: string): DoctorFix {
  return { kind: "manual", label: clip(label, 200), ...(command === undefined ? {} : { command }) };
}

/** A fix whose command runs on the hub's machine, though its check is a machine's. */
const onHub = (fix: DoctorFix): DoctorFix => ({ ...fix, on: "hub" });

/** The fix with where its command runs: where the fix says, else where its check is. */
function placed(fix: DoctorFix | undefined, scope: "hub" | "machine"): DoctorFix | undefined {
  if (!fix) return undefined;
  return fix.command !== undefined && fix.on === undefined ? { ...fix, on: scope } : fix;
}

function hubEntry(name: string, status: DoctorStatus, message: string, fix?: DoctorFix): DoctorCheck {
  const f = placed(fix, "hub");
  return { id: `hub/${name}`, scope: "hub", status, message: clip(message, 500), ...(f ? { fix: f } : {}) };
}

function machineEntry(machineId: string, name: string, status: DoctorStatus, message: string, fix?: DoctorFix): DoctorCheck {
  const f = placed(fix, "machine");
  return {
    id: `${machineId}/${name}`,
    scope: "machine",
    machineId,
    status,
    message: clip(message, 500),
    ...(f ? { fix: f } : {}),
  };
}

const trimDots = (s: string) => s.replace(/\.+$/, "");

// Hub checks

/** A probe of a URL: ok, or why it failed ("ECONNREFUSED", "TimeoutError", "HTTP 502"). */
export type Probe = { ok: true } | { ok: false; why: string };

export function hubReachable(url: string, probe: Probe, restart: string): DoctorCheck {
  return probe.ok
    ? hubEntry("reachable", "ok", `The hub answers at ${url}.`)
    : hubEntry(
        "reachable",
        "fail",
        `The hub does not answer at its own address ${url} (${probe.why}).`,
        manual("Restart the hub service", restart),
      );
}

/** A finished command, or why it could not start (`ENOENT` when the binary is missing). */
export type CmdOutcome = { ran: true; exitCode: number; stdout: string; stderr: string } | { ran: false; error: string };

export function ghAuth(outcome: CmdOutcome): DoctorCheck {
  if (!outcome.ran) {
    if (outcome.error === "ENOENT") {
      return hubEntry(
        "gh_auth",
        "fail",
        "The GitHub CLI (gh) is not installed on the hub; the merge train and PR checks need it.",
        manual("Install gh (https://cli.github.com), then log in", "gh auth login"),
      );
    }
    return hubEntry("gh_auth", "unknown", `Could not run gh on the hub: ${outcome.error}`);
  }
  if (outcome.exitCode !== 0) {
    return hubEntry(
      "gh_auth",
      "fail",
      "gh is not logged in on the hub; the merge train and PR checks need it until the hub has its GitHub App.",
      manual(
        "Log gh in on the hub machine, or create the hub's GitHub App in Settings › Hub accounts › GitHub",
        "gh auth login",
      ),
    );
  }
  const account = /account (\S+)/.exec(`${outcome.stdout}\n${outcome.stderr}`);
  return account
    ? hubEntry("gh_auth", "ok", `gh is logged in on the hub as ${account[1]}.`)
    : hubEntry("gh_auth", "ok", "gh is logged in on the hub.");
}

/** Repos whose ready PRs wait because they have no CI: fleetd merges only on green CI, so they wait until it exists. */
export function repoCi(withoutCi: string[]): DoctorCheck {
  if (withoutCi.length === 0) return hubEntry("repo_ci", "ok", "Every repo with a PR ready to merge has CI.");
  const repos = withoutCi.join(", ");
  return hubEntry(
    "repo_ci",
    "fail",
    `No CI on ${repos}: fleetd merges only on green CI, so their ready PRs wait.`,
    manual(`Add a GitHub Actions workflow that runs on pull requests to ${repos}`),
  );
}

/** What the hub's pool says of itself, for the `hub/cloud_*` checks. */
export type CloudFacts = {
  enabled: boolean;
  poolSize: number;
  /** What boat last said to the key: the admin's Test or a sweep. */
  keyTest?: CloudKeyTest;
  /** A billing or key pause: its kind and line. */
  paused?: [kind: string, line: string];
  /** The admin's last Test of the whole way from a cloud machine to the hub. */
  pathTest?: CloudPathTest;
  /** Each slot made: its id, state and note. */
  machines: [id: string, state: CloudMachineState, note?: string][];
  /** "Today $0.41 of $3.00 · this month $6.10 of $20.00". */
  spend: string;
  /** Why a budget holds starts back, when one does. */
  over?: string;
};

/** What the hub keeps of its optional setup: each check below is there only once its step is set up. */
export type SetupFacts = {
  /** Who joined after the hub's first person, by name. */
  joined: string[];
  /** The hub's own GitHub App (D190), as the hub keeps it. */
  githubApp?: GithubApp;
  /** Cloud machines (D306), once a boat.dev key is saved. */
  cloud?: CloudFacts;
  /** Each person's saved 1Password token (D235), by their name, with its last Test. */
  onepassword: [name: string, test?: OnePasswordTest][];
  /** The vault's root key (W549), as the hub loaded it. */
  vault?: VaultKeyFacts;
};

/** What `hub/vault_key` reads. */
export type VaultKeyFacts = {
  mode: "file" | "keyring" | "passphrase";
  path: string;
  locked: boolean;
  /** Why the key didn't load; absent when it did. */
  problem?: string;
  /** File or directory permissions open to other users. */
  unsafe: string[];
  recoverySaved: boolean;
};

/**
 * `hub/vault_key`: the vault's root key loaded from outside the hub's home, with safe permissions, opening what it
 * sealed; and its recovery code saved somewhere.
 */
export function vaultKey(f: VaultKeyFacts): DoctorCheck {
  if (f.unsafe.length > 0) {
    return hubEntry("vault_key", "fail", `The vault key is open to other users: ${f.unsafe.join("; ")}.`, manual(`run chmod 700 on its folder and chmod 600 on ${f.path}`));
  }
  if (f.problem !== undefined) {
    return hubEntry("vault_key", "fail", `The vault key didn't load: ${trimDots(f.problem)}.`, manual("re-enter the recovery code with `fleetd vault restore-key` on the hub"));
  }
  if (f.locked) {
    return hubEntry("vault_key", "warn", "The vault is locked until an owner or admin unlocks it with its passphrase: fills wait, variables already delivered keep working.", manual("unlock it in Settings › You › Vault"));
  }
  const where = f.mode === "file" ? `a file on this machine (${f.path})` : f.mode === "keyring" ? "this machine's keychain" : "a passphrase-locked file";
  if (!f.recoverySaved) {
    return hubEntry("vault_key", "warn", `The vault key is in ${where}, and its recovery code isn't saved yet: without both, cards and logins can't be opened again.`, manual("run `fleetd vault recovery-code` on the hub and keep the code somewhere safe"));
  }
  return hubEntry("vault_key", "ok", `The vault key is in ${where}; its recovery code is saved.`);
}

/** The setup checks the hub reads from its own state: someone else joined, the GitHub App. */
export function setupChecks(facts: SetupFacts): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const j = facts.joined;
  const joined =
    j.length === 0
      ? undefined
      : j.length === 1
        ? `${j[0]} has joined.`
        : j.length === 2
          ? `${j[0]} and ${j[1]} have joined.`
          : `${j[0]} and ${j.length - 1} others have joined.`;
  if (joined !== undefined) out.push(hubEntry("people", "ok", joined));
  if (facts.githubApp) out.push(githubApp(facts.githubApp));
  if (facts.cloud) out.push(...cloudChecks(facts.cloud));
  const vault = onepasswordVault(facts.onepassword);
  if (vault) out.push(vault);
  if (facts.vault) out.push(vaultKey(facts.vault));
  return out;
}

const RANK: Record<DoctorStatus, number> = { ok: 0, unknown: 1, warn: 2, fail: 3 };

/**
 * `hub/onepassword_vault`: each saved 1Password service account reads exactly one vault, kept for fleetd. Read from
 * each token's last Test; the worst token decides, and every token as bad is named.
 */
export function onepasswordVault(tokens: [string, OnePasswordTest?][]): DoctorCheck | undefined {
  const page = "Settings › Your accounts › 1Password";
  const oneVault = (name: string) =>
    manual(
      `${name} makes a service account for only fleetd's vault (${ONEPASSWORD_ACCOUNTS}), pastes its token in ${page} and revokes the old one`,
    );
  const read: [DoctorStatus, string, DoctorFix | undefined][] = tokens.map(([name, t]) => {
    if (!t) {
      return ["unknown", `${name}'s 1Password token is saved but not tested yet.`, manual(`${name} presses Test in ${page}`)];
    }
    if (!t.ok) {
      const said = trimDots(t.error ?? "1Password said nothing");
      return [
        "fail",
        `${name}'s 1Password token failed its Test on ${t.machineId}: ${said}.`,
        manual(`${name} checks the service account in 1Password, then pastes its token again in ${page}`),
      ];
    }
    const vaults = t.vaults ?? [];
    if (vaults.length === 0) {
      return ["warn", `${name}'s 1Password token reads no vault, so nothing can be imported from it.`, oneVault(name)];
    }
    if (vaults.length === 1) return ["ok", `${name}'s 1Password token reads one vault, ${vaults[0]}.`, undefined];
    return [
      "warn",
      `${name}'s 1Password token reads ${vaults.length} vaults (${vaults.join(", ")}): an agent on a machine holding it could read every item in each. Keep it to one vault with only what fleetd needs.`,
      oneVault(name),
    ];
  });
  if (read.length === 0) return undefined;
  // max_by_key keeps the last of equals; equal statuses are the same status, so any of them does.
  const worst = read.map(([s]) => s).reduce((a, b) => (RANK[b] >= RANK[a] ? b : a));
  const said = read.filter(([s]) => s === worst).map(([, line]) => line);
  const fix = read.find(([s]) => s === worst)?.[2];
  return hubEntry("onepassword_vault", worst, said.join(" "), fix);
}

/** `hub/cloud_key`, `hub/cloud_network`, `hub/cloud_machines` and `hub/cloud_budget`, once a boat.dev key is saved. */
export function cloudChecks(f: CloudFacts): DoctorCheck[] {
  const fix = (what: string) => manual(what);
  let key: DoctorCheck;
  if (f.paused && f.paused[0] === "key") {
    key = hubEntry(
      "cloud_key",
      "fail",
      f.paused[1],
      fix("Paste a new boat.dev key in Settings › Hub › Machines › Cloud machines, then Test"),
    );
  } else if (f.keyTest && !f.keyTest.ok) {
    key = hubEntry("cloud_key", "fail", f.keyTest.said, fix("Check the key's actions and scope on boat.dev, then Test"));
  } else if (f.keyTest) {
    key = hubEntry("cloud_key", "ok", f.keyTest.said);
  } else {
    key = hubEntry(
      "cloud_key",
      "unknown",
      "A boat.dev key is saved. Test asks boat.dev what it may read.",
      fix("Test it in Settings › Hub › Machines › Cloud machines"),
    );
  }
  // The hub dials each machine and holds an SSH tunnel its node reaches the hub through: no address to set up.
  const joined = f.machines.some(([, s]) => s === "awake" || s === "asleep" || s === "stopping");
  const t = f.pathTest;
  let network: DoctorCheck;
  if (t && t.ok === false) {
    network = hubEntry(
      "cloud_network",
      "fail",
      t.said,
      fix("Fix what it names, then Test again in Settings › Hub › Machines › Cloud machines"),
    );
  } else if (t && (t.ok === undefined || t.ok === null)) {
    network = hubEntry("cloud_network", "unknown", t.said);
  } else if (t) {
    network = hubEntry("cloud_network", "ok", t.said);
  } else if (joined) {
    network = hubEntry(
      "cloud_network",
      "ok",
      "Cloud machines reach the hub through the SSH tunnel the hub opens to each: the hub needs no public address.",
    );
  } else {
    network = hubEntry(
      "cloud_network",
      "unknown",
      "Not tried yet: Test wakes (or makes) a cloud machine and checks the hub's tunnel to it and its node's hello.",
      fix("Turn cloud machines on, then Test in Settings › Hub › Machines › Cloud machines"),
    );
  }
  const made = f.machines.filter(([, s]) => s !== "gone");
  const named = (states: CloudMachineState[]) =>
    f.machines.filter(([, s]) => states.includes(s)).map(([id, , note]) => (note ? `${id} (${note})` : id));
  const broken = named(["broken"]);
  const failed = named(["failed", "gone"]);
  const creating = named(["creating"]);
  const count = (s: CloudMachineState) => f.machines.filter(([, st]) => st === s).length;
  let machines: DoctorCheck;
  if (broken.length > 0) {
    machines = hubEntry(
      "cloud_machines",
      "fail",
      `${broken.join(", ")} didn't come back from two wakes in a row, so the hub won't wake it again.`,
      fix("Reset it in Settings › Hub › Machines › Cloud machines"),
    );
  } else if (failed.length > 0) {
    machines = hubEntry(
      "cloud_machines",
      "warn",
      `Not made: ${failed.join(", ")}.`,
      fix("Create cloud machines again in Settings › Hub › Machines"),
    );
  } else if (made.length === 0) {
    machines = hubEntry(
      "cloud_machines",
      "unknown",
      "No cloud machines yet.",
      fix("Turn them on and create them in Settings › Hub › Machines › Cloud machines"),
    );
  } else if (creating.length > 0) {
    machines = hubEntry("cloud_machines", "unknown", `Setting up: ${creating.join(", ")}. Each joins in a few minutes.`);
  } else if (made.length < f.poolSize) {
    machines = hubEntry(
      "cloud_machines",
      "unknown",
      `${made.length} of ${f.poolSize} cloud machines made.`,
      fix("Create the rest in Settings › Hub › Machines › Cloud machines"),
    );
  } else if (!f.enabled) {
    machines = hubEntry(
      "cloud_machines",
      "warn",
      "Cloud machines are off: no work goes to them.",
      fix("Turn them on in Settings › Hub › Machines › Cloud machines"),
    );
  } else {
    const awake = count("awake") + count("waking");
    machines = hubEntry(
      "cloud_machines",
      "ok",
      `${made.length} cloud ${made.length === 1 ? "machine" : "machines"}: ${awake} awake, ${made.length - awake} asleep.`,
    );
  }
  let budget: DoctorCheck;
  if (f.paused && f.paused[0] === "billing") {
    budget = hubEntry(
      "cloud_budget",
      "fail",
      f.paused[1],
      fix("Settle billing on boat.dev, then Resume in Settings › Hub › Machines"),
    );
  } else if (f.over !== undefined) {
    budget = hubEntry(
      "cloud_budget",
      "warn",
      `${f.over}. ${f.spend}.`,
      fix("Raise the budget in Settings › Hub › Machines › Cloud machines, or wait for the next day"),
    );
  } else {
    budget = hubEntry("cloud_budget", "ok", `${f.spend}.`);
  }
  return [key, network, machines, budget];
}

/** `hub/github_app`: the hub's own GitHub App, installed somewhere, and what its last Test said. */
export function githubApp(app: GithubApp): DoctorCheck {
  const fix = (what: string) => manual(what, "fleetd github-app test");
  const installations = app.installations ?? [];
  if (installations.length === 0) {
    return hubEntry(
      "github_app",
      "warn",
      `The hub's GitHub App "${app.name}" isn't installed on any repository yet.`,
      fix("Install it on Settings › Hub accounts › GitHub, then Test"),
    );
  }
  const t = app.lastTest;
  if (t && !t.ok) return hubEntry("github_app", "fail", t.said, fix("Check it on Settings › Hub accounts › GitHub, then Test"));
  if (t) return hubEntry("github_app", "ok", t.said);
  const places = installations.map((i) => i.account);
  return hubEntry("github_app", "ok", `The hub's GitHub App "${app.name}" is installed on ${places.join(", ")}.`);
}

function ipv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && (p === "0" || !p.startsWith("0")))) {
    return undefined;
  }
  return parts.map(Number);
}

/** The eight segments of an IPv6 address (an IPv4 tail as its last two), or undefined when it isn't one. */
function ipv6(host: string): number[] | undefined {
  if (!host.includes(":")) return undefined;
  let text = host;
  const tail: number[] = [];
  const dot = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dot) {
    const four = ipv4(dot[2] ?? "");
    if (!four) return undefined;
    tail.push((four[0]! << 8) | four[1]!, (four[2]! << 8) | four[3]!);
    text = dot[1]!.endsWith("::") ? dot[1]! : dot[1]!.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const read = (s: string) => {
    const parts = s === "" ? [] : s.split(":");
    return parts.every((p) => /^[0-9a-f]{1,4}$/.test(p)) ? parts.map((p) => parseInt(p, 16)) : undefined;
  };
  const head = read(halves[0] ?? "");
  const rest = halves.length === 2 ? read(halves[1] ?? "") : [];
  if (!head || !rest) return undefined;
  const fill = 8 - head.length - rest.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  return [...head, ...Array<number>(fill).fill(0), ...rest, ...tail];
}

/**
 * Why plain HTTP to `url` is safe, if it is: loopback never leaves the machine, and a tailnet address (100.64.0.0/10,
 * fd7a:115c:a1e0::/48 or a *.ts.net name) travels inside Tailscale's WireGuard tunnel.
 */
export function sealedHttp(url: string): string | undefined {
  const scheme = url.indexOf("://");
  const rest = scheme < 0 ? url : url.slice(scheme + 3);
  const authority = rest.split("/")[0] ?? "";
  const colon = authority.lastIndexOf(":");
  let host = authority;
  if (colon >= 0 && /^\d*$/.test(authority.slice(colon + 1))) host = authority.slice(0, colon);
  host = host.replace(/^[[\]]+|[[\]]+$/g, "").toLowerCase();
  const tailnet = "it stays inside your tailnet's encrypted tunnel";
  const local = "it never leaves this machine";
  const v4 = ipv4(host);
  if (v4) {
    if (v4[0] === 127) return local;
    return v4[0] === 100 && v4[1]! >= 64 && v4[1]! < 128 ? tailnet : undefined;
  }
  const v6 = ipv6(host);
  if (v6) {
    if (v6.every((s, i) => s === (i === 7 ? 1 : 0))) return local;
    return v6[0] === 0xfd7a && v6[1] === 0x115c && v6[2] === 0xa1e0 ? tailnet : undefined;
  }
  if (host === "localhost") return local;
  return host.endsWith(".ts.net") ? tailnet : undefined;
}

export function httpsReachable(config: HubSetup, problem: string | undefined, port: number, probe?: Probe): DoctorCheck {
  const serve = () =>
    manual(
      "Serve the hub over HTTPS (Tailscale Serve shown), then stop the hub and run fleetd init --url https://<that address>",
      `tailscale serve --bg ${port}`,
    );
  if (problem !== undefined) return hubEntry("https", "warn", problem, serve());
  const url = config.url;
  if (url === undefined) {
    return hubEntry(
      "https",
      "warn",
      "The hub has no address set up (fleetd init --url), so the desktop app and other machines cannot reach it over HTTPS.",
      serve(),
    );
  }
  if (!url.startsWith("https://")) {
    const why = sealedHttp(url);
    if (why !== undefined) return hubEntry("https", "ok", `The hub's address ${url} is plain HTTP, which is fine: ${why}.`);
    return hubEntry(
      "https",
      "warn",
      `The hub's address ${url} is not HTTPS; keys from the desktop app and other machines would cross the network unencrypted.`,
      serve(),
    );
  }
  if (!probe || probe.ok) return hubEntry("https", "ok", `The hub is reachable over HTTPS at ${url}.`);
  return hubEntry(
    "https",
    "fail",
    `${url} does not answer (${probe.why}).`,
    manual("Check that HTTPS still points at the hub", "tailscale serve status"),
  );
}

// Machine checks

/** The fields of `Machine` the checks read. */
export type MachineView = {
  machineId: string;
  /** "online", "degraded" or "offline". */
  status: string;
  lastSeenAt: string;
  degradedReason?: string;
  /** The agents' Mac, as its last hello said: it runs no claude, so its own checks stand in for the runner's. */
  agentsMac?: boolean;
};

/**
 * The one fix for a machine whose runner is unusable, from the cause its probe reports: the runner missing, a
 * protocol break, logged out. Two causes at once become one ordered sentence; undefined when it reports no cause.
 */
export function runnerFix(machineId: string, info: RunnerInfo): DoctorFix | undefined {
  const name = guide.name;
  const install: [string, string] | undefined =
    info.version === undefined
      ? [`Install ${guide.product}`, guide.install]
      : info.conformanceOk === false
        ? [`Put the tested ${name}`, guide.pinTested]
        : undefined;
  const login = info.login === "logged_out" ? guide.loginFix(info.proxy !== undefined) : undefined;
  if (!install && login === undefined) return undefined;
  if (install && login === undefined) return manual(`${install[0]} on ${machineId}`, install[1]);
  if (!install) {
    // Behind a proxy the proxy holds the login: nothing to paste.
    return info.proxy !== undefined
      ? manual(`On ${machineId}, ${login} (${name} goes through ${info.proxy})`)
      : manual(`Log ${name} in on ${machineId}`, login);
  }
  return manual(`On ${machineId}: ${install[1]}, then ${login}`);
}

/** The node's link to the hub; what it runs is checked by the runner checks. */
export function machineOnline(machine: MachineView, setup: MachineSetup | undefined, runner?: RunnerInfo): DoctorCheck {
  const id = machine.machineId;
  const restart = () => manual(`Restart the fleetd node on ${id}`, restartCommand("node", setup));
  if (machine.status === "offline") {
    return machineEntry(id, "online", "fail", `${id} is offline (last seen ${machine.lastSeenAt}).`, restart());
  }
  if (machine.status === "degraded") {
    const reason = machine.degradedReason ?? "its node reports a problem";
    // The node's reason carries its own "Fix: …"; the finding has one fix field, so it is cut from the text.
    const at = reason.indexOf(" Fix: ");
    const cause = at < 0 ? reason : reason.slice(0, at);
    const embedded = at < 0 ? undefined : trimDots(reason.slice(at + 6));
    // The cause decides the fix: a runner problem is fixed on the runner, and only a node with no runner cause
    // gets the restart.
    const fix = (runner && runnerFix(id, runner)) ?? (embedded !== undefined ? manual(`On ${id}`, embedded) : restart());
    return machineEntry(id, "online", "warn", `${id} is degraded: ${trimDots(cause)}.`, fix);
  }
  return machineEntry(id, "online", "ok", `${id} is online.`);
}

/** `claude_version`, `claude_login`, `runner_conformance` and `claude_self_update` from the node's runner report. */
export function runnerChecks(machineId: string, info: RunnerInfo): DoctorCheck[] {
  const name = guide.name;
  const versionCheck = `${name}_version`;
  const loginCheck = `${name}_login`;
  // Sessions use the machine's own runner setup, so the fix is the login the user would do for their own.
  const setup = guide.setup(info);
  const loginFix = () =>
    info.proxy !== undefined
      ? manual(`On ${machineId}, ${guide.loginFix(true)} (${name} goes through ${info.proxy})`)
      : manual(`Log ${name} in on ${machineId}`, guide.loginFix(false));
  let version: DoctorCheck;
  if (info.version === undefined) {
    version = machineEntry(
      machineId,
      versionCheck,
      "fail",
      `${name} is not installed on ${machineId}; its sessions can't start.`,
      manual(`Install ${guide.product} on ${machineId}`, guide.install),
    );
  } else {
    const problem = guide.versionProblem(info.version);
    version = problem
      ? machineEntry(
          machineId,
          versionCheck,
          "warn",
          problem[0],
          problem[1] === undefined ? undefined : manual(`Change the installed ${name}`, problem[1]),
        )
      : machineEntry(machineId, versionCheck, "ok", `${name} ${info.version.trim()} is supported.`);
  }
  const login =
    info.login === "logged_in"
      ? machineEntry(machineId, loginCheck, "ok", `${machineId}: ${setup}.`)
      : info.login === "logged_out"
        ? machineEntry(machineId, loginCheck, "fail", `${machineId}: ${setup}, so its sessions can't start.`, loginFix())
        : machineEntry(machineId, loginCheck, "unknown", `${machineId}'s node could not tell whether its ${name} is logged in.`);
  const conformance =
    info.conformanceOk === true
      ? machineEntry(machineId, "runner_conformance", "ok", `${name} speaks ${guide.protocol} fleetd expects.`)
      : info.conformanceOk === false
        ? machineEntry(
            machineId,
            "runner_conformance",
            "fail",
            info.problem ?? `${name} on ${machineId} did not answer fleetd's protocol probe as expected.`,
            manual(`Put the tested ${name} on ${machineId}`, guide.pinTested),
          )
        : machineEntry(machineId, "runner_conformance", "unknown", `${machineId}'s node has not probed its ${name} yet.`);
  const out = [version, login, conformance];
  const selfUpdate = selfUpdateEntry(machineId, name, info);
  if (selfUpdate) out.push(selfUpdate);
  return out;
}

const settingsFile = (info: RunnerInfo) => (info.configDir === undefined ? "~/.claude/settings.json" : `${info.configDir}/settings.json`);

/** `<runner>_self_update`: the runner's own background update is off. Undefined from a node that doesn't say. */
function selfUpdateEntry(machineId: string, name: string, info: RunnerInfo): DoctorCheck | undefined {
  const check = `${name}_self_update`;
  if (info.selfUpdate === undefined) return undefined;
  if (!info.selfUpdate) {
    return machineEntry(
      machineId,
      check,
      "ok",
      `${name} on ${machineId} doesn't update itself: fleetd's update brings it to the version it was tested with.`,
    );
  }
  return machineEntry(
    machineId,
    check,
    "warn",
    `${name} on ${machineId} updates itself in the background, so its version can change under its agents: its node turns that off when it starts, and couldn't.`,
    manual(`On ${machineId}, set "DISABLE_AUTOUPDATER": "1" in the "env" of ${settingsFile(info)}, then restart its node`),
  );
}

// Claude accounts (teams step 8, D200)

/** What the Claude checks read of the hub's accounts: never a key or token, only where each is and its last Test. */
export type ClaudeSetupView = {
  hubApi?: ClaudeHubApi;
  /** The hub's owner, by name, and their subscription; undefined on a hub with no owner. */
  owner?: [name: string, subscription?: ClaudeSubscription];
  /** Any account is set up: else every machine runs on its own login. */
  configured: boolean;
  /** Every machine agents run on. */
  machines: string[];
};

/** One account's state as a check: its last Test failed, machines don't hold it, it is untested, or it works. */
function accountEntry(
  name: string,
  what: string,
  sealedOn: ClaudeSealedOn[],
  lastTest: ClaudeTest | undefined,
  machines: string[],
  fix: string,
): DoctorCheck {
  if (lastTest && !lastTest.ok) {
    const said = trimDots(lastTest.error ?? "claude failed");
    return hubEntry(name, "fail", `${what} failed its Test on ${lastTest.machineId}: ${said}.`, manual(fix));
  }
  const missing = machines.filter((m) => !sealedOn.some((s) => s.machineId === m));
  if (missing.length > 0) {
    const list = missing.join(", ");
    return hubEntry(
      name,
      "warn",
      `${what} isn't on ${list}, so nothing runs on it there.`,
      manual(`Save it again while ${list} ${missing.length === 1 ? "is" : "are"} online`),
    );
  }
  return lastTest
    ? hubEntry(name, "ok", `${what} works: tested on ${lastTest.machineId}.`)
    : hubEntry(name, "unknown", `${what} is saved but not tested yet.`, manual("Press Test beside it"));
}

/** `hub/claude_key`: the hub's API configuration. */
export function claudeKey(setup: ClaudeSetupView): DoctorCheck {
  const api = setup.hubApi;
  if (!api) {
    return hubEntry("claude_key", "unknown", "The hub has no Claude API key.", manual("Add one on Settings › Hub accounts › Claude"));
  }
  const what = api.endpoint ? `The hub's Claude API key (through ${api.endpoint})` : "The hub's Claude API key";
  return accountEntry(
    "claude_key",
    what,
    api.sealedOn,
    api.lastTest ?? undefined,
    setup.machines,
    "Check the key and endpoint on Settings › Hub accounts › Claude, then save them again",
  );
}

/** `hub/claude_owner`: the hub owner's own subscription. */
export function claudeOwner(setup: ClaudeSetupView): DoctorCheck {
  if (!setup.owner) return hubEntry("claude_owner", "unknown", "The hub has no owner to connect a subscription.");
  const [name, sub] = setup.owner;
  if (!sub) {
    return hubEntry(
      "claude_owner",
      "unknown",
      `${name}, the hub's owner, has no Claude subscription connected.`,
      manual(`${name} connects it in Settings › Your accounts › Claude`),
    );
  }
  return accountEntry(
    "claude_owner",
    `${name}'s Claude subscription`,
    sub.sealedOn,
    sub.lastTest ?? undefined,
    setup.machines,
    `${name} runs \`claude setup-token\` again and pastes the new token in Settings › Your accounts › Claude`,
  );
}

/** `claude_account_override`: the machine's claude user settings set a credential or gateway in their `env`. */
export function claudeAccountOverride(machineId: string, info: RunnerInfo, configured: boolean): DoctorCheck | undefined {
  const names = configured ? info.accountOverrides : undefined;
  if (!names) return undefined;
  const settings = settingsFile(info);
  if (names.length === 0) {
    return machineEntry(
      machineId,
      "claude_account_override",
      "ok",
      `${machineId}'s claude settings set no credential of their own: its sessions run on the account fleetd gives them.`,
    );
  }
  const list = names.join(", ");
  return machineEntry(
    machineId,
    "claude_account_override",
    "warn",
    `${settings} on ${machineId} sets ${list} in its "env", which claude applies over the Claude account fleetd gives each session there.`,
    manual(
      `On ${machineId}, move ${list} out of the "env" of ${settings} (into ~/.fleetd/claude.env for the machine's own login), then restart its node`,
    ),
  );
}

/** The usage breaker's view (hub/usage/service.rs `UsageBreaker`). */
export type UsageBreaker = { state: string; until?: string; checkAt?: string; message?: string };

export function usageBreaker(machineId: string, breaker: UsageBreaker): DoctorCheck {
  if (breaker.state === "closed") return machineEntry(machineId, "usage_breaker", "ok", "The usage breaker is closed.");
  const wait =
    breaker.until !== undefined
      ? `Wait for the reset (${breaker.until})`
      : breaker.checkAt !== undefined
        ? `Nothing: fleetd tries the login again by itself (next at ${breaker.checkAt})`
        : "Wait for the reset";
  return machineEntry(
    machineId,
    "usage_breaker",
    "warn",
    breaker.message ?? `New turns on ${machineId} are paused by the usage breaker.`,
    manual(
      `${wait}, or once the login has capacity press Resume in the app, or run fleetd usage resume ${machineId}`,
    ),
  );
}

/** An open recovery breaker: the agents whose deaths opened it, the ones that wait, and when it closes ("10:42 UTC"). */
export type RecoveryPaused = { openedBy: string[]; waiting: string[]; until: string };

export function recoveryBreaker(machineId: string, paused: RecoveryPaused | undefined): DoctorCheck {
  if (!paused) {
    return machineEntry(machineId, "recovery", "ok", `Agents on ${machineId} whose run dies resume on their own.`);
  }
  const n = paused.waiting.length;
  const waiting = n === 0 ? "" : ` ${n} wait${n === 1 ? "s" : ""}: ${paused.waiting.join(", ")}.`;
  return machineEntry(
    machineId,
    "recovery",
    "warn",
    `Automatic recovery is paused on ${machineId}: ${paused.openedBy.length} agents died there within 10 min (${paused.openedBy.join(", ")}).${waiting} It resumes at ${paused.until} if no other agent dies there, or once one there completes.`,
    manual(`Find out what kills agents on ${machineId} (its memory, its toolchain); message_agent continues one now`),
  );
}

/** A session a node runs that no task or lead of this hub owns. */
export type UnownedSession = { threadId: string; title: string };

export function unownedSessions(machineId: string, offline: boolean, sessions: UnownedSession[]): DoctorCheck {
  if (offline) return machineEntry(machineId, "sessions", "unknown", `${machineId} is offline.`);
  if (sessions.length === 0) {
    return machineEntry(machineId, "sessions", "ok", `Every session running on ${machineId} is an agent's or a lead's.`);
  }
  const named = sessions.slice(0, 5).map((s) => `"${clip(s.title, 60)}" (${s.threadId})`);
  const more = sessions.length - named.length > 0 ? ` and ${sessions.length - named.length} more` : "";
  return machineEntry(
    machineId,
    "sessions",
    "warn",
    `${machineId} runs ${sessions.length} session${sessions.length === 1 ? "" : "s"} no agent or lead of this hub owns: ${named.join(", ")}${more}. Nothing watches or counts them.`,
    manual(`Read it with thread_tail; if nothing should be running it, stop its claude on ${machineId}`),
  );
}

/** The probe's result, or why there is none ("lab-a is offline."). */
export type ProbeRead = { ok: true; probe: NodeProbe } | { ok: false; why: string };

export function commitIdentity(machineId: string, read: ProbeRead, config: HubSetup): DoctorCheck {
  if (!read.ok) return machineEntry(machineId, "commit_identity", "unknown", read.why);
  const probe = read.probe;
  const want = config.gitIdentity?.email;
  // Setup writes the identity into the node's unit; by hand, git's global config is the place.
  const set = (): DoctorFix => {
    if (want === undefined) {
      return manual(
        `Set the commit identity on ${machineId}`,
        "git config --global user.email '<id>+<user>@users.noreply.github.com'",
      );
    }
    const m = config.machines[machineId];
    if (m) {
      return onHub(
        manual(`Run machine setup again from the hub to write the hub's identity into ${machineId}'s service`, addCommand(m)),
      );
    }
    // Joined by itself (fleetd pair --worker): the join command carries the identity.
    return onHub(
      manual(
        `Join ${machineId} again: run this on the hub, then the line it prints on ${machineId}; it carries the identity`,
        `fleetd pair --worker ${machineId}`,
      ),
    );
  };
  const email = probe.gitEmail;
  if (email === undefined) {
    return machineEntry(machineId, "commit_identity", "fail", `No git commit identity is set on ${machineId}.`, set());
  }
  const from = probe.gitEmailFrom === "env" ? "the service environment" : "git's global config";
  if (want !== undefined && email.toLowerCase() !== want.toLowerCase()) {
    return machineEntry(
      machineId,
      "commit_identity",
      "warn",
      `Commits on ${machineId} use ${email} (from ${from}); the hub's identity is ${want}.`,
      set(),
    );
  }
  const noreply = /@users\.noreply\.github\.com$/i.test(email) ? ", a GitHub noreply address" : "";
  return machineEntry(machineId, "commit_identity", "ok", `Commits on ${machineId} use ${email} (from ${from}${noreply}).`);
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** Free space where the node's worktrees live, from its heartbeat, and whether the guard holds new agents there. */
export function diskSpace(machineId: string, offline: boolean, disk: NodeDisk | undefined, paused: string | undefined): DoctorCheck {
  if (!disk || offline) {
    const why = offline ? `${machineId} is offline.` : `${machineId}'s node hasn't reported its free disk space.`;
    return machineEntry(machineId, "disk", "unknown", why);
  }
  const free = disk.freeBytes;
  const min = disk.minFreeBytes;
  const space = `${gb(free)} free of ${gb(disk.totalBytes)} where ${machineId}'s worktrees live`;
  if (paused === undefined) {
    const floor = min > 0 ? `new agents pause below ${gb(min)}` : "minFreeGb 0 turns the disk pause off";
    return machineEntry(machineId, "disk", "ok", `${space}; ${floor}.`);
  }
  const message = `${paused}. ${space}. Running agents keep going; new ones start again once it has room.`;
  if (free < min) {
    return machineEntry(
      machineId,
      "disk",
      "fail",
      message,
      manual(`Free disk space on ${machineId}: a writer's worktree goes once its PR merges`),
    );
  }
  return machineEntry(machineId, "disk", "warn", message);
}

/** A screen kind's health from the heartbeat: `unavailable` fails, the rest pass. */
function screen(machineId: string, name: string, offline: boolean, health: ScreenHealth | undefined): DoctorCheck | undefined {
  if (!health || offline) return undefined;
  const status: DoctorStatus = health.state === "unavailable" ? "fail" : "ok";
  const fix = health.fix === undefined ? undefined : manual(`On ${machineId}; its node checks again by itself within minutes`, health.fix);
  return machineEntry(machineId, name, status, health.message, fix);
}

/** Whether the machine can host android sessions; undefined where they are off (or offline, or an older node). */
export const androidSessions = (machineId: string, offline: boolean, health?: ScreenHealth) =>
  screen(machineId, "android", offline, health);

/** Whether the Mac can host iOS sessions; undefined where they are off (or offline, or an older node). */
export const iosSessions = (machineId: string, offline: boolean, health?: ScreenHealth) => screen(machineId, "ios", offline, health);

/** Whether the machine can host Linux desktop sessions; undefined where they are off (or offline, or an older node). */
export const desktopSessions = (machineId: string, offline: boolean, health?: ScreenHealth) =>
  screen(machineId, "desktop", offline, health);

/** The agents' Mac's setup checks (`mac_<check>`), as its node ran them last, from its heartbeat. */
export function macSetup(machineId: string, offline: boolean, health: MacHealth | undefined): DoctorCheck[] {
  if (!health || offline) return [];
  return health.checks.map((c) => {
    const status: DoctorStatus = c.state === "ok" || c.state === "warn" || c.state === "fail" ? c.state : "unknown";
    const fix = c.fix === undefined ? undefined : manual(`${c.fix}; ${machineId} checks again within a minute`, c.command);
    return machineEntry(machineId, `mac_${c.id}`, status, c.message, fix);
  });
}

/** `<mac>/mac_one_node`: no other machine of this hub runs on the agents' Mac, as the nodes' fingerprints say. */
export function macOneNode(machineId: string, others: string[]): DoctorCheck {
  const other = others[0];
  if (other === undefined) {
    return machineEntry(machineId, "mac_one_node", "ok", "No other fleetd node of this hub runs on this Mac.");
  }
  return machineEntry(
    machineId,
    "mac_one_node",
    "fail",
    `${others.join(", ")} is enrolled from this Mac too, under another name: the hub would take it for another machine.`,
    onHub(
      manual(
        "On the hub (push its agents' work first). If it ran in another account on this Mac, stop it there too: launchctl bootout gui/$(id -u)/sh.fleetd.node; rm -rf ~/.fleetd/node",
        `fleetd machine remove ${other}`,
      ),
    ),
  );
}

/** Whether git could fetch each project's remote at the last worktree started there. Undefined until one started. */
export function gitFetch(machineId: string, bases: [string, WorktreeBase][], now: string): DoctorCheck | undefined {
  if (bases.length === 0) return undefined;
  const failing = bases.flatMap(([project, b]) => {
    const kind = doctorAlert(b);
    return kind === undefined ? [] : [[project, b, kind] as const];
  });
  const first = failing[0];
  if (!first) {
    // Only what the last starts showed: a fetch that worked, an offline one, or no remote to fetch.
    const each = bases.map(([project, b]) =>
      b.error === undefined
        ? `${project} fetched its remote`
        : b.error.kind === "no_remote"
          ? `${project} has no remote`
          : `${project} was offline (from ${start(b, now)})`,
    );
    return machineEntry(machineId, "git_fetch", "ok", `At each project's last start on ${machineId}: ${each.join("; ")}.`);
  }
  const [project, base, kind] = first;
  const [text, command] = fetchFailedText(project, base, now);
  const more = failing.length === 1 ? "" : ` ${failing.length - 1} more projects fail too.`;
  const status: DoctorStatus = kind === "auth" || kind === "no_ssh" ? "fail" : "warn";
  return machineEntry(machineId, "git_fetch", status, `${text}${more}`, manual(fixLabel(kind, machineId), command));
}

/** A fork's default branch behind its upstream's: agents start from the fork. Undefined when no project is a fork. */
export function forkBehind(machineId: string, bases: [string, WorktreeBase][]): DoctorCheck | undefined {
  const forks = bases.filter(([, b]) => b.forkBehind !== undefined);
  if (forks.length === 0) return undefined;
  const behind = forks.find(([, b]) => (b.forkBehind ?? 0) > 0);
  if (!behind) {
    return machineEntry(machineId, "fork_behind", "ok", "Each fork's default branch has everything upstream's has.");
  }
  const [project, b] = behind;
  const slash = b.ref.indexOf("/");
  const branch = slash < 0 ? b.ref : b.ref.slice(slash + 1);
  return machineEntry(
    machineId,
    "fork_behind",
    "warn",
    `${project}: your fork's ${branch} is ${b.forkBehind} behind upstream, and agents start from it; \`gh repo sync\` brings it up to date.`,
    manual("Sync the fork with upstream: GitHub's Sync fork button, or `gh repo sync <owner>/<fork>`"),
  );
}
