// Ports crates/fleetd/src/hub/machine_setup/tests.rs: the hub's Add machine runs `machine add` against a fake
// machine (a Runner standing in for SSH), fake release builds and a fake node login, in a scratch home under $TMPDIR.
import { accounts } from "../src/hub/claude_accounts/tools.ts";
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerAll } from "../src/hub/serve/areas.ts";
import { type Builds, releaseOf, type Runner } from "../src/cli/setup/machine.ts";
import { localTarget } from "../src/cli/setup/machine_plan.ts";
import { VERSION } from "../src/shared/version.ts";
import { type Caller, Registry } from "../src/hub/api/registry.ts";
import { machineSetup, parseSshHosts, parseTailscalePeers, type SetupPorts } from "../src/hub/machine_setup/index.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { caller, testHub } from "./hub-helpers.ts";

/** Another OS than the hub's, of a CPU fleetd has a build for: macOS from a Linux hub, Linux x64 from a Mac. */
const [hubOs, hubArch] = localTarget();
const other: [string, string] = hubOs === "darwin" ? ["linux", "x64"] : ["darwin", hubArch];
const otherAsset = `fleetd-bun-${other[0]}-${other[1]}`;
const sha = (b: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

// Each test builds a hub on a fresh database, migrations and all, and some wait out a background run: a busy shared
// machine takes longer than bun's 5 s.
setDefaultTimeout(20_000);

const probe = () =>
  [
  "home /home/dev",
  "fleetd /home/dev/.fleetd",
  "config /home/dev/.config",
  "user dev",
  "uid 1000",
  `os ${otherOs ? (other[0] === "darwin" ? "Darwin" : "Linux") : "Linux"}`,
  `arch ${(otherOs ? other[1] : process.arch) === "x64" ? "x86_64" : "arm64"}`,
  "path /usr/bin:/bin",
  "claude /home/dev/.local/bin/claude",
  "claude_version 2.1.314 (Claude Code)",
  "linger yes",
  "loaded_unit ",
  "gui unknown",
  ...(otherOs && hasBuild ? [`digest /home/dev/.fleetd/bin/fleetd ${sha(otherAsset)}`] : []),
  ].join("\n");

type Ran = { host: string; command: string; stdin?: string };

let t: ReturnType<typeof testHub>;
let tools: Registry;
let ran: Ran[];
let fail: string | undefined;
let noSystemd: boolean;
let logins: (string | undefined)[];
let statusAsked: string[];
let otherOs: boolean;
let hasBuild: boolean;
let missing: boolean;
let asked: [string, string][];
const admin = caller("admin", true);

/** The machine: the probe answers `probe`, `node join` brings its node online at the hub, the rest exits 0. */
const machine: Runner = {
  async run(target, command, stdin) {
    ran.push({ host: target.host, command, ...(stdin === undefined ? {} : { stdin: new TextDecoder().decode(stdin) }) });
    if (noSystemd && command.includes("systemctl --user enable")) return { code: 127, stdout: "", stderr: "sh: 1: systemctl: not found" };
    if (fail !== undefined && command.includes(fail)) {
      return { code: 1, stdout: "", stderr: "mkdir: cannot create directory: Permission denied" };
    }
    if (command.startsWith("H=$HOME")) return { code: 0, stdout: probe(), stderr: "" };
    if (command.includes("auth status --json")) return { code: 0, stdout: '{"loggedIn":true}', stderr: "" };
    if (command.includes("--token-file")) {
      const id = target.host.split("@").pop()!.split(".")[0]!;
      const seen = new Date(Date.now() + 60_000).toISOString();
      store(t.hub).machineUpsert({ machineId: id, name: id, tags: [], status: "online", lastSeenAt: seen, nodeVersion: "0.1.0" } as never);
      return { code: 0, stdout: "enrolled", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  },
};

/** The release builds: each asked-for one is the asset's name as its bytes, unless `missing`. */
const builds: Builds = {
  async digest(version, asset) {
    if (missing) throw new Error(`no ${asset} of fleetd ${version} to copy to the machine: the release has none. Fix: run a released fleetd on the workspace's machine`);
    return sha(asset);
  },
  async build(version, asset) {
    asked.push([version, asset]);
    if (missing) throw new Error(`no ${asset} of fleetd ${version} to copy to the machine: the release has none. Fix: run a released fleetd on the workspace's machine`);
    return new TextEncoder().encode(asset);
  },
};

const ports: SetupPorts = {
  runner: () => machine,
  exe: () => process.execPath,
  builds: () => builds,
  hosts: async () => [
    ["builder-1", "lab"],
    [
      { name: "mac-mini", dnsName: "mac-mini.tail1234.ts.net" },
      { name: "lab", dnsName: "lab.tail1234.ts.net" },
    ],
  ],
  // The node's login: it starts with a URL, and takes only the code `abc#s1`.
  async claudeLogin(_hub, _m, code) {
    logins.push(code);
    if (code === undefined) {
      return { ok: true, message: "sign in at the URL, then give the code it shows", loginUrl: "https://claude.ai/oauth/authorize?state=s1" };
    }
    return code === "abc#s1" ? { ok: true, message: "Login successful." } : { ok: false, message: "claude auth login failed: Invalid code" };
  },
  // Antigravity's: `signed` is signed in already; `lab` starts with a URL and takes only `g#1`.
  async antigravityLogin(_hub, m, code) {
    logins.push(code);
    if (m === "signed") return { ok: true, message: "Antigravity is signed in (Google AI Pro)", signedIn: "Google AI Pro" };
    if (code === undefined) return { ok: true, message: "sign in at the URL, then give the code it shows", loginUrl: "https://accounts.google.com/o/oauth2/auth?state=g1" };
    return code === "g#1" ? { ok: true, message: "Antigravity is signed in (Google AI Pro)", signedIn: "Google AI Pro" } : { ok: false, message: "agy acp --login failed: invalid code" };
  },
  // `signed` is signed in, `lab` isn't, `old`'s node can't say, and `mac` can't sign Antigravity in at all.
  async antigravityStatus(_hub, m) {
    statusAsked.push(m);
    if (m === "mac") return undefined;
    if (m === "old") return { checked: false };
    return m === "signed" ? { checked: true, signedIn: "Google AI Pro" } : { checked: true };
  },
};

beforeEach(() => {
  t = testHub(Date.now());
  writeFileSync(
    join(t.home, "setup.json"),
    JSON.stringify({
      listen: "127.0.0.1:4790",
      url: "http://devbox.example.ts.net:4790",
      unitSuffix: "",
      gitIdentity: { name: "ada-lovelace", email: "1+ada-lovelace@users.noreply.github.com" },
      machines: {},
    }),
  );
  machineSetup(t.hub).setPorts(ports);
  tools = new Registry();
  registerAll(tools);
  ran = [];
  fail = undefined;
  noSystemd = false;
  logins = [];
  statusAsked = [];
  otherOs = false;
  hasBuild = false;
  missing = false;
  asked = [];
});
afterEach(() => t.done());

async function call(name: string, input: unknown, as: Caller = admin): Promise<Record<string, any>> {
  const r = await tools.call(t.hub, as, name, input);
  if ("error" in r) throw r.error.kind === "tool" ? r.error.error : new Error(`${r.error.kind}: ${JSON.stringify(r.error)}`);
  return r.output as Record<string, any>;
}

async function finished(runId: string): Promise<Record<string, any>> {
  for (let i = 0; i < 200; i++) {
    const run = (await call("machine_add_status", { runId })).runs[0];
    if (run.state !== "running") return run;
    await Bun.sleep(25);
  }
  throw new Error(`run ${runId} never finished`);
}

const setupJson = () => JSON.parse(readFileSync(join(t.home, "setup.json"), "utf8"));

test("the plan reads the machine and changes nothing", async () => {
  const plan = await call("machine_add_plan", { host: "builder-1" });
  expect(plan.machineId).toBe("builder-1");
  expect(plan.joined).toBe(false);
  expect(plan.platform).toBe(`linux-${process.arch}`);
  const steps = plan.steps as { title: string; state: string }[];
  expect(steps[0]!.title).toBe("create fleetd's directories");
  expect(steps.every((s) => s.state === "planned")).toBe(true);
  expect(steps.at(-1)!.title).toBe("waiting until builder-1 is online (up to 2 min)");
  expect(steps.some((s) => s.title === "enroll the node with a one-time token (sent on stdin)")).toBe(true);
  // Only the read-only probe ran; nothing recorded, nothing enrolled.
  expect(ran.length).toBe(1);
  expect(setupJson().machines).toEqual({});
});

test("adds a machine step by step with events", async () => {
  const out = await call("machine_add", { host: "builder-1" });
  expect(out.run.state).toBe("running");
  const runId = out.run.runId as string;
  expect(runId).toMatch(/^M[0-9a-f]{32}$/);
  const run = await finished(runId);
  expect(run.state).toBe("done");
  expect(run.loggedIn).toBe(true);
  const steps = run.steps as { title: string; state: string }[];
  expect(steps[0]!.title).toBe("read the machine's state (read-only)");
  expect(steps.every((s) => s.state === "done")).toBe(true);

  // The one-time token went to the enroll step's stdin, and nowhere into the run.
  const token = ran.find((r) => r.command.includes("--token-file"))!.stdin!;
  expect(token).toMatch(/^fle_/);
  expect(JSON.stringify(run)).not.toContain(token.trim());
  expect(ran.every((r) => r.host === "builder-1")).toBe(true);

  // Recorded for machine remove, and the hub sees the machine.
  expect(setupJson().machines["builder-1"].sshHost).toBe("builder-1");
  expect(store(t.hub).machineGet("builder-1")).toBeDefined();

  // Each step started and ended out loud, for the app to read the run again.
  const seen = events(t.hub).page(0, ["machine_add.step"]).events;
  expect(seen.length).toBeGreaterThanOrEqual(2 * steps.length);
  expect(seen.every((e) => (e.data as { runId: string }).runId === runId)).toBe(true);
  expect(seen.at(-1)!.summary).toBe("Added builder-1");
  expect(seen.at(-1)!.data).toEqual({ runId, machineId: "builder-1", state: "done" });
  expect((await call("machine_add_status", {})).runs.length).toBe(1);
  expect((await call("machine_add_status", { runId: `M${"0".repeat(32)}` })).next).toStartWith("No such run");
});

test("a failed step shows its output and the fix", async () => {
  fail = "mkdir -p";
  const out = await call("machine_add", { host: "builder-1" });
  const run = await finished(out.run.runId);
  expect(run.state).toBe("failed");
  expect(run.message).toStartWith("step 1 failed (exit 1):");
  expect(run.fix).toContain("finished steps are skipped");
  const failed = (run.steps as { state: string; output?: string }[]).filter((s) => s.state === "failed");
  expect(failed.length).toBe(1);
  expect(failed[0]!.output).toContain("Permission denied");
  expect(failed[0]!.output).not.toStartWith("step 1");
  expect(events(t.hub).page(0, ["machine_add.step"]).events.at(-1)!.summary).toBe("Couldn't add builder-1");
});

// A machine with no systemd user service manager (a container, WSL without systemd) enrolls, then can't start the
// node's service: the fix is --no-service and the node by hand, not a new code (W890).
test("a machine without systemd is told to add itself with --no-service and run its node", async () => {
  noSystemd = true;
  const run = await finished((await call("machine_add", { host: "builder-1" })).run.runId);
  expect(run.state).toBe("failed");
  expect(run.message).toContain("failed (exit 127):");
  expect(run.fix).toStartWith("this machine has no systemd user service to run its node");
  expect(run.fix).toContain("fleetd machine add builder-1 --no-service, then start the node with ");
  expect(run.fix).toContain(" node run --home ");
});

test("a run going for a machine refuses a second add, and a removal without force", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  machineSetup(t.hub).setPorts({
    ...ports,
    runner: () => ({
      run: async (target, command, stdin) => {
        await held;
        return machine.run(target, command, stdin);
      },
    }),
  });
  const out = await call("machine_add", { host: "builder-1" });
  await expect(call("machine_add", { host: "builder-1" })).rejects.toMatchObject({
    code: "invalid",
    message: "builder-1 is being added already.",
    fix: "machine_add_status follows it.",
  });
  await expect(call("machine_remove", { machineId: "builder-1" })).rejects.toMatchObject({ code: "invalid" });
  const refused = await call("machine_remove", { machineId: "builder-1" }).catch((e) => e);
  expect(refused.message).toBe("builder-1 is still being added. Removing it anyway stops that halfway.");
  expect(refused.fix).toContain(`the add is run ${out.run.runId}`);
  expect(refused.fix).toContain("force: true");
  release();
  expect((await finished(out.run.runId)).state).toBe("done");
});

test("only an admin's device adds or removes", async () => {
  for (const who of [caller("admin"), caller("operate", true)]) {
    for (const [tool, input] of [
      ["machine_add_plan", { host: "builder-1" }],
      ["machine_add", { host: "builder-1" }],
      ["machine_add_status", {}],
      ["machine_hosts", {}],
      ["machine_remove", { machineId: "builder-1" }],
      ["machine_join", { machineId: "builder-1" }],
      ["machine_claude_login", { machineId: "builder-1" }],
      ["machine_antigravity_login", { machineId: "builder-1" }],
    ] as const) {
      await expect(call(tool, input, who)).rejects.toMatchObject({ code: "forbidden" });
    }
  }
  expect(ran).toEqual([]);
});

test("hosts list this machine, ssh_config and the tailnet once each", async () => {
  store(t.hub).machineUpsert({ machineId: "lab", name: "lab", tags: [], status: "online", lastSeenAt: new Date().toISOString(), nodeVersion: "1" } as never);
  const out = await call("machine_hosts", {});
  const hosts = out.hosts as { machineId: string; host?: string; source: string; joined: boolean }[];
  expect(hosts[0]!.source).toBe("hub");
  expect(hosts.slice(1)).toEqual([
    { joined: false, host: "builder-1", machineId: "builder-1", source: "ssh_config" },
    { joined: true, host: "lab", machineId: "lab", source: "ssh_config" },
    { joined: false, host: "mac-mini.tail1234.ts.net", machineId: "mac-mini", source: "tailnet" },
  ]);
});

test("a machine that runs leads is removed only with force, which erases its bots and tells open apps", async () => {
  store(t.hub).machineUpsert({ machineId: "lab-a", name: "lab-a", tags: [], status: "online", lastSeenAt: new Date().toISOString(), nodeVersion: "1" } as never);
  t.hub.db.conn.query("INSERT INTO node_keys (machine_id, pub_key) VALUES ('lab-a', 'k')").run();
  t.hub.db.conn
    .query("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('lab-a', 'p1', 'lead-1', 't', 1)")
    .run();
  await expect(call("machine_remove", { machineId: "lab-a" })).rejects.toMatchObject({
    code: "invalid",
    message: "lab-a still runs Shop's lead. Removing it anyway deletes that bot, with its chat and history.",
    fix: "to repair lab-a instead, run fleetd pair --worker lab-a on the workspace's machine and the line it prints on lab-a with --rejoin; to remove it anyway, call machine_remove again with force: true (Remove anyway in the app)",
  });
  expect(store(t.hub).machineGet("lab-a")).toBeDefined();
  const out = await call("machine_remove", { machineId: "lab-a", force: true });
  expect(out.machineId).toBe("lab-a");
  expect(out.revoked).toBe(true);
  // lab-a joined by itself, so nothing ran on it: only the hub's side.
  expect(out.steps).toEqual([]);
  expect(ran).toEqual([]);
  expect(out.next).toContain("was not set up by fleetd machine add from this workspace");
  expect(out.next).toContain("erased lab-a's bot: its chat, memory, skills, files, orders and tasks.");
  expect(store(t.hub).machineGet("lab-a")).toBeUndefined();
  expect(store(t.hub).projectsList("lab-a")).toEqual([]);
  const removed = events(t.hub).page(0, ["machine.removed"]).events;
  expect(removed.map((e) => [e.machineId, e.summary])).toEqual([["lab-a", "lab-a was removed from the workspace"]]);
});

test("removing a machine it set up runs the undo steps there", async () => {
  const s = setupJson();
  s.machines["builder-1"] = { sshHost: "builder-1", platform: "linux", home: "/home/dev", configHome: "/home/dev/.config", uid: 1000 };
  writeFileSync(join(t.home, "setup.json"), JSON.stringify(s));
  const out = await call("machine_remove", { machineId: "builder-1" });
  expect(out.revoked).toBe(false);
  expect((out.steps as { state: string }[]).every((x) => x.state === "done")).toBe(true);
  expect(ran.length).toBe(out.steps.length);
  expect(ran.every((r) => r.host === "builder-1")).toBe(true);
  expect(setupJson().machines).toEqual({});
  fail = "systemctl";
  s.machines["builder-1"] = { sshHost: "builder-1", platform: "linux", home: "/home/dev", configHome: "/home/dev/.config", uid: 1000 };
  writeFileSync(join(t.home, "setup.json"), JSON.stringify(s));
  const failed = await call("machine_remove", { machineId: "builder-1" });
  expect(failed.next).toStartWith("A step on the machine failed: its output says which, and what to run there by hand.");
  const step = (failed.steps as { state: string; output?: string }[]).find((x) => x.state === "failed")!;
  expect(step.output).toContain("run the remaining steps yourself");
});

test("a join code comes with the line to paste", async () => {
  const out = await call("machine_join", { machineId: "builder-2" });
  expect(out.code).toMatch(/^fle_/);
  expect(out.hubUrl).toBe("http://devbox.example.ts.net:4790");
  expect(out.line).toContain(`--join http://devbox.example.ts.net:4790 --code ${out.code} --machine-id builder-2`);
  expect(out.gitIdentity).toBe("ada-lovelace <1+ada-lovelace@users.noreply.github.com>");
  expect(out.next).toStartWith("Run the line on builder-2");
  const rejoin = await call("machine_join", { machineId: "builder-2", rejoin: true });
  expect(rejoin.line).toEndWith(" --rejoin");
  const mac = await call("machine_join", { machineId: "studio", mac: true });
  expect(mac.line).toContain("--mac");
  expect(mac.next).toStartWith("Paste the line in Terminal on studio");
});

test("a join code with no machine named joins whichever computer runs its line, under its own name", async () => {
  const out = await call("machine_join", {});
  expect(out.machineId).toBeUndefined();
  expect(out.line).toBe(
    `curl -fsSL https://fleetd.sh | sh -s -- --join http://devbox.example.ts.net:4790 --code ${out.code} --git-identity 'ada-lovelace <1+ada-lovelace@users.noreply.github.com>'`,
  );
  expect(out.next).toStartWith("Run the line on the computer to add: it installs fleetd and joins under its own name.");
  expect(t.hub.auth.nodes.enrollNode(out.code, "laptop", "k1", "fp1")).toBe("laptop");
});

test("a repair connects with the ssh_config it was set up with", async () => {
  const s = setupJson();
  s.machines["builder-1"] = { sshHost: "builder-1", sshConfig: "/home/dev/.ssh/fleet_config", platform: "linux", home: "/home/dev", configHome: "/home/dev/.config", uid: 1000 };
  writeFileSync(join(t.home, "setup.json"), JSON.stringify(s));
  const configs: (string | undefined)[] = [];
  machineSetup(t.hub).setPorts({
    ...ports,
    runner: () => ({ run: (target, c, i) => (configs.push(target.config), machine.run(target, c, i)) }),
  });
  await call("machine_add_plan", { host: "builder-1" });
  expect(configs).toEqual(["/home/dev/.ssh/fleet_config"]);
});

test("claude logs in on a machine through its node, and a bad code says to start again", async () => {
  store(t.hub).machineUpsert({ machineId: "lab", name: "lab", tags: [], status: "online", lastSeenAt: new Date().toISOString(), nodeVersion: "1" } as never);
  const started = await call("machine_claude_login", { machineId: "lab" });
  expect(started.loginUrl).toBe("https://claude.ai/oauth/authorize?state=s1");
  expect(started.loggedIn).toBeUndefined();
  expect(started.next).toContain("The login waits 10 minutes.");
  const done = await call("machine_claude_login", { machineId: "lab", code: "  abc#s1 " });
  expect(done).toMatchObject({ loggedIn: true, message: "Login successful.", next: "claude on lab is logged in: its sessions can start." });
  await expect(call("machine_claude_login", { machineId: "lab", code: "nope" })).rejects.toMatchObject({
    code: "failed",
    message: "claude auth login failed: Invalid code",
    fix: "Start the login again: each sign-in page's code works once.",
  });
  expect(logins).toEqual([undefined, "abc#s1", "nope"]);
  // The code goes nowhere else: no event carries it.
  expect(JSON.stringify(events(t.hub).page(0).events)).not.toContain("abc#s1");
});

test("Antigravity signs in on a machine through its node: one signed in already says so and starts nothing", async () => {
  for (const id of ["lab", "signed"]) store(t.hub).machineUpsert({ machineId: id, name: id, tags: [], status: "online", lastSeenAt: new Date().toISOString(), nodeVersion: "1" } as never);
  expect(await call("machine_antigravity_login", { machineId: "signed" })).toMatchObject({ signedIn: "Google AI Pro", next: "Antigravity on signed is signed in: its agents on Antigravity can start." });
  const started = await call("machine_antigravity_login", { machineId: "lab" });
  expect([started.loginUrl, started.signedIn]).toEqual(["https://accounts.google.com/o/oauth2/auth?state=g1", undefined]);
  expect(started.next).toContain("The sign-in waits 10 minutes.");
  expect(await call("machine_antigravity_login", { machineId: "lab", code: " g#1 " })).toMatchObject({ signedIn: "Google AI Pro" });
  await expect(call("machine_antigravity_login", { machineId: "lab", code: "nope" })).rejects.toMatchObject({
    code: "failed",
    message: "agy acp --login failed: invalid code",
    fix: "Start the sign-in again: each sign-in page's code works once.",
  });
  await expect(call("machine_antigravity_login", { machineId: "lab", code: " " })).rejects.toMatchObject({ code: "invalid" });
  expect(logins).toEqual([undefined, undefined, "g#1", "nope"]);
  expect(JSON.stringify(events(t.hub).page(0).events)).not.toContain("g#1");
});

test("antigravity_status says where Google is connected: each machine's sign-in, asked once a minute, and the bots with a key", async () => {
  for (const id of ["lab", "signed", "old", "mac"]) store(t.hub).machineUpsert({ machineId: id, name: id, tags: [], status: "online", lastSeenAt: new Date().toISOString(), nodeVersion: "1" } as never);
  t.hub.db.conn
    .query(
      `INSERT INTO vault_items (item_id, kind, scope, machine_id, project_id, env_name, label, meta, sealed, key_id, version, created_ms, created_by, updated_ms, updated_by)
         VALUES (?, 'env', 'project', 'lab', ?, ?, ?, '{}', x'00', 'k', 1, 0, 'ada', 0, 'ada')`,
    )
    .run("v1", "web", "GEMINI_API_KEY", "GEMINI_API_KEY");
  t.hub.db.conn
    .query(
      `INSERT INTO vault_items (item_id, kind, scope, machine_id, project_id, env_name, label, meta, sealed, key_id, version, created_ms, created_by, updated_ms, updated_by)
         VALUES (?, 'env', 'project', 'lab', ?, ?, ?, '{}', x'00', 'k', 1, 0, 'ada', 0, 'ada')`,
    )
    .run("v2", "api", "OTHER_KEY", "OTHER_KEY");
  const out = await call("antigravity_status", {}, caller("read", true));
  expect(out.machines.sort((a: { machineId: string }, b: { machineId: string }) => a.machineId.localeCompare(b.machineId))).toEqual([
    { machineId: "lab", checked: true },
    { machineId: "old", checked: false },
    { machineId: "signed", checked: true, signedIn: "Google AI Pro" },
  ]);
  expect(out.keyIn).toEqual([{ machineId: "lab", projectId: "web" }]);
  // Within the minute, only the machine that couldn't say is asked again; a sign-in from the app is known at once.
  statusAsked = [];
  await call("machine_antigravity_login", { machineId: "lab" });
  await call("machine_antigravity_login", { machineId: "lab", code: "g#1" });
  const again = await call("antigravity_status", {});
  expect(statusAsked.sort()).toEqual(["mac", "old"]);
  expect(again.machines.find((m: { machineId: string }) => m.machineId === "lab")).toEqual({ machineId: "lab", checked: true, signedIn: "Google AI Pro" });
  // The team's Gemini key, once saved, says where it is held; never the key.
  expect(again.teamKey).toBeUndefined();
  const key = { sealedOn: [{ machineId: "lab", fingerprint: "ab12cd34" }], updatedAt: "2026-11-22T10:00:00.000Z" };
  accounts(t.hub).putGeminiKey(key);
  expect((await call("antigravity_status", {})).teamKey).toEqual(key);
});

test("a login on a machine the workspace doesn't know, or with an empty code, asks nothing of a node", async () => {
  await expect(call("machine_claude_login", { machineId: "ghost" })).rejects.toMatchObject({ code: "not_found" });
  store(t.hub).machineUpsert({ machineId: "lab", name: "lab", tags: [], status: "online", lastSeenAt: new Date().toISOString(), nodeVersion: "1" } as never);
  await expect(call("machine_claude_login", { machineId: "lab", code: "  " })).rejects.toMatchObject({ code: "invalid" });
  expect(logins).toEqual([]);
});

test("ssh_config hosts without patterns, and the tailnet's online Linux and macOS peers", () => {
  expect(parseSshHosts('Host builder-1 "lab" *.example\n  HostName 10.0.0.2\nhost=mac-mini !bad lab\nMatch all\n')).toEqual([
    "builder-1",
    "lab",
    "mac-mini",
  ]);
  const status = (backend: string) =>
    JSON.stringify({
      BackendState: backend,
      Self: { DNSName: "devbox.tail1234.ts.net." },
      Peer: {
        a: { DNSName: "studio.tail1234.ts.net.", OS: "macOS", Online: true },
        b: { DNSName: "lab.tail1234.ts.net.", OS: "linux", Online: true },
        c: { DNSName: "phone.tail1234.ts.net.", OS: "iOS", Online: true },
        d: { DNSName: "old.tail1234.ts.net.", OS: "linux", Online: false },
      },
    });
  expect(parseTailscalePeers(status("Running"))).toEqual([
    { name: "lab", dnsName: "lab.tail1234.ts.net" },
    { name: "studio", dnsName: "studio.tail1234.ts.net" },
  ]);
  expect(parseTailscalePeers(status("Stopped"))).toBeUndefined();
  expect(parseTailscalePeers("not json")).toBeUndefined();
});

test("a release's builds come from its tag, an edge build's from the edge release", () => {
  expect(releaseOf("0.4.1")).toEqual(["https://github.com/unlaboredlabs/fleetd/releases/download/v0.4.1", false]);
  expect(releaseOf("0.4.1", "http://127.0.0.1:9/r")).toEqual(["http://127.0.0.1:9/r", false]);
});

test("a machine of another OS gets this version built for it", async () => {
  otherOs = true;
  const plan = await call("machine_add_plan", { host: "builder-1" });
  expect(plan.steps[0].title).toStartWith(`download fleetd ${VERSION} for ${other[0]}-${other[1]} `);
  expect(asked).toEqual([]);
  expect(plan.steps.some((x: { title: string }) => x.title.startsWith("install fleetd"))).toBe(true);
  const out = await call("machine_add", { host: "builder-1" });
  const run = await finished(out.run.runId);
  expect(run.state).toBe("done");
  expect(asked).toEqual([[VERSION, otherAsset]]);
  // The build for its OS, not the hub's.
  expect(ran.find((r) => r.command.includes("fleetd.fleetd-tmp"))!.stdin).toBe(otherAsset);
  const install = run.steps.find((x: { title: string }) => x.title.startsWith("install fleetd"));
  expect(install.stdin).toContain(otherAsset);
});

test("a machine whose build is missing says why and installs nothing", async () => {
  otherOs = true;
  missing = true;
  const out = await call("machine_add", { host: "builder-1" });
  const run = await finished(out.run.runId);
  expect(run.state).toBe("failed");
  expect(run.message).toStartWith(`no ${otherAsset} of fleetd ${VERSION}`);
  expect(run.fix).toContain("then run fleetd machine add builder-1");
  // Stopped at the release's SHA256SUMS, before any download or plan step began.
  expect(run.steps.map((x: { title: string; state: string }) => [x.title, x.state])).toEqual([["read the machine's state (read-only)", "done"]]);
  expect(ran.length).toBe(1);
});

test("a machine of another OS that has this version's build already downloads nothing", async () => {
  otherOs = true;
  hasBuild = true;
  const plan = await call("machine_add_plan", { host: "builder-1" });
  const titles = (steps: { title: string }[]) => steps.map((x) => x.title);
  expect(titles(plan.steps).every((x) => !x.startsWith("download fleetd") && !x.startsWith("install fleetd"))).toBe(true);
  const run = await finished((await call("machine_add", { host: "builder-1" })).run.runId);
  expect(run.state).toBe("done");
  expect(asked).toEqual([]);
  expect(titles(run.steps).slice(1)).toEqual(titles(plan.steps));
});

// A released hub is FLEETD_VERSION, not the crate version its install titles name: the release it fetches from is
// its own. Run apart, since VERSION is read once, when the module loads.
test("a released workspace fetches another OS's build from its own release", async () => {
  const script = join(t.home, "released.ts");
  const src = (m: string) => JSON.stringify(join(import.meta.dir, "../src", m));
  writeFileSync(
    script,
    `import { prepare, preparedSteps, resolve } from ${src("cli/setup/machine.ts")};
const asked: string[] = [];
const r = resolve({ host: "builder-1", dryRun: false, home: ${JSON.stringify(t.home)}, enroll: { kind: "hub" }, noService: false, mac: false }, process.execPath);
const runner = { run: async () => ({ code: 0, stdout: ${JSON.stringify(probe().replace(/^os .*$/m, `os ${other[0] === "darwin" ? "Darwin" : "Linux"}`).replace(/^arch .*$/m, `arch ${other[1] === "x64" ? "x86_64" : "arm64"}`))}, stderr: "" }) };
const bytes = new TextEncoder().encode("a build of another OS");
const builds = { digest: async (v: string) => (asked.push(v), new Bun.CryptoHasher("sha256").update(bytes).digest("hex")), build: async () => bytes };
const begun: string[] = [];
const p = await prepare(r, undefined, runner, builds, true, { begin: (b) => begun.push(b.title), done() {}, failed() {}, say() {}, planned: (s) => begun.push(...s.map((b) => b.title)) });
const install = preparedSteps(r, p).find((b) => b.title.startsWith("install fleetd"));
console.log(JSON.stringify({ asked, title: begun.find((x) => x.startsWith("download")), stdin: install?.stdin }));
`,
  );
  const proc = Bun.spawnSync([process.execPath, script], { env: { ...process.env, FLEETD_VERSION: "0.9.1" }, stderr: "pipe" });
  expect(proc.stderr.toString()).toBe("");
  const out = JSON.parse(proc.stdout.toString());
  expect(out.asked).toEqual(["0.9.1"]);
  expect(out.title).toStartWith("download fleetd 0.9.1 for ");
  // The install step names what it copies: the build just fetched, of this very version.
  expect(out.stdin).toBe(`stdin: the fleetd binary ${otherAsset} 0.9.1 (21 bytes)`);
});
