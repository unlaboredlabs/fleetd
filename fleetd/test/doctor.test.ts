// The doctor (crates/fleetd/src/hub/doctor/checks.rs tests, and the service's runs): each check's status, words and
// fix, then doctor_list and doctor_fix over a fresh hub whose probes, commands and sources are fakes.
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import * as c from "../src/hub/doctor/checks.ts";
import { readHubSetup } from "../src/hub/doctor/config.ts";
import { hubSources } from "../src/hub/doctor/sources.ts";
import { doctor, DOCTOR_EVERY_MS, health, runCmd, selfUrl } from "../src/hub/doctor/index.ts";
import type { ClaudeSealedOn, ClaudeTest, DoctorCheck, DoctorFix, GithubApp, OnePasswordTest } from "../src/shared/contracts.ts";
import type { RunnerInfo, WorktreeBase } from "../src/shared/sessions.ts";
import { caller, testHub } from "./hub-helpers.ts";

const NO_SETUP = { machines: {} };

test("a fix says where its command runs, and the identity's runs on the hub", () => {
  const config = {
    gitIdentity: { name: "ada", email: "1+ada@users.noreply.github.com" },
    machines: { "builder-1": { sshHost: "builder-1", local: false, platform: "linux" as const, uid: 1000 } },
  };
  const other = { ok: true as const, probe: { gitEmail: "someone@else.example" } };
  // Set up over SSH: machine setup runs again on the hub.
  let fix = c.commitIdentity("builder-1", other, config).fix!;
  expect([fix.command, fix.on]).toEqual(["fleetd machine add builder-1", "hub"]);
  // Joined with a code: the hub makes the line, one command.
  fix = c.commitIdentity("laptop", other, config).fix!;
  expect([fix.command, fix.on]).toEqual(["fleetd pair --worker laptop", "hub"]);
  // Without the hub's identity, git's config on the machine itself.
  fix = c.commitIdentity("laptop", { ok: true, probe: {} }, NO_SETUP).fix!;
  expect(fix.on).toBe("machine");
  const pass = c.commitIdentity("laptop", { ok: true, probe: { gitEmail: "1+ada@users.noreply.github.com", gitEmailFrom: "env" } }, config);
  expect([pass.status, pass.message]).toEqual([
    "ok",
    "Commits on laptop use 1+ada@users.noreply.github.com (from the service environment, a GitHub noreply address).",
  ]);
  expect(c.commitIdentity("laptop", { ok: false, why: "laptop is offline." }, config)).toEqual({
    id: "laptop/commit_identity",
    scope: "machine",
    machineId: "laptop",
    status: "unknown",
    message: "laptop is offline.",
  });
});

const base = (error?: [WorktreeBase["error"] extends infer E ? (E extends { kind: infer K } ? K : never) : never, string], forkBehind?: number): WorktreeBase => ({
  ref: "origin/main",
  sha: "abc1234def",
  fetchedAt: "2026-10-25T06:00:00Z",
  ...(error ? { error: { kind: error[0], message: error[1] } } : {}),
  ...(forkBehind === undefined ? {} : { forkBehind }),
});

test("a project git can't fetch fails the check with the login fix", () => {
  const now = "2026-10-25T07:00:00Z";
  expect(c.gitFetch("mbp", [], now)).toBeUndefined();
  const fine = c.gitFetch("mbp", [["shop", base()], ["blog", base(["offline", "offline"])]], now)!;
  expect(fine.status).toBe("ok");
  expect(fine.message).toBe(
    "At each project's last start on mbp: shop fetched its remote; blog was offline (from origin/main @abc1234 as of 06:00 UTC).",
  );
  const local = { ...base(["no_remote", "no remote"]), ref: "main" };
  expect(c.gitFetch("mbp", [["notes", local]], now)!.message).toBe("At each project's last start on mbp: notes has no remote.");
  const gone = c.gitFetch("mbp", [["shop", base(["no_access", "ERROR: Repository not found."])]], now)!;
  expect(gone.status).toBe("warn");
  expect(gone.message.startsWith("git can't fetch origin for shop: ERROR: Repository not found. Fix: check the remote's URL")).toBe(true);
  expect(gone.fix?.command).toBe("git remote get-url origin");
  const noSsh = c.gitFetch("mbp", [["shop", base(["no_ssh", "error: cannot run ssh: No such file or directory"])]], now)!;
  expect(noSsh.status).toBe("fail");
  expect(noSsh.message.startsWith("ssh isn't installed, so git can't fetch origin for shop")).toBe(true);
  expect(noSsh.fix?.label).toBe("Install OpenSSH on mbp");
  const refused = c.gitFetch("mbp", [["shop", base(["auth", "git@github.com: Permission denied (publickey)."])]], now)!;
  expect([refused.id, refused.status]).toEqual(["mbp/git_fetch", "fail"]);
  expect(
    refused.message.startsWith(
      "git can't fetch origin for shop: git@github.com: Permission denied (publickey). Fix: `gh auth login` or your SSH key.",
    ),
  ).toBe(true);
  expect(refused.fix?.command).toBe("gh auth login");
  // Another day: the month and day too.
  const yesterday = c.gitFetch("mbp", [["blog", base(["offline", "offline"])]], "2026-10-26T07:00:00Z")!;
  expect(yesterday.message).toContain("as of 10-25 06:00 UTC");
});

