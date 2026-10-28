// Where a new Navi lives (W138): #/navi's first run on a hub with three machines a Navi could live on, each with its
// Navi sandbox as machine_roles reports it. navi-machines-choice starts on mac, where the hub would put it; devbox
// can't scope abstract sockets (a gap, pickable with its warning); buildbox has no bubblewrap (missing: its reason and
// fix, not pickable). Creating on mac or devbox answers, and the new Navi arrives a moment later.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at, uuid } from "../kit/ids.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";

const MAC: JsonObject = {
  machineId: "mac",
  name: "mac",
  nodeVersion: "0.0.0",
  status: "online",
  tags: [],
  boxPubKey: "q2Vt0bGxk3WcP9mJ4Zr8aA===",
};

const SANDBOX: Record<string, JsonObject> = {
  mac: { status: "ready", line: "Navis run in sandbox-exec." },
  devbox: {
    status: "gap",
    line: "Navis run in bubblewrap, but this kernel can't scope abstract sockets (Landlock 6, Linux 6.12): a Navi can reach an X server that takes local connections without a cookie.",
    fix: "Update the kernel to Linux 6.12 or later.",
  },
  buildbox: {
    status: "missing",
    line: "A Navi runs only inside a sandbox, and this machine has no bubblewrap (bwrap).",
    fix: "Install bubblewrap on this machine (Debian and Ubuntu: sudo apt install bubblewrap; Fedora: sudo dnf install bubblewrap; Arch: sudo pacman -S bubblewrap), then send again.",
  },
};

const navi = (f: Fixture, machineId: string): JsonObject => ({
  machineId,
  projectId: uuid(`navi on ${machineId}`),
  title: "Navi",
  workspaceRoot: machineId === "mac" ? "/Users/dev/.fleetd/navi/navi" : "/home/dev/.fleetd/navi/navi",
  lastActivityAt: f.now,
  threads: { failed: 0, idle: 0, running: 0, waiting: 0 },
  kind: "assistant",
  createdBy: { keyId: "k-laptop", name: "laptop" },
});

const choice = (from: Fixture): Fixture => {
  const f = Fixture.from(from, "navi-machines-choice", "Navi's first run with a choice of machine: mac (the hub's pick), devbox (a sandbox gap) and buildbox (no bubblewrap).");
  const snapshot = f.snapshot ?? {};
  f.snapshot = { ...snapshot, machines: [...arr(snapshot["machines"]), { ...MAC, lastSeenAt: at(f.now, -20_000) }] };
  const machines = arr(f.snapshot["machines"])
    .filter(isObject)
    .map((m): JsonObject => {
      const machineId = asText(m["machineId"]);
      return {
        machineId,
        name: machineId,
        online: true,
        operates: true,
        roles: ["agents"],
        maxSessions: 4,
        maxSessionsWhy: "auto: 8 CPUs, 32 GB",
        sessionsLive: 0,
        hostsOthers: true,
        ...(SANDBOX[machineId] === undefined ? {} : { naviSandbox: SANDBOX[machineId] }),
      };
    });
  f.answer("machine_roles", undefined, { machines, best: "mac" });
  for (const machineId of ["mac", "devbox"]) {
    const made = navi(f, machineId);
    f.answer("navi_create", { machineId }, { navi: made, next: `Navi lives on ${machineId}.` });
    const after: JsonObject = { ...f.snapshot, cursor: Number(f.snapshot["cursor"] ?? 0) + 1, projects: [...arr(f.snapshot["projects"]), made] };
    f.then("navi_create", { machineId }, { frames: [{ ms: 800, kind: "snapshot", payload: after }] });
  }
  return f;
};

export default defineGroup({
  fixtures: (base) => [choice(base("chat-waiting"))],
});
