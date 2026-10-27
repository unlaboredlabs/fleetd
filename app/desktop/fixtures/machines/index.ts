// Add machine's fixtures (W105): an admin's hub on devbox that sees builder-1 in its ~/.ssh/config and mac-mini on its
// tailnet, with this computer (the app's "laptop" under a fixture) not yet a machine. `machines-add` opens on the three
// ways in, with every later step answered: the hosts, builder-1's plan, and machine_add. `machines-running` and
// `machines-failed` open on a run the hub is following, one at its install step and one stopped at the node's service
// with its output and Retry.
import { defineGroup } from "../kit/group.ts";
import { Fixture } from "../kit/fixture.ts";
import type { JsonObject } from "../kit/json.ts";

const RUN = "M0123456789abcdef0123456789abcdef";
const AGAIN = "Mfedcba9876543210fedcba9876543210";

const HOSTS: JsonObject = {
  hosts: [
    { machineId: "devbox", source: "hub", joined: true },
    { machineId: "builder-1", host: "builder-1", source: "ssh_config", joined: false },
    { machineId: "lab-gpu", host: "lab-gpu.example.com", source: "ssh_config", joined: false },
    { machineId: "mac-mini", host: "mac-mini", source: "tailnet", joined: true },
  ],
};

const step = (title: string, state: string, extra: JsonObject = {}): JsonObject => ({ title, state, ...extra });
const read = (state: string) => step("read the machine's state (read-only)", state);
const STEPS = (states: ReadonlyArray<string>): JsonObject[] =>
  [
    step("create fleetd's directories", "", { command: "mkdir -p '/home/dev/.fleetd/node' '/home/dev/.fleetd/logs' '/home/dev/.fleetd/bin' && chmod 700 '/home/dev/.fleetd'" }),
    step("install fleetd 0.9.0", "", {
      command: "mkdir -p '/home/dev/.fleetd/bin' && cat > '/home/dev/.fleetd/bin/fleetd.fleetd-tmp' && chmod 755 '/home/dev/.fleetd/bin/fleetd.fleetd-tmp' && mv '/home/dev/.fleetd/bin/fleetd.fleetd-tmp' '/home/dev/.fleetd/bin/fleetd'",
      stdin: "stdin: the fleetd binary /home/dev/.fleetd/bin/fleetd (31457280 bytes)",
    }),
    step("write the node service", "", {
      command: "mkdir -p '/home/dev/.config/systemd/user' && cat > '/home/dev/.config/systemd/user/fleetd-node.service.fleetd-tmp' && chmod 644 '/home/dev/.config/systemd/user/fleetd-node.service.fleetd-tmp' && mv '/home/dev/.config/systemd/user/fleetd-node.service.fleetd-tmp' '/home/dev/.config/systemd/user/fleetd-node.service'",
      stdin: "stdin: fleetd-node.service (612 bytes)",
    }),
    step("enroll the node with a one-time token (sent on stdin)", "", {
      command: "'/home/dev/.fleetd/bin/fleetd' 'node' 'join' '--hub' 'http://devbox:4790' '--token-file' '-' '--machine' 'builder-1' '--home' '/home/dev/.fleetd/node' '--enroll-only'",
      stdin: "stdin: one-time enroll token (not shown)",
    }),
    step("(re)start the node", "", { command: "XDG_RUNTIME_DIR=/run/user/1000 systemctl --user daemon-reload && XDG_RUNTIME_DIR=/run/user/1000 systemctl --user enable fleetd-node.service && XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart fleetd-node.service" }),
    step("waiting until builder-1 is online (up to 2 min)", ""),
  ].map((s, i) => ({ ...s, state: states[i] ?? "planned" }));

const NOTES = ["linger is no for dev, so the node stops when dev logs out. Fix: sudo loginctl enable-linger dev"];

const run = (f: Fixture, over: JsonObject): JsonObject => ({
  runId: RUN,
  machineId: "builder-1",
  host: "builder-1",
  state: "running",
  steps: [],
  notes: [],
  startedAt: f.now,
  ...over,
});

/** The admin's hub with every Add machine call answered; `runs` is what machine_add_status has. */
function hub(from: Fixture, name: string, note: string, runs: (f: Fixture) => JsonObject[]): Fixture {
  const f = Fixture.from(from, name, note);
  f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: true });
  f.answer("machine_hosts", undefined, HOSTS);
  f.answer("machine_add_status", undefined, { runs: runs(f) });
  f.answer("machine_add_plan", undefined, {
    machineId: "builder-1",
    host: "builder-1",
    platform: "linux-x64",
    steps: STEPS([]),
    notes: NOTES,
    joined: false,
    next: "machine_add runs these steps.",
  });
  f.answer("machine_add", undefined, { run: run(f, { runId: AGAIN, steps: [read("running"), ...STEPS([])] }) });
  return f;
}

export default defineGroup({
  fixtures: (base) => [
    hub(base("typical"), "machines-add", "Add machine's three ways in, on an admin's hub that sees builder-1 and mac-mini", () => []),
    hub(base("typical"), "machines-running", "Adding builder-1: fleetd is being copied to it", (f) => [
      run(f, { steps: [read("done"), ...STEPS(["done", "running"])] }),
    ]),
    hub(base("typical"), "machines-failed", "Adding builder-1 stopped at the node's service: its output, the fix and Retry", (f) => [
      run(f, {
        state: "failed",
        steps: [
          read("done"),
          ...STEPS(["done", "done", "failed"]).map((s) =>
            s["state"] === "failed"
              ? { ...s, output: "mkdir: cannot create directory '/home/dev/.config/systemd': Permission denied" }
              : s,
          ),
        ],
        notes: [],
        message: "step 3 failed (exit 1):\nmkdir: cannot create directory '/home/dev/.config/systemd': Permission denied",
        fix: "fix that, then run fleetd machine add builder-1; finished steps are skipped.",
        finishedAt: f.now,
      }),
    ]),
  ],
});