test("screens fail with the fix a person runs, and say nothing where they are off or offline", () => {
  const broken = { state: "unavailable", message: "devuser may not use /dev/kvm.", fix: "sudo usermod -aG kvm devuser" };
  const entry = c.androidSessions("devbox", false, broken)!;
  expect([entry.id, entry.status, entry.fix?.command]).toEqual(["devbox/android", "fail", "sudo usermod -aG kvm devuser"]);
  const ready = c.androidSessions("devbox", false, { state: "ready", message: "ok" })!;
  expect([ready.status, ready.fix]).toEqual(["ok", undefined]);
  expect(c.androidSessions("devbox", true, broken)).toBeUndefined();
  expect(c.androidSessions("devbox", false, undefined)).toBeUndefined();
  const ios = c.iosSessions("mac", false, { state: "unavailable", message: "Xcode has no iOS simulator runtime.", fix: "xcodebuild -downloadPlatform iOS" })!;
  expect([ios.id, ios.status, ios.fix?.command]).toEqual(["mac/ios", "fail", "xcodebuild -downloadPlatform iOS"]);
  const desktop = c.desktopSessions("devbox", false, { state: "ready", backend: "xvfb", message: "Desktop screens run on Xvfb." })!;
  expect([desktop.id, desktop.status]).toEqual(["devbox/desktop", "ok"]);
  expect(c.desktopSessions("devbox", false, { state: "unavailable", message: "x", fix: "sudo apt install xvfb" })!.status).toBe("fail");
});

test("a fork behind upstream warns", () => {
  expect(c.forkBehind("mbp", [["shop", base()]])).toBeUndefined();
  expect(c.forkBehind("mbp", [["shop", base(undefined, 0)]])!.status).toBe("ok");
  const check = c.forkBehind("mbp", [["shop", base(undefined, 31)]])!;
  expect([check.id, check.status]).toEqual(["mbp/fork_behind", "warn"]);
  expect(check.message).toBe(
    "shop: your fork's main is 31 behind upstream, and agents start from it; `gh repo sync` brings it up to date.",
  );
});

test("setup checks are there only once their step is set up", () => {
  expect(c.setupChecks({ joined: [], onepassword: [] })).toEqual([]);
  const got = c.setupChecks({ joined: ["Alice", "Bo", "Cy"], onepassword: [] }).map((e) => [e.id, e.status, e.message]);
  expect(got).toEqual([["hub/people", "ok", "Alice and 2 others have joined."]]);
  expect(c.setupChecks({ joined: ["Alice", "Bo"], onepassword: [] })[0]!.message).toBe("Alice and Bo have joined.");
});

test("a repo with no CI fails with the add-CI fix", () => {
  expect(c.repoCi([]).status).toBe("ok");
  const held = c.repoCi(["acme/app"]);
  expect([held.id, held.status, held.fix?.label]).toEqual([
    "hub/repo_ci",
    "fail",
    "Add a GitHub Actions workflow that runs on pull requests to acme/app",
  ]);
});

test("plain HTTP is fine only on loopback and the tailnet", () => {
  for (const url of [
    "http://127.0.0.1:4790",
    "http://localhost:4790/",
    "http://[::1]:4790",
    "http://100.101.102.103:4790",
    "http://devbox.tail1234.ts.net:4790",
    "http://[fd7a:115c:a1e0::b430:f932]:4790",
  ]) {
    expect(c.sealedHttp(url), url).toBeDefined();
  }
  for (const url of ["http://192.168.8.227:4790", "http://100.128.0.1:4790", "http://devbox.example.com", "http://10.0.0.2:4790", "http://[fe80::1]:4790"]) {
    expect(c.sealedHttp(url), url).toBeUndefined();
  }
});

const runner = (version: string | undefined, login: RunnerInfo["login"], proxy?: string): RunnerInfo => ({
  runner: "claude",
  ...(version === undefined ? {} : { version }),
  supported: ">=2.1.300, <2.2.0",
  versionOk: true,
  login,
  conformanceOk: true,
  ...(proxy === undefined ? {} : { proxy }),
});

