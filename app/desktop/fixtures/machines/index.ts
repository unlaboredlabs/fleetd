// Add machine's fixtures (W105): an admin's hub on devbox that sees builder-1 in its ~/.ssh/config and mac-mini on its
// tailnet, with this computer (the app's "laptop" under a fixture) not yet a machine. `machines-add` opens on the three
// ways in, with every later step answered: the hosts, builder-1's plan, and machine_add. `machines-running` and
// `machines-failed` open on a run the hub is following, one at its install step and one stopped at the node's service
// with its output and Retry. Any other machine's line is answered for laptop; `machines-joined` has laptop's node
// come online a moment after the line is made, so its wait turns into Joined. `machines-checklist` has laptop joined
// with claude logged out, and opens its page: the checklist and Claude's login from the app.
import { defineGroup } from "../kit/group.ts";
import { Fixture, HUB } from "../kit/fixture.ts";
import { isObject, type JsonObject } from "../kit/json.ts";

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

const LINE = `curl -fsSL https://fleetd.sh | sh -s -- --join ${HUB} --code K7QM-4XWD --machine-id laptop --git-identity 'dev <dev@example.com>'`;

const laptop = (f: Fixture): JsonObject => ({ machineId: "laptop", name: "laptop", nodeVersion: "0.9.0", status: "online", lastSeenAt: f.now, tags: [] });

/** The snapshot with laptop among its machines. */
const withLaptop = (f: Fixture): JsonObject => {
  const snapshot = f.snapshot ?? {};
  const machines = Array.isArray(snapshot["machines"]) ? snapshot["machines"] : [];
  return { ...snapshot, machines: [...machines, laptop(f)] };
};

const check = (name: string, status: string, message: string, fix?: JsonObject): JsonObject => ({
  id: `laptop/${name}`,
  scope: "machine",
  machineId: "laptop",
  status,
  message,
  ...(fix === undefined ? {} : { fix }),
});

/** laptop just after it joined: claude installed and logged out, its identity set, no project yet, Android not ready. */
const LAPTOP_CHECKS: JsonObject[] = [
  check("online", "ok", "laptop is online."),
  check("claude_version", "ok", "laptop runs claude 2.1.314, the version fleetd was tested with."),
  check("claude_login", "fail", "laptop: claude is not logged in, so its sessions can't start.", { kind: "manual", label: "Log claude in on laptop", command: "claude auth login" }),
  check("runner_conformance", "ok", "claude speaks the stream-json protocol fleetd expects."),
  check("commit_identity", "ok", "laptop commits as dev@example.com, the hub's identity."),
  check("android", "warn", "Android screens are off: /dev/kvm isn't readable by dev.", { kind: "manual", label: "Let dev use KVM, then log in again", command: "sudo usermod -aG kvm dev" }),
  check("desktop", "ok", "Linux desktop screens run in docker."),
];

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
  f.answer("machine_join", undefined, {
    machineId: "laptop",
    hubUrl: HUB,
    code: "K7QM-4XWD",
    expiresAt: "2026-10-19T10:45:00.000Z",
    gitIdentity: "dev <dev@example.com>",
    line: LINE,
    next: "Run the line on laptop.",
  });
  f.answer("machine_join", { machineId: "laptop", rejoin: true }, {
    machineId: "laptop",
    hubUrl: HUB,
    code: "K7QM-4XWD",
    expiresAt: "2026-10-19T10:45:00.000Z",
    line: `${LINE} --rejoin`,
  });
  f.answer("machine_remove", undefined, { machineId: "mac-mini", steps: [], revoked: true, next: "revoked mac-mini's node key; the hub refuses that node from now on." });
  f.answer("machine_claude_login", undefined, {
    machineId: "laptop",
    loginUrl: "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&state=s1",
    message: "sign in at the URL, then give the code it shows",
  });
  return f;
}

/** laptop joins a moment after its line is made. */
function joined(from: Fixture): Fixture {
  const f = hub(from, "machines-joined", "Any other machine: laptop's line, and its node online a moment later", () => []);
  f.then("machine_join", undefined, { frames: [{ ms: 1200, kind: "snapshot", payload: withLaptop(f) }] });
  return f;
}

/** laptop has joined; its page shows the checklist with claude logged out. */
function checklist(from: Fixture): Fixture {
  const f = hub(from, "machines-checklist", "laptop joined: its checklist with claude logged out, and Log in from the app", () => []);
  f.snapshot = withLaptop(f);
  // The recorded hub's checks, with laptop's after them; Check again answers the same.
  const recorded = f.output("doctor_list", {});
  const checks = isObject(recorded) && Array.isArray(recorded["checks"]) ? recorded["checks"] : [];
  for (const input of [{}, { rerun: true }]) f.answer("doctor_list", input, { checks: [...checks, ...LAPTOP_CHECKS], checkedAt: f.now });
  return f;
}

export default defineGroup({
  fixtures: (base) => [
    hub(base("typical"), "machines-add", "Add machine's three ways in, on an admin's hub that sees builder-1 and mac-mini", () => []),
    joined(base("typical")),
    checklist(base("typical")),
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
