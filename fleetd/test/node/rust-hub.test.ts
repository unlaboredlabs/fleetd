// The Bun node against the Rust hub, over the real link: enrollment, the machine online with its load, a project added
// (repo_inspect, project_upsert) and a lead's session run end to end under the Rust `session-host`, with the lab's
// offline claude (tests/lab/factory/fakeClaude.ts), then its checkout's skills listed. Needs the Rust binary:
// FLEETD_NATIVE_BIN names it, else the test is skipped. Everything lives in a fresh dir under $TMPDIR: the hub, the machine's HOME and the node's home.
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../helpers.ts";

const native = process.env.FLEETD_NATIVE_BIN;
const home = tempHome();
const children: ChildProcess[] = [];
let hostsDir: string | undefined;

afterAll(async () => {
  // A node that stops lets go of its sessions' hosts, which run on: they end here, with their claude.
  if (native && hostsDir) spawnSync(native, ["session-host", "stop-all", hostsDir], { stdio: "ignore", timeout: 20_000 });
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await Promise.race([exited, Bun.sleep(5000)]);
  }
  home.done();
});

async function mcp(hub: string, key: string, tool: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const post = async (body: unknown) => {
    const res = await fetch(`${hub}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) headers["mcp-session-id"] = sid;
    const text = await res.text();
    const data = text.includes("data: ") ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).pop()! : text;
    return data ? JSON.parse(data) : {};
  };
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bun-node-test", version: "0" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const out = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  return JSON.parse(out.result?.content?.[0]?.text ?? "{}");
}

const until = async <T>(what: string, fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
};

test.skipIf(!native)(
  "a Bun node enrolls with the Rust hub and runs a lead's session end to end",
  async () => {
    const port = 47000 + Math.floor(Math.random() * 1000);
    const hubUrl = `http://127.0.0.1:${port}`;
    const fleetd = join(home.dir, "fleetd");
    const machineHome = join(home.dir, "machine");
    const nodeHome = join(machineHome, ".fleetd", "node");
    hostsDir = join(nodeHome, "hosts");
    const repo = join(machineHome, "src", "demo");
    mkdirSync(repo, { recursive: true });
    spawnSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    mkdirSync(join(repo, ".claude/skills/triage"), { recursive: true });
    writeFileSync(join(repo, ".claude/skills/triage/SKILL.md"), "---\nname: triage\ndescription: Sorts new issues.\n---\n");
    const fake = join(home.dir, "fake-claude");
    writeFileSync(fake, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "../../../tests/lab/factory/fakeClaude.ts")}' "$@"\n`);
    chmodSync(fake, 0o755);

    const hubEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home.dir, FLEETD_HOME: fleetd };
    const hub = spawn(native!, ["hub", "start", "--home", join(fleetd, "hub"), "--listen", `127.0.0.1:${port}`], { env: hubEnv, stdio: "ignore" });
    children.push(hub);
    await until("the hub", async () => (await fetch(`${hubUrl}/healthz`).catch(() => undefined))?.ok);
    const paired = spawnSync(native!, ["pair", "--worker", "devbox-b"], { env: hubEnv, encoding: "utf8" });
    const token = /--code (\S+)/.exec(paired.stdout + paired.stderr)?.[1];
    expect(token).toBeDefined();

    const node = spawn(process.execPath, [join(import.meta.dir, "../../src/main.ts"), "node", "join", "--hub", hubUrl, "--token", token!, "--machine", "devbox-b", "--home", nodeHome], {
      env: { PATH: "/usr/bin:/bin", HOME: machineHome, FLEETD_HOME: join(machineHome, ".fleetd"), FLEETD_NATIVE_BIN: native!, FLEETD_CLAUDE_BIN: fake },
      stdio: "ignore",
    });
    children.push(node);
    // The hub's CLI mints its admin key (cli.key, beside the database) on its first call.
    spawnSync(native!, ["status"], { env: hubEnv, encoding: "utf8" });
    const key = readFileSync(join(fleetd, "hub", "cli.key"), "utf8").trim();
    const machine = await until("the machine online with a ready claude", async () => {
      const status = await mcp(hubUrl, key, "fleetd_status", {});
      const m = status.machines?.find((x: { machineId: string }) => x.machineId === "devbox-b");
      return m?.status === "online" ? m : undefined;
    });
    expect(machine.boxPubKey).toMatch(/=$/);
    const added = await mcp(hubUrl, key, "project_add", { machineId: "devbox-b", path: repo, title: "demo" });
    expect(added).toMatchObject({ created: true, machineId: "devbox-b", inspect: { defaultBranch: "main" } });
    const lead = await mcp(hubUrl, key, "lead_start", { machineId: "devbox-b", projectId: added.projectId });
    expect(lead.threadId).toBeDefined();
    const tail = await until("the lead's first run", async () => {
      const t = await mcp(hubUrl, key, "thread_tail", { machineId: "devbox-b", threadId: lead.threadId });
      return t.thread?.status === "completed" ? t : undefined;
    });
    expect(tail.thread).toMatchObject({ endCause: "completed", latestMessageTail: "lab-ok", model: "claude-opus-5-5" });
    expect(tail.items.map((i: { role: string }) => i.role)).toEqual(["assistant", "user"]);
    // The hub asks the node for the checkout's skills (`skills_list`, CAP_SKILLS).
    const skills = await mcp(hubUrl, key, "skills_list", { projectRef: { machineId: "devbox-b", projectId: added.projectId } });
    expect(skills.repoUnavailable).toBeUndefined();
    expect(skills.skills).toContainEqual(expect.objectContaining({ name: "triage", origin: "repo_claude", description: "Sorts new issues.", path: ".claude/skills/triage/SKILL.md" }));
  },
  90_000,
);