test("a degraded machine gets the one fix for its cause", () => {
  const degraded: c.MachineView = {
    machineId: "mac",
    status: "degraded",
    lastSeenAt: "now",
    degradedReason: "claude is not logged in. Fix: claude auth login",
  };
  const fix = (info?: RunnerInfo) => {
    const entry = c.machineOnline(degraded, undefined, info);
    expect(entry.message).toBe("mac is degraded: claude is not logged in.");
    return [entry.fix!.label, entry.fix!.command];
  };
  const ok = "2.1.314 (Claude Code)";
  expect(fix(runner(ok, "logged_out"))).toEqual(["Log claude in on mac", "claude auth login"]);
  const [label, command] = fix(runner(ok, "logged_out", "http://127.0.0.1:8317"));
  expect(command).toBeUndefined();
  expect(label).toContain("log in with your proxy");
  expect(label).toContain("8317");
  // A version outside the tested range is never the cause.
  expect(fix(runner("2.0.1", "logged_out"))[1]).toBe("claude auth login");
  expect(fix(runner(undefined, "unknown"))[1]).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  // Two causes: one ordered sentence, the install first.
  expect(fix({ ...runner(ok, "logged_out"), conformanceOk: false })).toEqual([
    "On mac: claude install 2.1.314, then claude auth login",
    undefined,
  ]);
  // No runner report: the node's own fix, never a restart for a login problem.
  expect(fix(undefined)[1]).toBe("claude auth login");
  // No runner cause at all: the node itself is the problem.
  const down = { ...degraded, degradedReason: "its node's runner is unavailable" };
  expect(c.machineOnline(down, undefined, runner(ok, "logged_in")).fix?.command).toBe("systemctl --user restart fleetd-node.service");
  const mac = { sshHost: "mac", local: false, platform: "darwin" as const, uid: 501 };
  const offline = c.machineOnline({ machineId: "mac", status: "offline", lastSeenAt: "2026-11-08T09:00:00.000Z" }, mac);
  expect([offline.status, offline.message, offline.fix?.command]).toEqual([
    "fail",
    "mac is offline (last seen 2026-11-08T09:00:00.000Z).",
    "launchctl kickstart -k gui/501/sh.fleetd.node",
  ]);
});

const sealed = (machineId: string): ClaudeSealedOn => ({ machineId, fingerprint: "0123abcd" }) as ClaudeSealedOn;
const tested = (ok: boolean): ClaudeTest =>
  ({ at: "2026-10-27T10:00:00.000Z", machineId: "devbox", ok, ...(ok ? {} : { error: "Invalid API key · Fix external API key" }) }) as ClaudeTest;

test("the GitHub App check reads its installations and last Test", () => {
  const app = (installed: boolean, t?: [boolean, string]) =>
    ({
      appId: 1,
      slug: "fleetd-on-devbox",
      name: "fleetd on devbox",
      clientId: "Iv23li",
      owner: "acme",
      htmlUrl: "https://github.com/apps/fleetd-on-devbox",
      settingsUrl: "https://github.com/organizations/acme/settings/apps/fleetd-on-devbox",
      createdAt: "2026-10-28T10:00:00.000Z",
      installations: installed ? [{ installationId: 7, account: "acme", allRepositories: true, repositoryCount: 3 }] : [],
      ...(t ? { lastTest: { at: "2026-10-28T10:00:00.000Z", ok: t[0], said: t[1] } } : {}),
    }) as unknown as GithubApp;
  const at = (e: DoctorCheck) => [e.id, e.status, e.message];
  expect(at(c.githubApp(app(false)))).toEqual([
    "hub/github_app",
    "warn",
    'The hub\'s GitHub App "fleetd on devbox" isn\'t installed on any repository yet.',
  ]);
  expect(c.githubApp(app(true, [false, "GitHub refused (401)."])).status).toBe("fail");
  expect(at(c.githubApp(app(true, [true, "It works."])))).toEqual(["hub/github_app", "ok", "It works."]);
  expect(c.githubApp(app(true)).message).toBe('The hub\'s GitHub App "fleetd on devbox" is installed on acme.');
  expect(c.githubApp(app(false)).fix?.command).toBe("fleetd github-app test");
});

