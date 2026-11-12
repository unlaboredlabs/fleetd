// Inside an agent's session the fleetd CLI only reads the node's own live hub: its writes (MCP tools above read, the
// chat socket's, and the hub database and key files it writes itself) are refused with a line naming the lead's tools.
// A throwaway hub (its own FLEETD_HOME) and a person's terminal keep working in full. A scratch fleet stands in for the
// live one: the session's FLEETD_NODE_SOCK sits in its node home, so its hub home is the "live" one.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubDb } from "../../src/hub/store/db.ts";
import { isLiveHubHome, isLiveHubUrl, LiveHubRefused, sessionThreadId, standInSession } from "../../src/cli/common.ts";
import { liveHubToolRefusal } from "../../src/cli/mcp_client.ts";
import { createKey, ensureOwner, listKeys, openHub } from "../../src/cli/store.ts";
import { hubKey } from "../../src/cli/hub_key.ts";
import { Fleet } from "./golden.ts";

const CASE_MS = 30_000;
const said = (text: string) => {
  expect(text).toContain("would change the live hub");
  expect(text).toContain("only reads it");
  expect(text).toContain("repo_add, repo_remove, project_setup, project_propose");
  expect(text).toContain("set FLEETD_HOME");
};

describe("the CLI from an agent's session", () => {
  let live: Fleet;
  let throwaway: Fleet;
  /** An agent's session of a node whose home is beside the live fleet's hub. */
  let session: Record<string, string>;

  beforeAll(async () => {
    live = new Fleet("live");
    throwaway = new Fleet("throwaway");
    await Promise.all([live.startHub(), throwaway.startHub()]);
    session = { FLEETD_THREAD_ID: "t-agent", FLEETD_NODE_SOCK: join(live.home, "node", "node.sock") };
    // What `fleetd init` leaves on a live hub: the CLI's own key, and a person's.
    for (const f of [live, throwaway]) {
      expect((await f.run(["project", "list"])).code).toBe(0);
      const made = await f.run(["hub", "key", "create", "--human", "--name", "laptop", "--out", join(f.cwd, "human.key")]);
      expect(made.code).toBe(0);
      const repo = join(f.cwd, "repo");
      for (const cmd of [["init", "-q", "-b", "main", repo], ["-C", repo, "remote", "add", "origin", "https://github.com/acme/shop.git"]]) {
        Bun.spawnSync(["git", ...cmd]);
      }
    }
  }, CASE_MS);
  afterAll(async () => {
    await Promise.all([live?.stop(), throwaway?.stop()]);
  });

  test("a key is not created or revoked on the live hub, nor its key file written", async () => {
    const made = await live.run(["hub", "key", "create", "--name", "ci", "--role", "read", "--machines", "*"], { env: session });
    expect(made.code).toBe(1);
    expect(made.stdout).toBe("");
    said(made.stderr);
    expect(made.stderr.trim().split("\n")).toHaveLength(1);
    const agent = await live.run(["hub", "key", "create", "--agent", "bot"], { env: session });
    expect(agent.code).toBe(1);
    expect(existsSync(join(live.hubHome, "keys", "bot.key"))).toBe(false);
    const listed = await live.run(["hub", "key", "list"], { env: session });
    expect(listed.code).toBe(0);
    expect(listed.stdout).not.toContain("\tci\t");
    expect(listed.stdout).not.toContain("\tbot\t");
    const keyId = /^(key_\S+)\t\S+\tlaptop/m.exec(listed.stdout)?.[1];
    expect(keyId).toBeDefined();
    const revoked = await live.run(["hub", "key", "revoke", keyId!], { env: session });
    expect(revoked.code).toBe(1);
    said(revoked.stderr);
  }, CASE_MS);

  test("a tool above read is refused before it reaches the live hub; reads go", async () => {
    const claim = await live.run(["work", "claim", "the cart page", "--paths", "app/cart.ts", "--key-file", "../human.key"], { cwd: "repo", env: session });
    expect(claim.code).toBe(3);
    said(claim.stderr);
    expect(claim.stderr).toContain("work_claim");
    const listed = await live.run(["work", "--key-file", "../human.key"], { cwd: "repo", env: session });
    expect(listed.code).toBe(0);
    expect(listed.stdout).not.toContain("the cart page");
    expect((await live.run(["status"], { env: session })).code).toBe(0);
    expect((await live.run(["project", "list"], { env: session })).code).toBe(0);
    expect((await live.run(["people"], { env: session })).code).toBe(0);
    const invite = await live.run(["invite", "--name", "Ada"], { env: session });
    expect(invite.code).not.toBe(0);
    said(invite.stdout + invite.stderr);
    const set = await live.run(["machine", "set", "devbox", "--max-agents", "4"], { env: session });
    expect(set.code).toBe(3);
    said(set.stderr);
    expect(set.stderr).not.toContain("No machine devbox");
  }, CASE_MS);

  test("the live hub's address is the live hub from any home", async () => {
    const key = join(live.cwd, "human.key");
    const read = await throwaway.run(["status", "--hub", live.hubUrl, "--key-file", key], { env: session });
    expect(read.code).toBe(0);
    const claim = await throwaway.run(["work", "claim", "the cart page", "--paths", "app/cart.ts", "--hub", live.hubUrl, "--key-file", key], { cwd: "repo", env: session });
    expect(claim.code).toBe(3);
    said(claim.stderr);
  }, CASE_MS);

  test("prompts edits, the vault's key and machines are left to a person on the live hub", async () => {
    const reset = await live.run(["prompts", "reset", "lead.start"], { env: session });
    expect(reset.code).toBe(1);
    said(reset.stderr);
    expect((await live.run(["prompts", "show", "lead.start"], { env: session })).code).toBe(0);
    const vault = await live.run(["vault", "recovery-code"], { env: session });
    expect(vault.code).toBe(1);
    said(vault.stderr);
    const app = await live.run(["github-app"], { env: session });
    expect(app.stderr).toBe("");
    expect(app.code).toBe(0);
    const appRemove = await live.run(["github-app", "remove"], { env: session });
    expect(appRemove.code).toBe(1);
    said(appRemove.stderr);
    const machine = await live.run(["machine", "remove", "devbox"], { env: session });
    expect(machine.code).toBe(1);
    said(machine.stdout + machine.stderr);
  }, CASE_MS);

  test("init, uninstall and a second hub start leave the live hub alone", async () => {
    const setup = readFileSync(join(live.hubHome, "setup.json"), "utf8");
    const listen = live.hubUrl.replace("http://", "");
    const init = await live.run(["init", "--no-service", "--listen", listen, "--url", "http://changed.example:1", "--git-identity", "Dev <dev@example.com>"], { env: session });
    expect(init.code).toBe(1);
    said(init.stdout + init.stderr);
    const uninstall = await live.run(["uninstall", "--purge"], { env: session });
    expect(uninstall.code).toBe(1);
    said(uninstall.stdout + uninstall.stderr);
    // A second hub on the live home, from its default or by --home, never starts.
    for (const argv of [["hub", "start", "--listen", "127.0.0.1:1"], ["hub", "start", "--home", live.hubHome, "--listen", "127.0.0.1:1"]]) {
      const started = await live.run(argv, { env: session });
      expect(started.code).toBe(1);
      said(started.stderr);
      expect(started.stderr).not.toContain("listening on");
    }
    expect(readFileSync(join(live.hubHome, "setup.json"), "utf8")).toBe(setup);
    expect(existsSync(join(live.hubHome, "hub.sqlite"))).toBe(true);
  }, CASE_MS);

  test("a throwaway hub the session started works in full", async () => {
    const made = await throwaway.run(["hub", "key", "create", "--name", "ci", "--role", "read", "--machines", "*"], { env: session });
    expect(made.stderr).toContain("created key_");
    expect(made.code).toBe(0);
    const claim = await throwaway.run(["work", "claim", "the cart page", "--paths", "app/cart.ts", "--key-file", "../human.key"], { cwd: "repo", env: session });
    expect(claim.stdout).toContain("claimed C1");
    expect(claim.code).toBe(0);
  }, CASE_MS);

  test("a person at their own terminal loses nothing", async () => {
    // No session here: a person's shell. (Run from inside an agent's session, the test sees that session's node, whose
    // hub is not this scratch one, so it is a throwaway hub to it either way.)
    const made = await live.run(["hub", "key", "create", "--name", "ops", "--role", "read", "--machines", "*"]);
    expect(made.code).toBe(0);
    const claim = await live.run(["work", "claim", "the cart page", "--paths", "app/cart.ts", "--key-file", "../human.key"], { cwd: "repo" });
    expect(claim.stdout).toContain("claimed C");
    expect(claim.code).toBe(0);
  }, CASE_MS);
});

