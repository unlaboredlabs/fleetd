// `machine add` and `machine remove` through the API the hub's machine_setup calls: a fake Runner stands in for SSH,
// so nothing runs on any machine; the hub's database is a scratch home's.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubDb } from "../../src/hub/store/db.ts";
import {
  type Begin,
  candidates,
  execute,
  type HubSide,
  leadsOn,
  prepare,
  type Progress,
  releases,
  remove,
  resolve,
  type Runner,
} from "../../src/cli/setup/machine.ts";

let home: string;
let hubHome: string;
let db: HubDb;
const saved = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-machine-"));
  hubHome = join(home, "hub");
  process.env.FLEETD_HOME = home;
  db = HubDb.open(hubHome);
  writeFileSync(
    join(hubHome, "setup.json"),
    JSON.stringify({ listen: "127.0.0.1:1", url: "http://devbox.example:4790", gitIdentity: { name: "Dev", email: "dev@example.com" }, machines: {} }),
  );
});
afterEach(() => {
  db.conn.close();
  rmSync(home, { recursive: true, force: true });
  process.env = { ...saved };
});

/** A machine fleetd never touched: the probe's lines for it. */
const freshProbe = [
  "home /home/dev",
  "fleetd /home/dev/.fleetd",
  "config /home/dev/.config",
  "user dev",
  "uid 1000",
  "os Linux",
  `arch ${process.arch === "x64" ? "x86_64" : "aarch64"}`,
  "path /usr/bin:/bin",
  "claude /home/dev/.local/bin/claude",
  "claude_version 2.1.314 (Claude Code)",
  "linger yes",
  "loaded_unit ",
  "gui unknown",
].join("\n");

type Ran = { command: string; stdin?: string };

/** Answers the probe with `freshProbe`, `claude auth status` as logged in, and every other step with exit 0. */
function fake(ran: Ran[]): Runner {
  return {
    async run(_target, command, stdin) {
      ran.push({ command, ...(stdin === undefined ? {} : { stdin: new TextDecoder().decode(stdin).slice(0, 80) }) });
      if (command.startsWith("H=$HOME")) return { code: 0, stdout: freshProbe, stderr: "" };
      if (command.includes("auth status --json")) return { code: 0, stdout: '{"loggedIn":true}', stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function collect(): Progress & { lines: string[]; plan: Begin[] } {
  const lines: string[] = [];
  const plan: Begin[] = [];
  return {
    lines,
    plan,
    planned(steps: Begin[]) {
      plan.push(...steps);
    },
    begin: (s: Begin) => void lines.push(`begin ${s.title}`),
    done: () => {},
    failed: (code: number) => void lines.push(`failed ${code}`),
    say: (l: string) => void lines.push(l),
  };
}

test("add plans from the probe, mints the enroll code, records the machine and checks claude's login", async () => {
  const exe = process.execPath;
  const r = resolve({ host: "dev@builder-1", dryRun: false, enroll: { kind: "hub" }, noService: true, mac: false }, exe);
  expect(r.machineId).toBe("builder-1");
  const ran: Ran[] = [];
  const side: HubSide = { db, home: hubHome, by: "a test" };
  const progress = collect();
  const prepared = await prepare(r, side, fake(ran), releases, false, progress);
  expect(prepared.plan.steps.map((s) => s.title)).toEqual([
    "create fleetd's directories",
    "install fleetd 0.0.0",
    "enroll the node with a one-time token (sent on stdin)",
  ]);
  // --no-service: no wait for the node is planned.
  expect(progress.plan.map((b) => b.stage.kind)).toEqual(["step", "step", "step"]);
  const added = await execute(r, prepared, side, fake(ran), progress);
  expect(added.loggedIn).toBe(true);
  expect(added.runByHand).toContain("GIT_AUTHOR_NAME=Dev");
  expect(ran.find((x) => x.command.includes("node join"))?.stdin).toMatch(/^fle_[a-z2-7]{52}\n$/);
  const setup = JSON.parse(readFileSync(join(hubHome, "setup.json"), "utf8"));
  expect(setup.machines["builder-1"]).toEqual({ sshHost: "dev@builder-1", platform: "linux", home: "/home/dev", configHome: "/home/dev/.config", uid: 1000 });
});

test("remove runs the undo steps, erases each project through the erase it is given, and forgets the machine", async () => {
  writeFileSync(
    join(hubHome, "setup.json"),
    JSON.stringify({
      listen: "127.0.0.1:1",
      url: "http://devbox.example:4790",
      machines: { "builder-1": { sshHost: "builder-1", platform: "linux", home: "/home/dev", configHome: "/home/dev/.config", uid: 1000 } },
    }),
  );
  db.conn.query("INSERT INTO node_keys (machine_id, pub_key) VALUES ('builder-1', 'k')").run();
  const ran: Ran[] = [];
  const erased: string[] = [];
  const side: HubSide = { db, home: hubHome, by: "a test", erase: (_db, _home, r) => void erased.push(r.projectId) };
  expect(leadsOn(side, "builder-1")).toBeUndefined();
  const progress = collect();
  const removed = await remove(hubHome, "builder-1", true, side, fake(ran), progress);
  expect(removed).toEqual({ revoked: true, remoteOk: true });
  expect(ran.map((x) => x.command.split(" ")[0])).toEqual(["XDG_RUNTIME_DIR=/run/user/1000", "if", "rm", "XDG_RUNTIME_DIR=/run/user/1000"]);
  expect(progress.lines).toContain("revoked builder-1's node key; the hub refuses that node from now on.");
  expect(JSON.parse(readFileSync(join(hubHome, "setup.json"), "utf8")).machines).toEqual({});
});

test("candidates: this machine first, then those set up, then ssh hosts and peers, each id once", () => {
  const out = candidates(
    { "builder-1": { sshHost: "builder-1.example", platform: "linux", home: "/h", configHome: "/h/.config", uid: 1 } },
    ["builder-1", "mac-mini.local"],
    [{ name: "studio", dnsName: "studio.tailnet.example" }],
  );
  expect(out.slice(1)).toEqual([
    { machineId: "builder-1", host: "builder-1.example", found: "set_up" },
    { machineId: "mac-mini", host: "mac-mini.local", found: "ssh_config" },
    { machineId: "studio", host: "studio.tailnet.example", found: "tailnet" },
  ]);
});