test("the cloud checks read the key, the way, the machines and the budget", () => {
  const base: c.CloudFacts = {
    enabled: true,
    poolSize: 2,
    keyTest: { ok: true, said: "Key works · $20 plan" } as c.CloudFacts["keyTest"],
    machines: [
      ["boat-1", "awake"],
      ["boat-2", "asleep"],
    ],
    spend: "Today $0.41 of $3.00 · this month $6.10 of $20.00",
  };
  const got = (f: c.CloudFacts) => c.cloudChecks(f).map((e) => [e.id, e.status, e.message]);
  expect(got(base)).toEqual([
    ["hub/cloud_key", "ok", "Key works · $20 plan"],
    [
      "hub/cloud_network",
      "ok",
      "Cloud machines reach the hub through the SSH tunnel the hub opens to each: the hub needs no public address.",
    ],
    ["hub/cloud_machines", "ok", "2 cloud machines: 1 awake, 1 asleep."],
    ["hub/cloud_budget", "ok", "Today $0.41 of $3.00 · this month $6.10 of $20.00."],
  ]);
  const one = (f: c.CloudFacts, id: string) => {
    const e = c.cloudChecks(f).find((x) => x.id === `hub/${id}`)!;
    return [e.status, e.message];
  };
  const { keyTest: _k, ...noKeyTest } = base;
  expect(one(noKeyTest, "cloud_key")[0]).toBe("unknown");
  expect(one({ ...base, paused: ["key", "boat.dev key refused: Settings › Hub › Machines"] }, "cloud_key")).toEqual([
    "fail",
    "boat.dev key refused: Settings › Hub › Machines",
  ]);
  // None joined yet: the Test is what tells, and it names the step it stopped at.
  const fresh: c.CloudFacts = { ...base, machines: [["boat-1", "creating"]] };
  expect(one(fresh, "cloud_network")[0]).toBe("unknown");
  const withTest = (ok: boolean | undefined, said: string): c.CloudFacts => ({
    ...fresh,
    pathTest: { machineId: "boat-1", said, ...(ok === undefined ? {} : { ok }) } as c.CloudFacts["pathTest"],
  });
  const failed = "boat-1: no hello within 2 minutes of its wake: the hub's tunnel to it didn't come up (refused)";
  const network = c.cloudChecks(withTest(false, failed));
  expect([network[1]!.status, network[1]!.message]).toEqual(["fail", failed]);
  expect(network[1]!.fix?.command).toBeUndefined();
  expect(one(withTest(undefined, "boat-1: waking"), "cloud_network")).toEqual(["unknown", "boat-1: waking"]);
  expect(one(withTest(true, "boat-1: its node said hello"), "cloud_network")[0]).toBe("ok");
  expect(one({ ...base, machines: [["boat-1", "broken"], ["boat-2", "asleep"]] }, "cloud_machines")).toEqual([
    "fail",
    "boat-1 didn't come back from two wakes in a row, so the hub won't wake it again.",
  ]);
  expect(one({ ...base, machines: [] }, "cloud_machines")[0]).toBe("unknown");
  expect(one({ ...base, machines: [["boat-1", "asleep"]] }, "cloud_machines")).toEqual(["unknown", "1 of 2 cloud machines made."]);
  expect(
    one({ ...base, machines: [["boat-1", "asleep"], ["boat-2", "failed", "its setup failed: claude"]] }, "cloud_machines"),
  ).toEqual(["warn", "Not made: boat-2 (its setup failed: claude)."]);
  expect(one({ ...base, enabled: false }, "cloud_machines")[0]).toBe("warn");
  expect(one({ ...base, over: "Cloud paused: today's boat.dev budget ($3.00) is spent" }, "cloud_budget")).toEqual([
    "warn",
    "Cloud paused: today's boat.dev budget ($3.00) is spent. Today $0.41 of $3.00 · this month $6.10 of $20.00.",
  ]);
  expect(one({ ...base, paused: ["billing", "boat.dev needs billing attention"] }, "cloud_budget")[0]).toBe("fail");
});

test("the 1Password check passes on one vault and says what to do on more", () => {
  const t = (vaults: string[]): OnePasswordTest => ({ at: "2026-11-07T10:00:00.000Z", machineId: "devbox", ok: true, vaults }) as OnePasswordTest;
  const at = (tokens: [string, OnePasswordTest?][]) => {
    const e = c.onepasswordVault(tokens);
    return e ? [e.status, e.message, e.fix] : undefined;
  };
  expect(at([])).toBeUndefined();
  expect(at([["Ann", t(["fleetd"])]])).toEqual(["ok", "Ann's 1Password token reads one vault, fleetd.", undefined]);
  const [status, said, fix] = at([["Ann", t(["fleetd"])], ["Bob", t(["Private", "Shared", "fleetd"])]])! as [string, string, DoctorFix];
  expect(status).toBe("warn");
  expect(said).toBe(
    "Bob's 1Password token reads 3 vaults (Private, Shared, fleetd): an agent on a machine holding it could read every item in each. Keep it to one vault with only what fleetd needs.",
  );
  expect(fix.label.startsWith("Bob makes a service account for only fleetd's vault")).toBe(true);
  expect(fix.label).toContain("(https://start.1password.com/developer-tools/active)");
  expect(fix.label).toContain("Settings › Your accounts › 1Password and revokes the old one");
  expect(at([["Ann", t([])]])![0]).toBe("warn");
  // Two as bad: both named.
  const both = at([["Ann", t(["A", "B"])], ["Bob", t(["C", "D"])]])![1] as string;
  expect(both.startsWith("Ann's") && both.includes(" Bob's")).toBe(true);
  // A failed Test outranks a token reading too much.
  const failed = { ...t([]), ok: false, error: "Invalid token: ***OP_SERVICE_ACCOUNT_TOKEN***." } as OnePasswordTest;
  expect(at([["Ann", failed], ["Bob", t(["A", "B"])]])!.slice(0, 2)).toEqual([
    "fail",
    "Ann's 1Password token failed its Test on devbox: Invalid token: ***OP_SERVICE_ACCOUNT_TOKEN***.",
  ]);
  expect(at([["Ann", undefined], ["Bob", t(["fleetd"])]])!.slice(0, 2)).toEqual([
    "unknown",
    "Ann's 1Password token is saved but not tested yet.",
  ]);
});

