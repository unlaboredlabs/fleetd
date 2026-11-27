// What `fleetd init` and `fleetd doctor` say on a fresh box and when something is off, in a person's words: the hub
// that doesn't answer, optional screens, a clone with no GitHub login, and a hub whose own Claude account means no
// machine needs claude logged in.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checklist } from "../../src/cli/setup/checklist.ts";
import { show, tally, unreachable } from "../../src/cli/setup/doctor.ts";
import { cloneFailed, hubClaudeAccount } from "../../src/cli/setup/hub_wizard.ts";
import { joinRefusal, newJoinLine } from "../../src/cli/setup/machine.ts";
import { noSetupFix } from "../../src/cli/setup/shared.ts";
import { ClaudeAccountStore } from "../../src/hub/claude_accounts/index.ts";
import { HubDb } from "../../src/hub/store/db.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-setup-words-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a workspace that doesn't answer is said plainly: not running, or something else on its port, never the HTTP client's words", () => {
  const listen = "http://172.17.0.4:4790";
  const reset = unreachable(listen, "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
  expect(reset.message).toBe("something else answers at http://172.17.0.4:4790, not fleetd's workspace: another program may have taken port 4790");
  expect(reset.fix).toContain(":4790");
  // A LAN hub stays where it is: the fix never moves it to loopback.
  expect(reset.fix).not.toContain("127.0.0.1");
  const parse = unreachable(listen, "Parse Error: Expected HTTP/, RTSP/ or ICE/");
  expect(parse.message).toStartWith("something else answers at");
  // What Bun says when an SSH server, say, holds the port.
  expect(unreachable(listen, 'Malformed_HTTP_Response fetching "http://172.17.0.4:4790/mcp"').message).toStartWith("something else answers at");
  const refused = unreachable(listen, "Unable to connect. Is the computer able to access the url?");
  expect(refused.message).toBe("nothing answers at http://172.17.0.4:4790: the workspace isn't running");
  expect(unreachable(listen, "operation timed out").message).toBe("the workspace at http://172.17.0.4:4790 didn't answer within 15 seconds");
  for (const f of [reset, parse, refused]) expect(`${f.message} ${f.fix}`).not.toMatch(/verbose|fetch\(\)|ECONNRESET/);
});

test("Android and desktop screens that can't run read as optional, never as steps that need you", () => {
  const list = new Checklist();
  const checks = [
    { id: "vps1/online", machineId: "vps1", status: "ok", message: "vps1 is online." },
    {
      id: "vps1/android",
      machineId: "vps1",
      status: "warn",
      message: "Android screens are optional, and can't run here yet: alex can't open /dev/kvm.",
      fix: { kind: "manual", label: "On vps1", command: "sudo usermod -aG kvm alex" },
    },
    {
      id: "vps1/desktop",
      machineId: "vps1",
      status: "fail",
      message: "Desktop screens are optional: they need docker or podman, or Xvfb, and this machine has none that works.",
      fix: { kind: "manual", label: "On vps1", command: "sudo apt-get install -y xvfb" },
    },
  ];
  const counted = show(list, checks, []);
  expect(counted).toEqual([1, 1]);
  expect(list.failures()).toEqual([]);
  expect(list.needsYou()).toEqual([]);
  expect(list.items.map((i) => [i.title, i.state, i.detail.split(",")[0]!.split(":")[0], i.fix])).toEqual([
    ["vps1", "skipped", "Android screens are optional", "On vps1: sudo usermod -aG kvm alex"],
    ["vps1", "skipped", "Desktop screens are optional", "On vps1: sudo apt-get install -y xvfb"],
  ]);
  // An older node's words say neither: the line adds both.
  const older = new Checklist();
  show(older, [{ id: "vps1/android", machineId: "vps1", status: "fail", message: "devuser may not use /dev/kvm." }], []);
  expect(older.items[0]?.detail).toBe("Android screens are optional: devuser may not use /dev/kvm");
  tally(list, counted, "other checks");
  expect(list.items.at(-1)).toMatchObject({ title: "doctor", state: "done", detail: "1 of 1 other checks pass" });
  // A check that does count and fails: the tally isn't a green tick.
  const other = new Checklist();
  tally(other, show(other, [{ id: "hub/vault_key", status: "warn", message: "no recovery code" }], []), "other checks");
  expect(other.items.at(-1)).toMatchObject({ title: "doctor", state: "warn", detail: "0 of 1 other checks pass" });
});

