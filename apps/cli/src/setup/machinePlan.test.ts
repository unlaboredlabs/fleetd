import { MachineId } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { machineIdFromHost } from "./machine.ts";
import { type Facts, freshFacts, type MachineAddInput, machineLayout, type MachinePlan, planMachineAdd, planMachineRemove } from "./machinePlan.ts";

const input: MachineAddInput = {
  machineId: MachineId.make("mac-mini"),
  tags: ["macos", "xcode"],
  hubUrl: "https://forge.example.ts.net",
  unitSuffix: "",
  t3Port: 3774,
  t3Version: "0.1.1-nightly.20261017.3238",
  gitIdentity: { name: "wynn-dev", email: "1+wynn-dev@users.noreply.github.com" },
  bundleDigest: "b".repeat(64),
  cliVersion: "0.0.0",
  hubHasNodeKey: false,
};

const plan = (facts: Facts, overrides: Partial<MachineAddInput> = {}) => {
  const result = planMachineAdd(facts, { ...input, ...overrides });
  if ("error" in result) throw new Error(result.error);
  return result;
};

/** The machine as it is after every step of `done` ran: files written, CLI and T3 installed, node enrolled. */
const after = (facts: Facts, done: MachinePlan, overrides: Partial<MachineAddInput> = {}): Facts => {
  const l = machineLayout(facts.home);
  const files: Record<string, string | null> = { ...facts.files };
  for (const step of done.steps) if (step.writes !== undefined && step.stdin?.kind === "text") files[step.writes] = step.stdin.text;
  const enroll = done.steps.find((step) => step.stdin?.kind === "enrollToken");
  if (enroll !== undefined) {
    const { machineId, hubUrl, tags } = { ...input, ...overrides };
    files[l.nodeConfig] = JSON.stringify({ hub: hubUrl, machineId, name: machineId, tags, t3Home: l.t3Home, t3Url: "http://127.0.0.1:3774",
      t3Cmd: ["/usr/bin/env", `T3CODE_HOME=${l.t3Home}`, facts.nodePath, l.t3Bin],
      t3RestartCmd: ["/usr/bin/env", `XDG_RUNTIME_DIR=/run/user/${facts.uid}`, "systemctl", "--user", "restart", "fleetd-t3.service"], enrolled: true });
  }
  files[l.t3Package] = JSON.stringify({ name: "t3", version: input.t3Version });
  return { ...facts, files, sizes: { ...facts.sizes, [l.envFile]: 0 }, digests: { [l.cliDir]: input.bundleDigest } };
};

const titles = (p: MachinePlan) => p.steps.map((step) => step.title);