test("the Claude checks read the key and the owner's subscription", () => {
  const at = (e: DoctorCheck) => [e.id, e.status, e.message];
  const machines = ["devbox", "buildbox"];
  const none: c.ClaudeSetupView = { owner: ["Sam Rivera", undefined], machines, configured: false };
  expect(at(c.claudeKey(none))).toEqual(["hub/claude_key", "unknown", "The hub has no Claude API key."]);
  expect(at(c.claudeOwner(none))).toEqual([
    "hub/claude_owner",
    "unknown",
    "Sam Rivera, the hub's owner, has no Claude subscription connected.",
  ]);
  const api = (sealedOn: ClaudeSealedOn[], lastTest?: ClaudeTest) =>
    ({ endpoint: "https://gateway.devbox.example", sealedOn, updatedAt: "2026-10-27T09:00:00.000Z", ...(lastTest ? { lastTest } : {}) }) as c.ClaudeSetupView["hubApi"];
  const withApi = (a: c.ClaudeSetupView["hubApi"]): c.ClaudeSetupView => ({ ...none, hubApi: a, configured: true });
  const both = [sealed("devbox"), sealed("buildbox")];
  const failed = c.claudeKey(withApi(api(both, tested(false))));
  expect(failed.status).toBe("fail");
  expect(failed.message).toBe(
    "The hub's Claude API key (through https://gateway.devbox.example) failed its Test on devbox: Invalid API key · Fix external API key.",
  );
  const partly = c.claudeKey(withApi(api([sealed("devbox")], tested(true))));
  expect(partly.status).toBe("warn");
  expect(partly.message).toContain("isn't on buildbox");
  expect(partly.fix?.label).toBe("Save it again while buildbox is online");
  expect(c.claudeKey(withApi(api(both))).status).toBe("unknown");
  expect(c.claudeKey(withApi(api(both, tested(true)))).status).toBe("ok");
  const owner = (lastTest?: ClaudeTest): c.ClaudeSetupView => ({
    ...none,
    configured: true,
    owner: ["Sam Rivera", { sealedOn: both, connectedAt: "2026-10-27T09:00:00.000Z", ...(lastTest ? { lastTest } : {}) } as never],
  });
  expect(at(c.claudeOwner(owner(tested(true))))).toEqual([
    "hub/claude_owner",
    "ok",
    "Sam Rivera's Claude subscription works: tested on devbox.",
  ]);
  const expired = c.claudeOwner(owner(tested(false)));
  expect(expired.status).toBe("fail");
  expect(expired.fix?.label).toContain("claude setup-token");
});