describe("which hub is the live one", () => {
  let root: string;
  let liveHome: string;
  let otherHome: string;

  const inSession = () =>
    standInSession({ FLEETD_THREAD_ID: "t-agent", FLEETD_NODE_SOCK: join(root, "live", "node", "node.sock") });

  beforeAll(() => {
    root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-live-hub-"));
    liveHome = join(root, "live", "hub");
    otherHome = join(root, "other", "hub");
    for (const home of [liveHome, otherHome]) HubDb.open(home).close();
    writeFileSync(join(liveHome, "setup.json"), JSON.stringify({ listen: "0.0.0.0:4790", url: "http://devbox.example:4790", machines: {} }));
    mkdirSync(join(root, "live", "node"), { recursive: true });
    writeFileSync(join(root, "live", "node", "node.json"), JSON.stringify({ hub: "http://hub.example:4791", machineId: "devbox", name: "devbox", enrolled: true }));
    symlinkSync(join(root, "live"), join(root, "alias"));
    // The owner, as a running hub makes it.
    standInSession(null);
    const db = openHub(liveHome);
    ensureOwner(db);
    db.close();
  });
  afterEach(() => standInSession(undefined));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("outside a session nothing is the live hub, and its database takes writes", () => {
    standInSession(null);
    expect(sessionThreadId()).toBeUndefined();
    expect(isLiveHubHome(liveHome)).toBe(false);
    expect(isLiveHubUrl("http://127.0.0.1:4790")).toBe(false);
    const db = openHub(liveHome);
    try {
      expect(db.readonly).toBe(false);
      createKey(db, "person-made", [{ role: "read", machines: "*" }], "agent");
      expect(listKeys(db).map((k) => k.name)).toContain("person-made");
    } finally {
      db.close();
    }
  });

  test("in a session the live hub's database opens read-only and every write is refused", () => {
    inSession();
    expect(sessionThreadId()).toBe("t-agent");
    expect(isLiveHubHome(liveHome)).toBe(true);
    expect(isLiveHubHome(join(root, "alias", "hub"))).toBe(true);
    const db = openHub(liveHome);
    try {
      expect(db.readonly).toBe(true);
      expect(listKeys(db).length).toBeGreaterThan(0);
      expect(ensureOwner(db).role).toBe("owner");
      expect(() => createKey(db, "agent-made", [{ role: "admin", machines: "*" }], "agent")).toThrow(LiveHubRefused);
      // Anything that writes the database another way, SQLite refuses.
      expect(() => db.conn.run("DELETE FROM agent_keys")).toThrow(/readonly/);
    } finally {
      db.close();
    }
    expect(hubKey(["create", "--name", "x", "--role", "read", "--machines", "*"], liveHome).code).toBe(1);
  });

  test("in a session a throwaway hub's home is not the live one", () => {
    inSession();
    expect(isLiveHubHome(otherHome)).toBe(false);
    const db = openHub(otherHome);
    try {
      expect(db.readonly).toBe(false);
      createKey(db, "throwaway", [{ role: "admin", machines: "*" }], "agent");
    } finally {
      db.close();
    }
    expect(hubKey(["create", "--name", "y", "--role", "read", "--machines", "*"], otherHome).code).toBe(0);
  });

  test("the live hub's addresses: its listen, its url, the node's hub and this machine at its port", () => {
    inSession();
    for (const url of ["http://0.0.0.0:4790", "http://devbox.example:4790/mcp", "http://hub.example:4791", "http://127.0.0.1:4790", "http://localhost:4790", "http://[::1]:4790"]) {
      expect(isLiveHubUrl(url)).toBe(true);
    }
    // The node's hub is on another machine: this machine at its port is a throwaway hub.
    for (const url of ["http://127.0.0.1:47123", "http://other.example:4790", "http://127.0.0.1:4791", "not a url"]) {
      expect(isLiveHubUrl(url)).toBe(false);
    }
  });

  test("a live hub on the tailnet only: a throwaway hub on loopback at its port is not it", () => {
    const file = join(liveHome, "setup.json");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify({ listen: "100.64.0.1:4790", url: "http://devbox.example:4790", machines: {} }));
    try {
      inSession();
      expect(isLiveHubUrl("http://100.64.0.1:4790")).toBe(true);
      expect(isLiveHubUrl("http://devbox.example:4790")).toBe(true);
      for (const url of ["http://127.0.0.1:4790", "http://localhost:4790"]) expect(isLiveHubUrl(url)).toBe(false);
      expect(liveHubToolRefusal("http://127.0.0.1:4790/mcp", "project_add")).toBeUndefined();
    } finally {
      writeFileSync(file, before);
    }
  });

  test("only read tools go to the live hub", () => {
    inSession();
    const hub = "http://127.0.0.1:4790/mcp";
    for (const tool of ["fleetd_status", "project_get", "project_repo_list", "events_wait"]) expect(liveHubToolRefusal(hub, tool)).toBeUndefined();
    for (const tool of ["project_remove", "project_repo_add", "chat_send", "work_claim", "a_tool_this_cli_does_not_know"]) {
      said(liveHubToolRefusal(hub, tool)!);
    }
    expect(liveHubToolRefusal("http://127.0.0.1:47123/mcp", "project_remove")).toBeUndefined();
    standInSession(null);
    expect(liveHubToolRefusal(hub, "project_remove")).toBeUndefined();
  });
});
