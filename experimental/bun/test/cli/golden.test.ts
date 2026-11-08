// The Bun CLI against the Rust one, case by case (test/cli/golden.ts says how).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Fleet, fixture, record, RECORD, RUST } from "./golden.ts";

type Case = { name: string; argv: string[]; cwd?: string; env?: Record<string, string>; stdin?: string; setup?: (f: Fleet) => Promise<void> };

/** No hub needed: usage, parse errors, and what opens the hub's database directly. */
const OFFLINE: Case[] = [
  { name: "help", argv: ["help"] },
  { name: "no-args", argv: [] },
  { name: "dash-h", argv: ["-h"] },
  { name: "version", argv: ["version"] },
  { name: "unknown", argv: ["frobnicate"] },
  { name: "hub-unknown", argv: ["hub", "frob"] },
  { name: "hub-help", argv: ["hub", "--help"] },
  { name: "hub-key-help", argv: ["hub", "key", "--help"] },
  { name: "hub-start-help", argv: ["hub", "start", "-h"] },
  { name: "help-after-dashes", argv: ["steer", "--", "--help"], env: {} },
  ...["init", "doctor", "uninstall", "machine", "pair", "invite", "people", "github-app", "project", "navi", "navis", "node",
    "prompts", "instructions", "push-relay", "time", "metrics", "update", "status", "usage", "cloud", "steer", "steers",
    "chat", "work"].map((c) => ({ name: `help-${c}`, argv: [c, "--help"] })),
  { name: "project-missing", argv: ["project"] },
  { name: "project-unknown", argv: ["project", "frob"] },
  { name: "project-bad-flag", argv: ["project", "list", "--frob"] },
  { name: "project-flag-missing-value", argv: ["project", "list", "--machine"] },
  { name: "project-flag-ambiguous", argv: ["project", "list", "--machine", "--archived"] },
  { name: "project-bool-with-value", argv: ["project", "list", "--archived=yes"] },
  { name: "project-short", argv: ["project", "list", "-x"] },
  { name: "navi-missing", argv: ["navi"] },
  { name: "navi-unknown", argv: ["navi", "frob"] },
  { name: "steer-no-key", argv: ["steer", "T1", "hello"] },
  { name: "steer-bad-target", argv: ["steer", "X1", "hi", "--key-file", "k"] },
  { name: "steer-order", argv: ["steer", "W3", "hi", "--key-file", "k"] },
  { name: "steer-empty", argv: ["steer", "T3", "--key-file", "k"] },
  { name: "steer-withdraw-bad", argv: ["steer", "withdraw", "T1", "--key-file", "k"] },
  { name: "steer-withdraw-now", argv: ["steer", "withdraw", "S1", "--now", "--key-file", "k"] },
  { name: "steers-two", argv: ["steers", "W1", "W2", "--key-file", "k"] },
  { name: "steer-key-missing-file", argv: ["steer", "T1", "hi", "--key-file", "nope.key", "--hub", "http://127.0.0.1:1"] },
  { name: "steer-no-hub", argv: ["steer", "T1", "hi", "--key-file", "k.key"], setup: async (f) => writeFileSync(join(f.cwd, "k.key"), "fld_x\n") },
  { name: "chat-no-key", argv: ["chat", "m/p", "hello"] },
  { name: "chat-empty", argv: ["chat", "m/p"] },
  { name: "chat-history-wait", argv: ["chat", "history", "p", "--wait", "--key-file", "k"] },
  { name: "chat-history-two", argv: ["chat", "history", "--key-file", "k"] },
  { name: "chat-history-page", argv: ["chat", "history", "p", "--page", "0", "--key-file", "k"] },
  { name: "chat-page-send", argv: ["chat", "m/p", "hi", "--page", "2", "--key-file", "k"] },
  { name: "time-bad-since", argv: ["time", "--since", "0d"] },
  { name: "time-big-since", argv: ["time", "--since", "401d"] },
  { name: "time-hub-no-key", argv: ["time", "--hub", "http://x"] },
  { name: "time-key-no-hub", argv: ["time", "--key-file", "k"] },
  { name: "time-two", argv: ["time", "a", "b"] },
  { name: "time-key-missing", argv: ["time", "--hub", "http://127.0.0.1:1", "--key-file", "nope"] },
  { name: "work-no-key", argv: ["work"] },
  { name: "work-env-key-unknown", argv: ["work", "frob"], env: { FLEETD_KEY_FILE: "k" } },
  { name: "work-claim-empty", argv: ["work", "claim", "--key-file", "k"] },
  { name: "work-claim-landing", argv: ["work", "claim", "x", "--landing", "abc", "--key-file", "k"] },
  { name: "work-list-paths", argv: ["work", "list", "--paths", "a", "--key-file", "k"] },
  { name: "work-list-two", argv: ["work", "list", "x", "--key-file", "k"] },
  { name: "work-dup-no-why", argv: ["work", "claim", "x", "--not-duplicate-of", "C1", "--key-file", "k"] },
  { name: "work-drop-landing", argv: ["work", "drop", "--landing", "x", "--key-file", "k"] },
  { name: "work-done-bad-id", argv: ["work", "done", "T1", "--key-file", "k"] },
  { name: "work-not-git", argv: ["work", "--key-file", "k"] },
  { name: "status-two", argv: ["status", "a", "b"] },
  { name: "status-hub-no-key", argv: ["status", "--hub", "x"] },
  { name: "status-key-missing", argv: ["status", "--hub", "http://127.0.0.1:1", "--key-file", "nope"] },
  { name: "usage-resume-no-machine", argv: ["usage", "resume"] },
  { name: "usage-bad-machine", argv: ["usage", "Bad_Machine"] },
  { name: "usage-too-many", argv: ["usage", "a", "b"] },
  { name: "cloud-none", argv: ["cloud"] },
  { name: "cloud-unknown", argv: ["cloud", "start"] },
  { name: "cloud-key-no-hub", argv: ["cloud", "stop", "--key-file", "x"] },
  { name: "metrics-days", argv: ["metrics", "--days", "0"] },
  { name: "metrics-positional", argv: ["metrics", "x"] },
  { name: "pair-bad-role", argv: ["pair", "--role", "boss"] },
  { name: "pair-positional", argv: ["pair", "x"] },
  { name: "pair-worker-role", argv: ["pair", "--worker", "m1", "--role", "read"] },
  { name: "pair-codes-and-more", argv: ["pair", "--worker-codes", "--name", "x"] },
  { name: "pair-worker-bad-id", argv: ["pair", "--worker", "Bad"] },
  { name: "pair-revoke-bad-id", argv: ["pair", "--worker-revoke", "xyz"] },
  { name: "pair-revoke-none", argv: ["pair", "--worker-revoke", "0123456789ab"] },
  { name: "pair-codes-none", argv: ["pair", "--worker-codes"] },
  { name: "pair-no-qr", argv: ["pair", "--no-qr", "--name", "laptop", "--role", "operate"] },
  { name: "pair-loopback", argv: ["pair"] },
  { name: "pair-worker", argv: ["pair", "--worker", "builder-1"] },
  {
    name: "pair-worker-codes",
    argv: ["pair", "--worker-codes"],
    setup: async (f) => void (await f.run(RUST ? "rust" : "bun", ["pair", "--worker", "builder-1"])),
  },
  {
    name: "pair-qr-devbox",
    argv: ["pair", "--name", "phone"],
    setup: async (f) =>
      writeFileSync(join(f.hubHome, "setup.json"), JSON.stringify({ listen: "127.0.0.1:4799", url: "http://devbox.example:4799", gitIdentity: { name: "Dev", email: "dev@users.noreply.github.com" }, machines: {} })),
  },
  {
    name: "pair-worker-identity",
    argv: ["pair", "--worker", "mac-1"],
    setup: async (f) =>
      writeFileSync(join(f.hubHome, "setup.json"), JSON.stringify({ listen: "127.0.0.1:4799", url: "http://devbox.example:4799", gitIdentity: { name: "Dev O'Neil", email: "dev@users.noreply.github.com" }, machines: {} })),
  },
  { name: "invite-none", argv: ["invite"] },
  { name: "invite-bad-role", argv: ["invite", "--name", "Ada", "--role", "boss"] },
  { name: "invite-person-and-name", argv: ["invite", "--person", "p_aaaaaaaa", "--name", "x"] },
  { name: "invite-bad-person", argv: ["invite", "--person", "bob"] },
  { name: "invite-missing-person", argv: ["invite", "--person", "p_aaaaaaaa"] },
  { name: "invite-ada", argv: ["invite", "--name", "Ada", "--role", "admin"] },
  { name: "invite-list-empty", argv: ["invite", "list"] },
  { name: "invite-revoke-bad", argv: ["invite", "revoke", "x"] },
  { name: "invite-revoke-missing", argv: ["invite", "revoke", "inv_aaaaaaaa"] },
  { name: "invite-what", argv: ["invite", "frob"] },
  { name: "people-list", argv: ["people"], env: { USER: "dev" } },
  { name: "people-role-bad", argv: ["people", "role", "p_aaaaaaaa", "king"] },
  { name: "people-role-missing", argv: ["people", "role", "p_aaaaaaaa", "admin"] },
  { name: "people-role-bad-id", argv: ["people", "role", "x", "admin"] },
  { name: "people-remove-missing", argv: ["people", "remove", "p_aaaaaaaa"] },
  { name: "people-what", argv: ["people", "frob"] },
  {
    name: "people-after-invites",
    argv: ["people"],
    env: { USER: "dev" },
    setup: async (f) => {
      const which = RUST ? "rust" : "bun";
      await f.run(which, ["invite", "--name", "Ada"], { env: { USER: "dev" } });
      await f.run(which, ["hub", "key", "create", "--human", "--name", "laptop"], { env: { USER: "dev" } });
    },
  },
  { name: "mac-help", argv: ["mac", "--help"] },
  { name: "mac-none", argv: ["mac"] },
  { name: "mac-unknown", argv: ["mac", "frob"] },
  { name: "mac-run-empty", argv: ["mac", "run", "--bg"] },
  { name: "mac-run-env-missing", argv: ["mac", "run", "--env", "NOPE_NOT_SET", "ls"] },
  { name: "mac-run-env-name", argv: ["mac", "run", "--env"] },
  { name: "mac-logs", argv: ["mac", "logs", "-f"] },
  { name: "mac-kill", argv: ["mac", "kill", "x"] },
  { name: "mac-pull", argv: ["mac", "pull"] },
  { name: "mac-sim", argv: ["mac", "sim"] },
  { name: "mac-sim-device", argv: ["mac", "sim", "start", "--device="] },
  { name: "mac-ps-no-node", argv: ["mac", "ps"], env: { FLEETD_NODE_SOCK: "/nonexistent/node.sock" } },
  { name: "mac-run-no-node", argv: ["mac", "run", "--", "ls", "-la"], env: { FLEETD_NODE_SOCK: "/nonexistent/node.sock" } },
  { name: "agent-device-no-node", argv: ["agent-device", "snapshot"], env: { FLEETD_NODE_SOCK: "/nonexistent/node.sock" } },
  // init only ever with --no-service and an address nothing answers at: it must never start a service.
  { name: "init-plain", argv: ["init", "--no-service", "--listen", "127.0.0.1:1"] },
  { name: "init-identity", argv: ["init", "--no-service", "--listen", "127.0.0.1:1", "--url", "http://devbox.example:1", "--git-identity", "Dev <dev@example.com>"] },
  { name: "init-noreply", argv: ["init", "--no-service", "--listen", "127.0.0.1:1", "--git-identity", "Dev <1+dev@users.noreply.github.com>"] },
  { name: "init-bad-listen", argv: ["init", "--no-service", "--listen", "nope"] },
  { name: "init-bad-url", argv: ["init", "--no-service", "--url", "not a url"] },
  { name: "init-bad-identity", argv: ["init", "--no-service", "--git-identity", "dev@example.com"] },
  { name: "init-join-no-code", argv: ["init", "--no-service", "--join", "http://h"] },
  { name: "init-mac-no-join", argv: ["init", "--no-service", "--mac"] },
  { name: "init-bad-step", argv: ["init", "--step", "frob"] },
  { name: "init-positional", argv: ["init", "x"] },
  {
    name: "init-again",
    argv: ["init", "--no-service"],
    setup: async (f) => void (await f.run(RUST ? "rust" : "bun", ["init", "--no-service", "--listen", "127.0.0.1:1", "--git-identity", "Dev <dev@example.com>"])),
  },
  { name: "uninstall", argv: ["uninstall"] },
  { name: "uninstall-purge-nothing", argv: ["uninstall", "--purge"] },
  {
    name: "uninstall-purge",
    argv: ["uninstall", "--purge"],
    setup: async (f) => void (await f.run(RUST ? "rust" : "bun", ["init", "--no-service", "--listen", "127.0.0.1:1"])),
  },
  { name: "uninstall-flag", argv: ["uninstall", "--force"] },
  { name: "push-relay-what", argv: ["push-relay", "frob"] },
  { name: "push-relay-set-hub-only", argv: ["push-relay", "set", "off", "--hub", "x"] },
  { name: "build-slot-none", argv: ["build-slot"] },
  { name: "node-none", argv: ["node"] },
  { name: "node-unknown", argv: ["node", "frob"] },
  { name: "node-positional", argv: ["node", "run", "x"] },
  { name: "node-join-no-hub", argv: ["node", "join", "--token", "t", "--machine", "m"] },
  { name: "node-join-no-token", argv: ["node", "join", "--hub", "http://h", "--machine", "m"] },
  { name: "node-join-token-file", argv: ["node", "join", "--hub", "http://h", "--machine", "m", "--token-file", "nope"] },
  { name: "node-join-empty-machine", argv: ["node", "join", "--hub", "http://h", "--token", "t", "--machine", ""] },
  { name: "node-flush-wait", argv: ["node", "flush", "--wait", "soon"] },
  { name: "node-grants-ask", argv: ["node", "grants", "--ask", "camera"] },
  { name: "node-restart-after", argv: ["node", "restart", "--after", "x"] },
  { name: "update-bad-flag", argv: ["update", "--frob"] },
  { name: "update-positional", argv: ["update", "now"] },
  { name: "hub-key-missing", argv: ["hub", "key"] },
  { name: "hub-key-unknown", argv: ["hub", "key", "frob"] },
  { name: "hub-key-create-no-name", argv: ["hub", "key", "create"] },
  { name: "hub-key-create-bad-role", argv: ["hub", "key", "create", "--name", "a", "--role", "boss", "--machines", "*"] },
  { name: "hub-key-create-no-machines", argv: ["hub", "key", "create", "--name", "a", "--role", "read"] },
  { name: "hub-key-create-bad-machine", argv: ["hub", "key", "create", "--name", "a", "--role", "read", "--machines", "a,B"] },
  { name: "hub-key-agent-and-name", argv: ["hub", "key", "create", "--agent", "bot", "--name", "x"] },
  { name: "hub-key-agent-bad-name", argv: ["hub", "key", "create", "--agent", "a b"] },
  { name: "hub-key-revoke-none", argv: ["hub", "key", "revoke"] },
  { name: "hub-key-revoke-unknown", argv: ["hub", "key", "revoke", "key_nope"] },
  { name: "hub-key-list-empty", argv: ["hub", "key", "list"] },
  {
    name: "hub-key-create-list-revoke",
    argv: ["hub", "key", "list"],
    setup: async (f) => {
      await f.run(RUST ? "rust" : "bun", ["hub", "key", "create", "--name", "ci", "--role", "read", "--machines", "a,b"]);
    },
  },
];

