// The Bun CLI against the Rust one, case by case (test/cli/golden.ts says how).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Fleet, fixture, record, RECORD, UNSET } from "./golden.ts";

/** A release feed on this machine for `fleetd update`: /newer/ has a newer CLI, /same/ this build, /none/ none. */
const feed = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/newer/release.json") return Response.json({ cliVersion: "0.0.0-edge.202611091200+abc1234" });
    if (path === "/same/release.json") return Response.json({ cliVersion: "0.0.0-edge.202611081341+e4509af" });
    if (path === "/none/release.json") return Response.json({});
    if (path === "/broken/release.json") return new Response("not json");
    return new Response("not found", { status: 404 });
  },
});
const feedAt = (dir: string) => ({ FLEETD_BASE_URL: `http://127.0.0.1:${feed.port}/${dir}` });

/** A day inside the 30 days timelines are kept, whatever today is: `fleetd time --since` answers the same each day. */
const WEEK_AGO = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

/** A no-node case's run: the CLI's 20 s wait for a restarting node, and room to spare. */
const NO_NODE_MS = 45_000;
type Case = { name: string; argv: string[]; cwd?: string; env?: Record<string, string>; stdin?: string; setup?: (f: Fleet) => Promise<void>; /** Longer than CASE_MS a binary. */ ms?: number };

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
    "prompts", "instructions", "push-relay", "time", "metrics", "update", "status", "usage", "steer", "steers",
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
    setup: async (f) => void (await f.run(["pair", "--worker", "builder-1"])),
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
      await f.run(["invite", "--name", "Ada"], { env: { USER: "dev" } });
      await f.run(["hub", "key", "create", "--human", "--name", "laptop"], { env: { USER: "dev" } });
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
  // With no node listening, a call waits 20 s for one restarting before it says so.
  { name: "mac-ps-no-node", argv: ["mac", "ps"], env: { FLEETD_NODE_SOCK: "/nonexistent/node.sock" }, ms: NO_NODE_MS },
  { name: "mac-run-no-node", argv: ["mac", "run", "--", "ls", "-la"], env: { FLEETD_NODE_SOCK: "/nonexistent/node.sock" }, ms: NO_NODE_MS },
  { name: "agent-device-no-node", argv: ["agent-device", "snapshot"], env: { FLEETD_NODE_SOCK: "/nonexistent/node.sock" }, ms: NO_NODE_MS },
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
  { name: "init-step-no-hub", argv: ["init", "--step", "people"] },
  { name: "init-positional", argv: ["init", "x"] },
  {
    name: "init-again",
    argv: ["init", "--no-service"],
    setup: async (f) => void (await f.run(["init", "--no-service", "--listen", "127.0.0.1:1", "--git-identity", "Dev <dev@example.com>"])),
  },
  { name: "uninstall", argv: ["uninstall"] },
  { name: "uninstall-purge-nothing", argv: ["uninstall", "--purge"] },
  {
    name: "uninstall-purge",
    argv: ["uninstall", "--purge"],
    setup: async (f) => void (await f.run(["init", "--no-service", "--listen", "127.0.0.1:1"])),
  },
  { name: "uninstall-flag", argv: ["uninstall", "--force"] },
  { name: "push-relay-what", argv: ["push-relay", "frob"] },
  { name: "push-relay-no-credentials", argv: ["push-relay", "--listen", "127.0.0.1:1"] },
  { name: "push-relay-bad-listen", argv: ["push-relay", "--listen", "localhost:4795"] },
  { name: "push-relay-missing-key-file", argv: ["push-relay"], env: { FLEETD_APNS_KEY_FILE: "/nonexistent/apns.p8" } },
  { name: "push-relay-empty-apns-id", argv: ["push-relay"], env: { FLEETD_APNS_KEY_FILE: "/dev/null" } },
  { name: "push-relay-set-hub-only", argv: ["push-relay", "set", "off", "--hub", "x"] },
  { name: "build-slot-none", argv: ["build-slot"] },
  { name: "node-none", argv: ["node"] },
  { name: "node-unknown", argv: ["node", "frob"] },
  { name: "node-positional", argv: ["node", "run", "x"] },
  { name: "node-join-no-hub", argv: ["node", "join", "--token", "t", "--machine", "m"] },
  { name: "node-join-no-token", argv: ["node", "join", "--hub", "http://h", "--machine", "m"] },
  { name: "node-join-token-file", argv: ["node", "join", "--hub", "http://h", "--machine", "m", "--token-file", "nope"] },
  { name: "node-join-empty-machine", argv: ["node", "join", "--hub", "http://h", "--token", "t", "--machine", ""] },
  { name: "node-grants-ask", argv: ["node", "grants", "--ask", "camera"] },
  { name: "node-restart-after", argv: ["node", "restart", "--after", "x"] },
  { name: "update-bad-flag", argv: ["update", "--frob"] },
  { name: "update-positional", argv: ["update", "now"] },
  { name: "doctor-no-hub-color", argv: ["doctor"], env: { NO_COLOR: UNSET } },
  { name: "machine-add-none", argv: ["machine", "add"] },
  { name: "machine-add-two", argv: ["machine", "add", "a", "b"] },
  { name: "machine-add-host-and-local", argv: ["machine", "add", "a", "--local"] },
  { name: "machine-add-bad-id", argv: ["machine", "add", "builder", "--machine-id", "Bad_Id"] },
  { name: "machine-add-no-setup", argv: ["machine", "add", "builder"] },
  { name: "machine-add-dry-run", argv: ["machine", "add", "dev@builder-1.example", "--dry-run"], setup: async (f) => writeFileSync(join(f.hubHome, "setup.json"), JSON.stringify({ listen: "127.0.0.1:1", url: "http://devbox.example:4790", machines: {} })), },
  { name: "machine-add-dry-run-user", argv: ["machine", "add", "builder-2", "--dry-run", "--no-service", "--claude-config-dir", "/srv/claude"], env: { USER: "ops" }, setup: async (f) => writeFileSync(join(f.hubHome, "setup.json"), JSON.stringify({ listen: "127.0.0.1:1", url: "http://127.0.0.1:1", gitIdentity: { name: "Dev", email: "dev@example.com" }, machines: {} })), },
  { name: "machine-add-no-hub", argv: ["machine", "add", "builder-3"], setup: async (f) => writeFileSync(join(f.hubHome, "setup.json"), JSON.stringify({ listen: "127.0.0.1:1", url: "http://devbox.example:4790", machines: {} })), },
  { name: "machine-remove-none", argv: ["machine", "remove"] },
  { name: "machine-unknown", argv: ["machine", "frob"] },
  { name: "machine-none", argv: ["machine"] },
  { name: "prompts-none", argv: ["prompts"] },
  { name: "prompts-no-hub", argv: ["prompts", "list"] },
  { name: "prompts-bad-project", argv: ["prompts", "list", "--project", "nope"] },
  { name: "prompts-list", argv: ["prompts", "list"], setup: async (f) => void (await f.run(["hub", "key", "list"])) },
  { name: "prompts-unknown-verb", argv: ["prompts", "frob", "lead.start"], setup: async (f) => void (await f.run(["hub", "key", "list"])) },
  { name: "prompts-show-none", argv: ["prompts", "show"], setup: async (f) => void (await f.run(["hub", "key", "list"])) },
  { name: "prompts-show-unknown", argv: ["prompts", "show", "nope.nope"], setup: async (f) => void (await f.run(["hub", "key", "list"])) },
  { name: "prompts-show", argv: ["prompts", "show", "lead.start"], setup: async (f) => void (await f.run(["hub", "key", "list"])) },
  { name: "prompts-show-default", argv: ["prompts", "show", "instructions", "--default"], setup: async (f) => void (await f.run(["hub", "key", "list"])) },
  { name: "prompts-show-session", argv: ["prompts", "show", "--session", "devbox/t1"], setup: async (f) => void (await f.run(["hub", "key", "list"])) },
  { name: "prompts-project-missing", argv: ["prompts", "show", "lead.start", "--project", "devbox/nope"], setup: async (f) => void (await f.run(["hub", "key", "list"])) },
  { name: "prompts-diff-shipped", argv: ["prompts", "diff", "lead.start"], setup: async (f) => void (await f.run(["hub", "key", "list"])) },
  { name: "prompts-reset-shipped", argv: ["prompts", "reset", "lead.start"], setup: async (f) => void (await f.run(["hub", "key", "list"])) },
  { name: "instructions-what", argv: ["instructions", "frob"] },
  { name: "instructions-show", argv: ["instructions", "show"], setup: async (f) => void (await f.run(["hub", "key", "list"])) },
  { name: "prompts-edited-diff", argv: ["prompts", "diff", "instructions"], setup: async (f) => {
      await f.run(["hub", "key", "list"]);
      writeFileSync(join(f.cwd, "ed.sh"), "#!/bin/sh\nprintf '\\nAlways answer in French.\\n' >> \"$1\"\n", { mode: 0o755 });
      await f.run(["prompts", "edit", "instructions"], { env: { VISUAL: join(f.cwd, "ed.sh") }, stdin: "y\n" });
    } },
  { name: "prompts-edited-list", argv: ["prompts", "list"], setup: async (f) => {
      await f.run(["hub", "key", "list"]);
      writeFileSync(join(f.cwd, "ed.sh"), "#!/bin/sh\nprintf '\\nAlways answer in French.\\n' >> \"$1\"\n", { mode: 0o755 });
      await f.run(["prompts", "edit", "instructions"], { env: { VISUAL: join(f.cwd, "ed.sh") }, stdin: "y\n" });
    } },
  { name: "prompts-edited-show", argv: ["instructions", "show"], setup: async (f) => {
      await f.run(["hub", "key", "list"]);
      writeFileSync(join(f.cwd, "ed.sh"), "#!/bin/sh\nprintf '\\nAlways answer in French.\\n' >> \"$1\"\n", { mode: 0o755 });
      await f.run(["prompts", "edit", "instructions"], { env: { VISUAL: join(f.cwd, "ed.sh") }, stdin: "y\n" });
    } },
  { name: "prompts-edited-reset", argv: ["prompts", "reset", "instructions"], setup: async (f) => {
      await f.run(["hub", "key", "list"]);
      writeFileSync(join(f.cwd, "ed.sh"), "#!/bin/sh\nprintf '\\nAlways answer in French.\\n' >> \"$1\"\n", { mode: 0o755 });
      await f.run(["prompts", "edit", "instructions"], { env: { VISUAL: join(f.cwd, "ed.sh") }, stdin: "y\n" });
    } },
  {
    name: "prompts-edit-no",
    argv: ["prompts", "edit", "instructions"],
    env: { VISUAL: "./ed.sh" },
    stdin: "n\n",
    setup: async (f) => {
      await f.run(["hub", "key", "list"]);
      writeFileSync(join(f.cwd, "ed.sh"), "#!/bin/sh\necho more >> \"$1\"\n", { mode: 0o755 });
    },
  },
  { name: "prompts-edit-editor-fails", argv: ["prompts", "edit", "instructions"], env: { VISUAL: "false" }, setup: async (f) => void (await f.run(["hub", "key", "list"])) },
  { name: "github-app-none", argv: ["github-app"] },
  { name: "github-app-test-none", argv: ["github-app", "test"] },
  { name: "github-app-remove-none", argv: ["github-app", "remove"] },
  { name: "github-app-bad-org", argv: ["github-app", "create", "--org", "-bad"] },
  { name: "github-app-bad-port", argv: ["github-app", "create", "--port", "http"] },
  { name: "github-app-unknown", argv: ["github-app", "frob"] },
  { name: "github-app-flag", argv: ["github-app", "--frob"] },
  { name: "update-check-newer", argv: ["update", "--check"], env: feedAt("newer") },
  { name: "update-check-same", argv: ["update", "--check"], env: feedAt("same") },
  { name: "update-check-none", argv: ["update", "--check", "--channel", "stable"], env: feedAt("none") },
  { name: "update-check-missing", argv: ["update", "--check"], env: feedAt("gone") },
  { name: "update-bad-channel", argv: ["update", "--check", "--channel", "beta"], env: feedAt("newer") },
  { name: "update-no-services", argv: ["update"], env: feedAt("newer") },
  { name: "node-restart-none", argv: ["node", "restart"] },
  // update-claude with a stand-in claude in the scratch home: PATH has no other.
  { name: "update-claude-current", argv: ["update-claude"], env: { PATH: "/usr/bin:/bin" }, setup: async (f) => {
      mkdirSync(join(f.home, ".local/bin"), { recursive: true });
      writeFileSync(join(f.home, ".local/bin/claude"), "#!/bin/sh\necho '2.1.314 (Claude Code)'\n", { mode: 0o755 });
    } },
  { name: "update-claude-other", argv: ["update-claude"], env: { PATH: "/usr/bin:/bin" }, setup: async (f) => {
      mkdirSync(join(f.home, ".local/bin"), { recursive: true });
      writeFileSync(join(f.home, ".local/bin/claude"), "#!/bin/sh\necho '2.1.200 (Claude Code)'\n", { mode: 0o755 });
    } },
  { name: "update-claude-none", argv: ["update-claude"], env: { PATH: "/usr/bin:/bin" } },
  // machine remove never on a local record here: its undo would reach this machine's own node service.
  { name: "machine-remove-unknown", argv: ["machine", "remove", "builder-8"] },
  { name: "machine-remove-bad-id", argv: ["machine", "remove", "Bad_Id"] },
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
      await f.run(["hub", "key", "create", "--name", "ci", "--role", "read", "--machines", "a,b"]);
    },
  },
];