describe("machine add plan", () => {
  it("on a fresh Linux machine runs these commands, in this order (the --dry-run output)", () => {
    const fresh = plan(freshFacts("wynn"));
    expect(fresh.steps.map((step) => ({ title: step.title, command: step.command, ...(step.stdin === undefined ? {} : { stdin: step.stdin.kind }) }))).toMatchSnapshot();
    expect(fresh.nodeRestarts).toBe(true);
  });

  it("writes units with the commit identity and the T3 settings with the fleetd instance, and no secret anywhere", () => {
    const fresh = plan(freshFacts("wynn"));
    const written = Object.fromEntries(fresh.steps.flatMap((step) => (step.writes !== undefined && step.stdin?.kind === "text" ? [[step.writes, step.stdin.text]] : [])));
    const t3Unit = written["/home/wynn/.config/systemd/user/fleetd-t3.service"];
    expect(t3Unit).toContain("Environment=GIT_AUTHOR_EMAIL=1+wynn-dev@users.noreply.github.com");
    expect(t3Unit).toContain("Environment=CLAUDE_CONFIG_DIR=/home/wynn/.fleetd/claude");
    expect(t3Unit).toContain("EnvironmentFile=-/home/wynn/.fleetd/t3.env");
    expect(written["/home/wynn/.config/systemd/user/fleetd-node.service"]).toContain(
      "ExecStart=/usr/bin/node /home/wynn/.local/share/fleetd/cli/bin.js node run --home /home/wynn/.fleetd/node",
    );
    const settings = JSON.parse(written["/home/wynn/.fleetd/t3/userdata/settings.json"] ?? "{}");
    expect(settings.autoResumeLimitedThreads).toBe(false);
    expect(settings.providerInstances.fleetd.config).toEqual({ homePath: "/home/wynn/.fleetd/claude", launchArgs: "--disallowedTools mcp__t3-code__*,Task,Workflow" });
    expect(Object.values(written).join("\n")).not.toMatch(/TOKEN|fle_|fld_/u);
  });

  it("a second run on a set-up machine only makes sure both services run", () => {
    const first = plan(freshFacts("wynn"));
    const again = plan(after(freshFacts("wynn"), first), { hubHasNodeKey: true });
    expect(titles(again)).toEqual(["create fleetd's directories", "make sure T3 runs", "wait for T3 to answer", "make sure the node runs"]);
    expect(again.nodeRestarts).toBe(false);
    expect(again.steps.map((step) => step.command).join("\n")).not.toMatch(/restart|daemon-reload/u);
  });

  it("re-enrolls when the hub lost the node's key, and restarts only the node", () => {
    const first = plan(freshFacts("wynn"));
    const again = plan(after(freshFacts("wynn"), first), { hubHasNodeKey: false });
    const enroll = again.steps.find((step) => step.stdin?.kind === "enrollToken");
    // The running node is stopped first, so it does not race the joining one.
    expect(enroll?.command).toMatch(/^XDG_RUNTIME_DIR=\/run\/user\/1000 systemctl --user disable --now fleetd-node\.service .*node join .*--token-file - .*--enroll-only$/u);
    expect(titles(again)).toContain("(re)start the node");
    expect(titles(again)).toContain("make sure T3 runs");
  });

  it("new tags rewrite the node's settings and restart it without a new token", () => {
    const first = plan(freshFacts("wynn"));
    const again = plan(after(freshFacts("wynn"), first), { hubHasNodeKey: true, tags: ["macos"] });
    expect(titles(again)).toContain("update the node's settings");
    expect(again.steps.some((step) => step.stdin?.kind === "enrollToken")).toBe(false);
    expect(again.nodeRestarts).toBe(true);
  });

  it("a new fleetd build is copied and restarts the node but not T3", () => {
    const first = plan(freshFacts("wynn"));
    const again = plan(after(freshFacts("wynn"), first), { hubHasNodeKey: true, bundleDigest: "c".repeat(64) });
    expect(titles(again)).toEqual(["create fleetd's directories", "install the fleetd CLI 0.0.0", "make sure T3 runs", "wait for T3 to answer", "(re)start the node"]);
  });

  it("a changed unit file is reloaded before the restart; a new one is not", () => {
    const first = plan(freshFacts("wynn"));
    const set = after(freshFacts("wynn"), first);
    const unit = "/home/wynn/.config/systemd/user/fleetd-t3.service";
    const changed = plan({ ...set, files: { ...set.files, [unit]: "[Unit]\nDescription=old\n" } }, { hubHasNodeKey: true });
    expect(changed.steps.find((step) => step.title === "(re)start T3")?.command).toBe(
      "XDG_RUNTIME_DIR=/run/user/1000 systemctl --user daemon-reload && XDG_RUNTIME_DIR=/run/user/1000 systemctl --user enable fleetd-t3.service && XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart fleetd-t3.service",
    );
    expect(first.steps.find((step) => step.title === "(re)start T3")?.command).not.toContain("daemon-reload");
  });

  it("keeps the user's own T3 settings and other instances", () => {
    const l = machineLayout("/home/wynn");
    const existing = JSON.stringify({ theme: "dark", autoResumeLimitedThreads: true, providerInstances: { codex: { driver: "codex" }, fleetd: { driver: "claudeAgent", config: { autoCompactWindow: "300000", launchArgs: "" } } } });
    const fresh = freshFacts("wynn");
    const step = plan({ ...fresh, files: { [l.t3Settings]: existing } }).steps.find((s) => s.writes === l.t3Settings);
    const settings = JSON.parse(step?.stdin?.kind === "text" ? step.stdin.text : "{}");
    expect(settings).toMatchObject({ theme: "dark", autoResumeLimitedThreads: false, providerInstances: { codex: { driver: "codex" } } });
    expect(settings.providerInstances.fleetd.config).toEqual({ autoCompactWindow: "300000", homePath: "/home/wynn/.fleetd/claude", launchArgs: "--disallowedTools mcp__t3-code__*,Task,Workflow" });
  });

  it("refuses an old Node, an unknown OS and unreadable T3 settings", () => {
    const fresh = freshFacts("wynn");
    expect(planMachineAdd({ ...fresh, nodeVersion: "v22.11.0" }, input)).toEqual({ error: "Node 24 or newer is needed on the machine; it has v22.11.0 at /usr/bin/node" });
    expect(planMachineAdd({ ...fresh, platform: "win32" }, input)).toHaveProperty("error");
    expect(planMachineAdd({ ...fresh, files: { [machineLayout("/home/wynn").t3Settings]: "{nope" } }, input)).toHaveProperty("error");
  });

  it("on a Mac uses launch agents, and notes linger only on Linux", () => {
    const mac = plan({ ...freshFacts("wynn"), platform: "darwin", home: "/Users/wynn", configHome: "/Users/wynn/.config", uid: 501, linger: "unknown" });
    expect(mac.steps.find((step) => step.title === "write the T3 service")?.writes).toBe("/Users/wynn/Library/LaunchAgents/sh.fleetd.t3.plist");
    expect(mac.steps.find((step) => step.title === "(re)start the node")?.command).toBe(
      "launchctl kickstart -k gui/501/sh.fleetd.node 2>/dev/null || launchctl bootstrap gui/501 /Users/wynn/Library/LaunchAgents/sh.fleetd.node.plist",
    );
    expect(mac.notes.join("\n")).not.toContain("linger");
    expect(plan({ ...freshFacts("wynn"), linger: "no" }).notes[0]).toContain("sudo loginctl enable-linger wynn");
  });
});

describe("machine remove plan", () => {
  const record = { platform: "linux" as const, home: "/home/wynn", configHome: "/home/wynn/.config", uid: 1000, unitSuffix: "-fleetdlab" };

  it("removes the node and leaves T3 unless purged", () => {
    const keep = planMachineRemove(record, false).map((step) => step.command).join("\n");
    expect(keep).toContain("systemctl --user disable --now fleetd-node-fleetdlab.service");
    expect(keep).toContain("rm -rf /home/wynn/.fleetd/node");
    expect(keep).not.toContain("fleetd-t3");
    const purge = planMachineRemove(record, true).map((step) => step.command).join("\n");
    expect(purge).toContain("systemctl --user disable --now fleetd-t3-fleetdlab.service");
    expect(purge).toContain("rm -rf /home/wynn/.fleetd/t3 /home/wynn/.fleetd/claude /home/wynn/.fleetd/t3.env");
  });
});

describe("machine id from an ssh host", () => {
  it("takes the host's first label", () => {
    expect(machineIdFromHost("wynn@Mac-Mini.tail1234.ts.net")).toBe("mac-mini");
    expect(machineIdFromHost("forge")).toBe("forge");
    expect(machineIdFromHost("build_box_2")).toBe("build-box-2");
  });
});