test("a fix says its title with its command: who runs it, and what has to come first", () => {
  const list = new Checklist();
  const checks = [
    {
      id: "hub/service_manager",
      scope: "hub",
      status: "warn",
      message: "Linger is off for sam: the workspace stops when sam logs out, and starts again only at their next login.",
      fix: { kind: "manual", label: "As an admin on the workspace's machine, once", command: 'sudo sh -c "loginctl enable-linger sam"', on: "hub" },
    },
    {
      id: "hub/https",
      scope: "hub",
      status: "warn",
      message: "The workspace has no address set up (fleetd init --url).",
      fix: {
        kind: "manual",
        label: "Serve the workspace over HTTPS (Tailscale Serve shown), then stop the workspace and run fleetd init --url https://<that address>",
        command: "tailscale serve --bg 4790",
      },
    },
    { id: "hub/vault_key", scope: "hub", status: "warn", message: "No recovery code.", fix: { kind: "manual", label: "unlock it in Settings › Vault" } },
  ];
  show(list, checks, []);
  expect(list.items.map((i) => i.fix)).toEqual([
    'As an admin on the workspace\'s machine, once: sudo sh -c "loginctl enable-linger sam"',
    "Serve the workspace over HTTPS (Tailscale Serve shown), then stop the workspace and run fleetd init --url https://<that address>: tailscale serve --bg 4790",
    "unlock it in Settings › Vault",
  ]);
});

test("a clone that failed with no GitHub login says to log in, never to use gh where gh isn't there", () => {
  const [why, fix] = cloneFailed("acme/storefront", "~/src/storefront", false, "sudo apt install gh", false);
  expect(why).toBe("cloning acme/storefront failed; a private repo needs your GitHub login on this machine");
  // The gh line's own fix, word for word, so the end list says it once.
  expect(fix).toBe("sudo apt install gh, then gh auth login");
  expect(cloneFailed("o/r", "~/src/r", false, "sudo apt install gh", true)[1]).toBe("gh auth login");
  expect(cloneFailed("o/r", "~/src/r", true, "")[1]).toBe("gh repo clone o/r ~/src/r, then run fleetd init again");
});

test("a workspace with its own Claude API key needs no machine logged in; a fresh one says nothing", () => {
  const home = join(dir, "hub");
  const db = HubDb.open(home);
  try {
    expect(hubClaudeAccount(home)).toBeUndefined();
    new ClaudeAccountStore(db).putHubApi({ sealedOn: [{ machineId: "vps1", fingerprint: "ab12cd34" }], updatedAt: "2026-11-24T10:00:00.000Z" } as never);
  } finally {
    db.conn.close();
  }
  expect(hubClaudeAccount(home)).toBe("the workspace's API key");
  expect(hubClaudeAccount(join(dir, "none"))).toBeUndefined();
});

// On a worker, fleetd doctor said "Fix: fleetd init (it starts the workspace and repairs its setup)": a worker has no
// workspace to start, and its own one lives elsewhere.
test("doctor on a worker says where its workspace is, not to start one here", () => {
  const fleet = join(dir, "worker-fleet");
  mkdirSync(join(fleet, "node"), { recursive: true });
  writeFileSync(join(fleet, "node", "node.json"), JSON.stringify({ hub: "http://devbox.example.ts.net:4790", machineId: "laptop", name: "laptop", enrolled: true }));
  const before = process.env.FLEETD_HOME;
  process.env.FLEETD_HOME = fleet;
  try {
    const fix = noSetupFix(join(fleet, "hub"));
    expect(fix).toStartWith("this machine is laptop, a worker of the workspace at http://devbox.example.ts.net:4790: run this on the workspace's machine");
    expect(fix).not.toContain("starts the workspace");
  } finally {
    if (before === undefined) delete process.env.FLEETD_HOME;
    else process.env.FLEETD_HOME = before;
  }
});

// A wrong code in fleetd init --join read "w5 could not join: step 3 failed (exit 1): fleetd: workspace refused this node:
// …", then two Fix lines, one outside the frame, the second sending a self-hosted workspace's person to fleetd's cloud.
test("a refused join code is one line and one fix, for the workspace it was for", () => {
  const stderr = [
    "fleetd: workspace refused this node: enrollment token expired. Fix: on the workspace's machine, run fleetd pair --worker w5 for a new code",
  ].join("\n");
  const own = joinRefusal(stderr, "w5", "http://devbox:4790")!;
  expect(own).toBe(
    "http://devbox:4790 refused this machine's code: enrollment token expired.\nFix: a code works once, for 15 minutes: on the workspace's machine, run fleetd pair --worker w5 for a new join line, then run that line here.",
  );
  expect(own).not.toContain("step ");
  expect(own.match(/Fix: /g)).toHaveLength(1);
  expect(joinRefusal(stderr, "w5", "https://sam.fleetd.dev")).toContain("Fix: a code works once, for 15 minutes: get a new join line from Add machine in the fleetd app, then");
  // A workspace never reached: the node's own words and fix.
  const away = joinRefusal("fleetd: can't reach the workspace at http://devbox:4790 (connection refused or failed), so this machine hasn't joined and its code is still unused. Fix: check that the address is right and the workspace there runs, then run the join again\n", "w5", "http://devbox:4790");
  expect(away).toBe("can't reach the workspace at http://devbox:4790 (connection refused or failed), so this machine hasn't joined and its code is still unused.\nFix: check that the address is right and the workspace there runs, then run the join again.");
  expect(joinRefusal("some other failure\n", "w5", "http://devbox:4790")).toBeUndefined();
  expect(newJoinLine("w5", "http://devbox:4790")).not.toContain("cloud");
  expect(newJoinLine("w5")).toContain("fleetd pair --worker w5");
});