/** Against a running hub. */
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
  { name: "time-fleet", argv: ["time", "--since", WEEK_AGO] },
  { name: "time-fleet-json", argv: ["time", "--json", "--since", `${WEEK_AGO}T00:00:00Z`] },
  { name: "time-order", argv: ["time", "W9", "--since", "2d"] },
  { name: "time-project-unknown", argv: ["time", "nope"] },
  { name: "init-step-address", argv: ["init", "--step", "address"] },
  { name: "init-step-people", argv: ["init", "--step", "people"] },
  { name: "init-step-machines", argv: ["init", "--step", "machines"] },
  { name: "init-step-mac", argv: ["init", "--step", "mac"] },
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

/** A case spawns a fresh process or two: a loaded machine (CI, or a busy devbox) takes longer than bun's 5 s default. */
const CASE_MS = 30_000;

/** The case's run against its fixture, or recorded as its fixture with RECORD=1. */
function golden(name: string, got: ReturnType<Fleet["normalize"]>) {
  if (RECORD) return record(name, got);
  const want = fixture(name);
  if (want === undefined) throw new Error(`no fixture for ${name}: record it with RECORD=1 bun test test/cli/golden.test.ts`);
  expect(got).toEqual(want);
}

describe("offline", () => {
  for (const c of OFFLINE) {
    test(c.name, async () => {
      const fleet = new Fleet(c.name);
      try {
        await c.setup?.(fleet);
        golden(c.name, fleet.normalize(await fleet.run(c.argv, c)));
      } finally {
        await fleet.stop();
      }
    }, c.ms ?? CASE_MS);
  }
});