test("claude settings that outrank the account warn", () => {
  const info = (accountOverrides?: string[]): RunnerInfo => ({
    ...runner(undefined, "logged_in"),
    configDir: "/home/ada/.claude",
    ...(accountOverrides ? { accountOverrides } : {}),
  });
  const set = info(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"]);
  expect(c.claudeAccountOverride("devbox", set, false)).toBeUndefined();
  expect(c.claudeAccountOverride("devbox", info(), true)).toBeUndefined();
  const warned = c.claudeAccountOverride("devbox", set, true)!;
  expect([warned.id, warned.status]).toEqual(["devbox/claude_account_override", "warn"]);
  expect(warned.message).toBe(
    '/home/ada/.claude/settings.json on devbox sets ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY in its "env", which claude applies over the Claude account fleetd gives each session there.',
  );
  expect(c.claudeAccountOverride("devbox", info([]), true)!.status).toBe("ok");
});

test("the doctor checks claude doesn't update itself", () => {
  const info = (selfUpdate?: boolean): RunnerInfo => ({
    ...runner("2.1.314 (Claude Code)", "logged_in"),
    configDir: "/home/u/.claude",
    ...(selfUpdate === undefined ? {} : { selfUpdate }),
  });
  const last = (i: RunnerInfo) => c.runnerChecks("mac", i).pop()!;
  const off = last(info(false));
  expect([off.id, off.status]).toEqual(["mac/claude_self_update", "ok"]);
  const on = last(info(true));
  expect([on.id, on.status]).toEqual(["mac/claude_self_update", "warn"]);
  expect(on.fix!.label).toContain('"DISABLE_AUTOUPDATER": "1"');
  expect(on.fix!.label).toContain("/home/u/.claude/settings.json");
  expect(c.runnerChecks("mac", info()).length).toBe(3);
});

test("claude checks from the runner's report", () => {
  const info = (version: string | undefined, login: RunnerInfo["login"], conformanceOk?: boolean): RunnerInfo => {
    const { conformanceOk: _c, ...rest } = runner(version, login);
    return { ...rest, loginKind: "subscription", ...(conformanceOk === undefined ? {} : { conformanceOk }) };
  };
  const statuses = (i: RunnerInfo) => c.runnerChecks("mac", i).map((e) => [e.id, e.status]);
  expect(statuses(info("2.1.314 (Claude Code)", "logged_in", true))).toEqual([
    ["mac/claude_version", "ok"],
    ["mac/claude_login", "ok"],
    ["mac/runner_conformance", "ok"],
  ]);
  const bad = c.runnerChecks("mac", info("2.2.1", "logged_out", false));
  // Past the tested range: a warning with the tested version, never a refusal.
  expect([bad[0]!.status, bad[0]!.fix?.command]).toEqual(["warn", "claude install 2.1.314"]);
  const older = c.runnerChecks("mac", info("2.1.296", "logged_in", true));
  expect([older[0]!.status, older[0]!.fix?.command]).toEqual(["warn", "claude update"]);
  expect(bad[1]!.fix?.command).toBe("claude auth login");
  // Behind a proxy the proxy holds the login: no `claude auth login`, and the message names the proxy.
  const proxied = c.runnerChecks("mac", {
    ...info("2.1.314 (Claude Code)", "logged_out", true),
    proxy: "http://127.0.0.1:8317",
    proxySource: "~/.claude/settings.json",
    configDir: "/Users/ada/.claude",
  });
  expect(proxied[1]!.fix?.command).toBeUndefined();
  expect(proxied[1]!.fix?.label).toContain("log in with your proxy");
  const ok = c.runnerChecks("mac", {
    ...info("2.1.314 (Claude Code)", "logged_in", true),
    loginLabel: "Max",
    proxy: "http://127.0.0.1:8317",
    proxySource: "~/.claude/settings.json",
    configDir: "/Users/ada/.claude",
  });
  expect(ok[1]!.message).toBe(
    "mac: claude 2.1.314, logged in (Max), via proxy http://127.0.0.1:8317 from ~/.claude/settings.json.",
  );
  expect(bad[2]!.status).toBe("fail");
  expect(c.runnerChecks("mac", info("2.1.399", "logged_in", true))[0]!.status).toBe("ok");
  expect(c.runnerChecks("mac", info(undefined, "unknown"))[0]!.fix?.command).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  // A node from before configDir ran in fleetd's old profile, which the message names.
  expect(c.runnerChecks("mac", info("2.1.314 (Claude Code)", "logged_in", true))[1]!.message).toBe(
    "mac: claude 2.1.314, logged in (subscription), config ~/.fleetd/claude.",
  );
});

test("disk, usage, recovery, unowned sessions and the Mac's own checks", () => {
  const disk = { freeBytes: 12e9, totalBytes: 500e9, minFreeBytes: 20e9 };
  expect(c.diskSpace("devbox", false, disk, undefined).message).toBe(
    "12.0 GB free of 500.0 GB where devbox's worktrees live; new agents pause below 20.0 GB.",
  );
  const held = c.diskSpace("devbox", false, disk, "Paused new agents: 12.0 GB free on devbox");
  expect([held.status, held.fix?.label]).toEqual(["fail", "Free disk space on devbox: a writer's worktree goes once its PR merges"]);
  expect(c.diskSpace("devbox", false, undefined, undefined).status).toBe("unknown");
  expect(c.usageBreaker("devbox", { state: "closed" }).status).toBe("ok");
  const open = c.usageBreaker("devbox", { state: "open", until: "11:00 UTC" });
  expect([open.status, open.message, open.fix?.label]).toEqual([
    "warn",
    "New turns on devbox are paused by the usage breaker.",
    "Wait for the reset (11:00 UTC), or once the login has capacity press Resume in the app, or run fleetd usage resume devbox",
  ]);
  const paused = c.recoveryBreaker("devbox", { openedBy: ["T1", "T2", "T3"], waiting: ["T4"], until: "10:42 UTC" });
  expect(paused.message).toBe(
    "Automatic recovery is paused on devbox: 3 agents died there within 10 min (T1, T2, T3). 1 waits: T4. It resumes at 10:42 UTC if no other agent dies there, or once one there completes.",
  );
  const many = Array.from({ length: 7 }, (_, i) => ({ threadId: `t${i}`, title: `Session ${i}` }));
  expect(c.unownedSessions("devbox", false, many).message).toBe(
    'devbox runs 7 sessions no agent or lead of this hub owns: "Session 0" (t0), "Session 1" (t1), "Session 2" (t2), "Session 3" (t3), "Session 4" (t4) and 2 more. Nothing watches or counts them.',
  );
  expect(c.unownedSessions("devbox", true, many).status).toBe("unknown");
  const mac = c.macSetup("mac", false, {
    user: "ada",
    checks: [{ id: "xcode", state: "fail", message: "Xcode is missing.", fix: "Install Xcode", command: "xcode-select --install" }],
  });
  expect(mac.map((e) => [e.id, e.status, e.fix?.label, e.fix?.command])).toEqual([
    ["mac/mac_xcode", "fail", "Install Xcode; mac checks again within a minute", "xcode-select --install"],
  ]);
  const twin = c.macOneNode("mac", ["mac-old"]);
  expect([twin.status, twin.fix?.command, twin.fix?.on]).toEqual(["fail", "fleetd machine remove mac-old", "hub"]);
  // Messages are cut at 500 characters, the last one an ellipsis.
  const long = c.unownedSessions("devbox", false, [{ threadId: "t", title: "x".repeat(600) }]);
  expect(long.message).toContain(`"${"x".repeat(59)}…" (t)`);
});

test("setup.json: absent is empty, invalid says why, and the hub's own address on loopback", () => {
  const { hub, home, done } = testHub();
  try {
    expect(readHubSetup(home)).toEqual([{ machines: {} }, undefined]);
    writeFileSync(join(home, "setup.json"), '{"machines":{"a":{"sshHost":"a","platform":"windows","uid":1}}}');
    const [config, problem] = readHubSetup(home);
    expect(config).toEqual({ machines: {} });
    expect(problem?.startsWith(`${join(home, "setup.json")} is not valid: `)).toBe(true);
    expect(c.httpsReachable(config, problem, 4790).status).toBe("warn");
    expect(selfUrl("0.0.0.0", 4790)).toBe("http://127.0.0.1:4790");
    expect(selfUrl("::", 4790)).toBe("http://[::1]:4790");
    expect(hub.config.home).toBe(home);
  } finally {
    done();
  }
});

// The service over a fresh hub: its probes, commands and sources faked.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function doctorHub() {
  const t = testHub(Date.parse("2026-11-08T10:00:00Z"));
  cleanup = t.done;
  const d = doctor(t.hub);
  const machines: c.MachineView[] = [
    { machineId: "devbox", status: "online", lastSeenAt: "2026-11-08T09:59:00.000Z" },
    { machineId: "lab-b", status: "offline", lastSeenAt: "2026-11-08T08:00:00.000Z" },
  ];
  let probes = 0;
  d.health = async () => ({ ok: true });
  d.runCmd = async () => ({ ran: true, exitCode: 0, stdout: "", stderr: "Logged in to github.com account ada (keyring)" });
  Object.assign(d.sources, {
    machines: () => machines,
    runnerInfo: async () => runner("2.1.314 (Claude Code)", "logged_in"),
    probe: async () => {
      probes++;
      return { ok: true, probe: { gitEmail: "ada@devbox.example" } };
    },
    load: () => ({ cpus: 4, load1: 0.5, disk: { freeBytes: 100e9, totalBytes: 500e9, minFreeBytes: 20e9 } }),
    claudeSetup: () => undefined,
  });
  const registry = new Registry();
  registerAll(registry);
  const call = async (name: string, input: unknown, who = caller("admin")) => {
    const out = await registry.call(t.hub, who, name, input);
    if ("output" in out) return out.output;
    throw out.error.kind === "tool" ? out.error.error : new Error(out.error.kind);
  };
  return { ...t, d, machines, call, probes: () => probes };
}