/** Against a running Rust hub. */
const ONLINE: Case[] = [
  { name: "project-list-empty", argv: ["project", "list"] },
  { name: "project-list-archived", argv: ["project", "list", "--archived", "--machine", "devbox"] },
  { name: "project-add-none", argv: ["project", "add"] },
  { name: "project-add-bad", argv: ["project", "add", "not a path"] },
  { name: "project-archive-none", argv: ["project", "archive"] },
  { name: "project-archive-noslash", argv: ["project", "archive", "devbox"] },
  { name: "project-archive-missing", argv: ["project", "archive", "devbox/nope"] },
  { name: "project-set-none", argv: ["project", "set"] },
  { name: "project-set-bad-max", argv: ["project", "set", "devbox/p", "--max-agents", "0"] },
  { name: "project-set-max-no-project", argv: ["project", "set", "--max-agents", "3"] },
  { name: "project-set-fleet-cap", argv: ["project", "set", "--fleet-cap", "12"] },
  { name: "project-profiles", argv: ["project", "profiles"] },
  { name: "project-profile-no-key", argv: ["project", "profile", "fast"] },
  { name: "project-stop-no-key", argv: ["project", "stop", "devbox/p"] },
  { name: "project-key-file-elsewhere", argv: ["project", "list", "--key-file", "k"] },
  { name: "project-only-both", argv: ["project", "add", "--new", "x", "--only-me", "--no-only-me"] },
  { name: "project-new-relative-dest", argv: ["project", "add", "--new", "x", "--dest", "rel"] },
  { name: "project-repo-none", argv: ["project", "repo"] },
  { name: "project-repo-list-missing", argv: ["project", "repo", "list", "devbox/nope"] },
  { name: "navi-list", argv: ["navi", "list"] },
  { name: "navi-create-noname", argv: ["navi", "create"] },
  { name: "navi-rename-missing", argv: ["navi", "rename", "devbox/nope", "x"] },
  { name: "machine-set-none", argv: ["machine", "set"] },
  { name: "machine-set-nothing", argv: ["machine", "set", "devbox"] },
  { name: "machine-set-bad-roles", argv: ["machine", "set", "devbox", "--roles", "agents,cats"] },
  { name: "machine-set-bad-sessions", argv: ["machine", "set", "devbox", "--max-sessions", "65"] },
  { name: "machine-set-unknown", argv: ["machine", "set", "devbox", "--max-agents", "4"] },
  { name: "time-fleet", argv: ["time", "--since", "2026-11-01"] },
  { name: "time-fleet-json", argv: ["time", "--json", "--since", "2026-11-01T00:00:00Z"] },
  { name: "time-order", argv: ["time", "W9", "--since", "2d"] },
  { name: "time-project-unknown", argv: ["time", "nope"] },
  { name: "doctor", argv: ["doctor"] },
  { name: "push-relay-off", argv: ["push-relay", "set", "off"] },
  { name: "push-relay-default", argv: ["push-relay", "set", "https://push.fleetd.sh"] },
  { name: "push-relay-own-key", argv: ["push-relay", "set", "https://relay.devbox.example", "--relay-key-file", "bad.key"] },
  { name: "push-relay-key-missing", argv: ["push-relay", "set", "https://relay.devbox.example", "--relay-key-file", "nope.key"] },
  { name: "status", argv: ["status"] },
  { name: "status-json", argv: ["status", "--json"] },
  { name: "status-unknown", argv: ["status", "nope"] },
  { name: "usage", argv: ["usage"] },
  { name: "usage-json", argv: ["usage", "--json"] },
  { name: "usage-machine", argv: ["usage", "devbox"] },
  { name: "usage-resume", argv: ["usage", "resume", "devbox"] },
  { name: "cloud-stop", argv: ["cloud", "stop"] },
  { name: "cloud-stop-json", argv: ["cloud", "stop", "--json"] },
  { name: "metrics", argv: ["metrics", "--days", "7"] },
  { name: "metrics-json", argv: ["metrics", "--json"] },
  { name: "metrics-project-unknown", argv: ["metrics", "--project", "nope"] },
  { name: "doctor-arg", argv: ["doctor", "x"] },
];