describe("against a hub", () => {
  let fleet: Fleet;
  beforeAll(async () => {
    fleet = new Fleet("online");
    await fleet.startHub();
    const made = await fleet.run(["hub", "key", "create", "--human", "--name", "golden", "--out", join(fleet.cwd, "human.key")]);
    if (made.code !== 0) throw new Error(made.stderr);
    writeFileSync(join(fleet.cwd, "bad.key"), "fld_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    // A checkout for `fleetd work`: an origin remote, a branch and a change.
    const repo = join(fleet.cwd, "repo");
    for (const cmd of [["init", "-q", "-b", "main", repo], ["-C", repo, "remote", "add", "origin", "https://github.com/acme/shop.git"],
      ["-C", repo, "config", "user.email", "dev@example.com"], ["-C", repo, "checkout", "-q", "-b", "cart"]]) {
      Bun.spawnSync(["git", ...cmd]);
    }
    writeFileSync(join(repo, "cart.ts"), "export {};\n");
  }, CASE_MS);
  afterAll(async () => {
    await fleet?.stop();
  });
  for (const c of [...ONLINE, ...KEYED]) {
    test(c.name, async () => {
      const argv = c.argv.map((a) => (a === "HUBURL" ? fleet.hubUrl : a));
      golden(`hub-${c.name}`, fleet.normalize(await fleet.run(argv, c)));
    }, CASE_MS);
  }
});