test("doctor_list runs every check once, then answers from the last run until rerun", async () => {
  const { d, call, probes } = doctorHub();
  const first = (await call("doctor_list", {})) as { checks: DoctorCheck[]; checkedAt: string; next: string };
  const ids = first.checks.map((x) => x.id);
  expect(ids.slice(0, 4)).toEqual(["hub/reachable", "hub/gh_auth", "hub/https", "hub/repo_ci"]);
  expect(ids).toContain("devbox/claude_login");
  expect(ids).toContain("lab-b/online");
  // Machine checks follow the hub's, in machine id order.
  expect(ids.indexOf("devbox/online")).toBeLessThan(ids.indexOf("lab-b/online"));
  expect(first.checks.find((x) => x.id === "hub/gh_auth")?.message).toBe("gh is logged in on the hub as ada.");
  expect(first.checks.find((x) => x.id === "lab-b/commit_identity")?.message).toBe("lab-b is offline.");
  expect(first.checks.find((x) => x.id === "devbox/online")).toMatchObject({ checkedAt: "2026-11-08T10:00:00.000Z" });
  expect(first.next).toBe("Each failing check names the command that fixes it.");
  expect(probes()).toBe(1);
  await call("doctor_list", {});
  expect(probes()).toBe(1);
  await call("doctor_list", { rerun: true });
  expect(probes()).toBe(2);
  // One machine's checks, and a key that can't read the other's.
  const one = (await call("doctor_list", { machineId: "devbox" })) as { checks: DoctorCheck[] };
  expect(one.checks.every((x) => x.machineId === "devbox")).toBe(true);
  const narrow = { ...caller("read"), grants: [{ role: "read" as const, machines: ["devbox"] }] };
  const seen = (await call("doctor_list", {}, narrow)) as { checks: DoctorCheck[] };
  expect(seen.checks.some((x) => x.machineId === "lab-b")).toBe(false);
  expect(seen.checks.some((x) => x.scope === "hub")).toBe(true);
  await expect(call("doctor_list", { machineId: "lab-b" }, narrow)).rejects.toMatchObject({ code: "forbidden" });
  expect(d).toBeDefined();
});