/** Cases that need a human key in the scratch home's `human.key`. */
const KEYED: Case[] = [
  { name: "steers-order", argv: ["steers", "W1", "--key-file", "human.key"] },
  { name: "steer-task-missing", argv: ["steer", "T999", "hello", "--key-file", "human.key"] },
  { name: "steer-withdraw-missing", argv: ["steer", "withdraw", "S77", "--key-file", "human.key"] },
  { name: "chat-history-none", argv: ["chat", "history", "devbox/nope", "--key-file", "human.key"] },
  { name: "chat-send-none", argv: ["chat", "devbox/nope", "hello", "--key-file", "human.key"] },
  { name: "chat-bad-key", argv: ["chat", "history", "p", "--key-file", "bad.key"] },
  { name: "project-profile-new-missing", argv: ["project", "profile", "turbo", "--key-file", "human.key"] },
  { name: "project-profile-bad-effort", argv: ["project", "profile", "turbo", "--model", "m", "--effort", "lots", "--key-file", "human.key"] },
  { name: "project-stop-missing", argv: ["project", "stop", "devbox/nope", "--key-file", "human.key"] },
  { name: "work-list", argv: ["work", "--key-file", "../human.key"], cwd: "repo" },
  { name: "work-claim", argv: ["work", "claim", "the cart page", "--paths", "app/cart.ts", "--key-file", "../human.key"], cwd: "repo" },
  { name: "work-done-none", argv: ["work", "done", "--key-file", "../human.key"], cwd: "repo" },
  { name: "work-drop-missing", argv: ["work", "drop", "C99", "--key-file", "../human.key"], cwd: "repo" },
  { name: "time-remote", argv: ["time", "--hub", "HUBURL", "--key-file", "human.key"] },
  { name: "status-remote-bad-key", argv: ["status", "--hub", "HUBURL", "--key-file", "bad.key"] },
];

