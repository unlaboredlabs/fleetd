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
  releaseOf,
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

/** Answers the probe with `probe`, `claude auth status` as logged in, and every other step with exit 0. */
function fake(ran: Ran[], probe = freshProbe): Runner {
  return {
    async run(_target, command, stdin) {
      ran.push({ command, ...(stdin === undefined ? {} : { stdin: new TextDecoder().decode(stdin).slice(0, 80) }) });
      if (command.startsWith("H=$HOME")) return { code: 0, stdout: probe, stderr: "" };
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

/** The same machine as a Mac on Apple silicon, which a Linux hub's own build doesn't run on. */
const macProbe = freshProbe
  .replaceAll("/home/dev", "/Users/dev")
  .replace("os Linux", "os Darwin")
  .replace(/arch .*/, "arch arm64")
  .replace("config /Users/dev/.config", "config /Users/dev/Library/Application Support")
  .replace("linger yes", "linger no")
  .replace("gui unknown", "gui yes");

/** A release directory (FLEETD_BASE_URL) holding `files`. */
function feed(files: Record<string, string>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const body = files[new URL(req.url).pathname.slice(1)];
      return body === undefined ? new Response("Not Found", { status: 404 }) : new Response(body);
    },
  });
  process.env.FLEETD_BASE_URL = `http://127.0.0.1:${server.port}`;
  return server;
}
const sha = (t: string) => new Bun.CryptoHasher("sha256").update(t).digest("hex");

test.skipIf(process.platform !== "linux")("add copies a Mac this version's release build for it, checked against SHA256SUMS", async () => {
  const build = "the darwin-arm64 build";
  const server = feed({ SHA256SUMS: `${sha(build)}  fleetd-darwin-arm64\n`, "fleetd-darwin-arm64": build });
  try {
    const r = resolve({ host: "dev@mac-1", dryRun: false, enroll: { kind: "hub" }, noService: true, mac: false }, process.execPath);
    const ran: Ran[] = [];
    const progress = collect();
    const prepared = await prepare(r, { db, home: hubHome, by: "a test" }, fake(ran, macProbe), releases, true, progress);
    expect(prepared.fetched?.[0]).toBe("fleetd-darwin-arm64");
    expect(new TextDecoder().decode(prepared.fetched?.[1])).toBe(build);
    expect(progress.lines).toContain(
      `begin download fleetd 0.0.0 for darwin-arm64 (this hub's is a linux-${process.arch} build), checked against its release's SHA256SUMS`,
    );
    expect(prepared.input.binaryDigest).toBe(sha(build));
  } finally {
    server.stop(true);
  }
});

test("a release without the machine's build says so, and how to fix it", async () => {
  const server = feed({ SHA256SUMS: `${sha("x")}  fleetd-linux-x64\n` });
  try {
    await expect(releases.digest("0.0.0", "fleetd-darwin-arm64")).rejects.toThrow(
      "no fleetd-darwin-arm64 of fleetd 0.0.0 to copy to the machine: its release has none. Fix: run a released fleetd on the hub",
    );
    await expect(releases.build("0.0.0", "fleetd-darwin-arm64")).rejects.toThrow(/^no fleetd-darwin-arm64 of fleetd 0\.0\.0 to copy to the machine: .*\. Fix: run a released fleetd on the hub$/);
  } finally {
    server.stop(true);
  }
});

test("releaseOf: FLEETD_BASE_URL, else the edge release for an edge build, else the version's own", () => {
  expect(releaseOf("0.0.0-edge.202611080000+abcdef1", "http://127.0.0.1:1")).toEqual(["http://127.0.0.1:1", false]);
  expect(releaseOf("0.0.0-edge.202611080000+abcdef1")).toEqual(["https://github.com/unlaboredlabs/fleetd/releases/download/edge", true]);
  expect(releaseOf("1.2.3", "")).toEqual(["https://github.com/unlaboredlabs/fleetd/releases/download/v1.2.3", false]);
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