test("a status change emits one doctor.changed per machine; the first run is the baseline", async () => {
  const { hub, d, machines, clock } = doctorHub();
  await d.list(false);
  const list = () => (hub.db.conn.query("SELECT data FROM events WHERE type = 'doctor.changed' ORDER BY seq").all() as { data: string }[]).map((r) => JSON.parse(r.data));
  expect(list()).toEqual([]);
  // lab-b comes back: the minute's run checks it again, and only it.
  machines[1] = { machineId: "lab-b", status: "online", lastSeenAt: "2026-11-08T10:00:30.000Z" };
  clock.ms += 60_000;
  await d.runIfDue();
  const [e] = list();
  expect(e).toMatchObject({ type: "doctor.changed", machineId: "lab-b" });
  expect(e.summary.startsWith("doctor: lab-b/online fail → ok")).toBe(true);
  expect(e.data.changes[0]).toEqual({ id: "lab-b/online", to: "ok", from: "fail" });
  // A check new since the baseline counts only when it isn't ok: lab-b/claude_version etc. were new and ok.
  expect(e.data.changes.some((x: { id: string }) => x.id === "lab-b/claude_version")).toBe(false);
  const results = await d.list(false);
  expect(results.machinesCheckedAt.get("lab-b")).toBe("2026-11-08T10:01:00.000Z");
  expect(results.machinesCheckedAt.get("devbox")).toBe("2026-11-08T10:00:00.000Z");
  // The hub's own check failing, at the next full run.
  d.health = async () => ({ ok: false, why: "ECONNREFUSED" });
  clock.ms += DOCTOR_EVERY_MS;
  await d.runIfDue();
  const hubChange = list().find((x) => x.machineId === undefined);
  expect(hubChange.summary).toBe("doctor: hub/reachable ok → fail");
});

test("doctor_fix answers with the command a person runs, and only for admins or a person's device", async () => {
  const { call } = doctorHub();
  await expect(call("doctor_fix", { checkId: "lab-b/online" }, caller("operate"))).rejects.toMatchObject({ code: "forbidden" });
  await expect(call("doctor_fix", { checkId: "lab-b/online" })).rejects.toMatchObject({
    code: "invalid",
    message: "lab-b/online needs a person: Restart the fleetd node on lab-b.",
    fix: "systemctl --user restart fleetd-node.service",
  });
  await expect(call("doctor_fix", { checkId: "devbox/online" }, caller("operate", true))).rejects.toMatchObject({
    message: "devbox/online has nothing to fix (ok).",
  });
  await expect(call("doctor_fix", { checkId: "nope/online" })).rejects.toMatchObject({
    message: "No machine nope.",
    fix: "Call doctor_list for the current checks.",
  });
  await expect(call("doctor_fix", { checkId: "hub/nothing" })).rejects.toMatchObject({ message: "No doctor check hub/nothing." });
});

test("a missing binary, a command's exit and a dead URL are what the hub checks read", async () => {
  expect(await runCmd("fleetd-no-such-binary-xyz", [])).toEqual({ ran: false, error: "ENOENT" });
  const sh = await runCmd("sh", ["-c", "echo out; echo err >&2; exit 3"]);
  expect(sh).toEqual({ ran: true, exitCode: 3, stdout: "out\n", stderr: "err\n" });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => new Response("", { status: new URL(r.url).pathname === "/healthz" ? 502 : 200 }) });
  try {
    expect(await health(`http://127.0.0.1:${server.port}`)).toEqual({ ok: false, why: "HTTP 502" });
  } finally {
    server.stop(true);
  }
  expect(await health(`http://127.0.0.1:${server.port}`)).toEqual({ ok: false, why: "ECONNREFUSED" });
});

test("the hub's own sources read a fresh hub as nothing set up", async () => {
  const t = testHub();
  cleanup = t.done;
  const s = hubSources(t.hub);
  expect(s.machines()).toEqual([]);
  expect(s.setupFacts()).toEqual({ joined: [], onepassword: [] });
  expect(s.reposWithoutCi()).toEqual([]);
  expect(s.bases("lab-a")).toEqual([]);
  expect(s.sameComputer("lab-a")).toEqual([]);
  expect(s.claudeSetup()).toEqual({ configured: false, machines: [] });
  expect(await s.probe("lab-a")).toEqual({ ok: false, why: "lab-a's node is not linked to the hub" });
  expect(await s.runnerInfo("lab-a")).toBeUndefined();
  // The usage area's own view of the machine's breaker: closed on a hub with no limit hit.
  expect(await s.usageBreaker("lab-a")).toMatchObject({ state: "closed" });
  // A full run over it: the hub's checks only, none of them throwing.
  const d = doctor(t.hub);
  d.health = async () => ({ ok: true });
  d.runCmd = async () => ({ ran: false, error: "ENOENT" });
  const results = await d.list(false);
  expect(results.checks.map((x) => x.id)).toEqual(["hub/reachable", "hub/gh_auth", "hub/https", "hub/repo_ci", "hub/claude_key", "hub/claude_owner"]);
  expect(results.checks[1]!.status).toBe("fail");
});