describe("offline", () => {
  for (const c of OFFLINE) {
    test(c.name, async () => {
      // A home each, set up alike, so a case that changes it sees the same state from both binaries.
      const fleets = RUST ? [new Fleet(`${c.name}-rust`), new Fleet(`${c.name}-bun`)] : [new Fleet(c.name)];
      try {
        for (const f of fleets) await c.setup?.(f);
        if (RUST) {
          const rust = fleets[0]!.normalize(await fleets[0]!.run("rust", c.argv, c));
          const bun = fleets[1]!.normalize(await fleets[1]!.run("bun", c.argv, c));
          if (RECORD) record(c.name, rust);
          expect(bun).toEqual(rust);
        } else {
          const want = fixture(c.name);
          if (want === undefined) return;
          expect(fleets[0]!.normalize(await fleets[0]!.run("bun", c.argv, c))).toEqual(want);
        }
      } finally {
        for (const f of fleets) await f.stop();
      }
    });
  }
});

describe.skipIf(!RUST)("against a Rust hub", () => {
  // One hub each, set up alike, so a case that changes the hub's state sees the same state from both binaries.
  const fleets: Record<"rust" | "bun", Fleet> = {} as never;
  beforeAll(async () => {
    for (const which of ["rust", "bun"] as const) {
      const fleet = new Fleet(`online-${which}`);
      await fleet.startRustHub();
      const made = await fleet.run("rust", ["hub", "key", "create", "--human", "--name", "golden", "--out", join(fleet.cwd, "human.key")]);
      if (made.code !== 0) throw new Error(made.stderr);
      writeFileSync(join(fleet.cwd, "bad.key"), "fld_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
      // A checkout for `fleetd work`: an origin remote, a branch and a change.
      const repo = join(fleet.cwd, "repo");
      for (const cmd of [["init", "-q", "-b", "main", repo], ["-C", repo, "remote", "add", "origin", "https://github.com/acme/shop.git"],
        ["-C", repo, "config", "user.email", "dev@example.com"], ["-C", repo, "checkout", "-q", "-b", "cart"]]) {
        Bun.spawnSync(["git", ...cmd]);
      }
      writeFileSync(join(repo, "cart.ts"), "export {};\n");
      fleets[which] = fleet;
    }
  });
  afterAll(async () => {
    await fleets.rust?.stop();
    await fleets.bun?.stop();
  });
  for (const c of [...ONLINE, ...KEYED]) {
    test(c.name, async () => {
      const argv = (f: Fleet) => c.argv.map((a) => (a === "HUBURL" ? f.hubUrl : a));
      const rust = fleets.rust.normalize(await fleets.rust.run("rust", argv(fleets.rust), c));
      const bun = fleets.bun.normalize(await fleets.bun.run("bun", argv(fleets.bun), c));
      expect(bun).toEqual(rust);
    });
  }
});
