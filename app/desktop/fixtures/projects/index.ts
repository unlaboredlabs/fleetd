// F8: Add project and Machines. The shared fixtures get acme-only discovery (checkouts on the snapshot's machines,
// the snapshot's projects marked as added), the add/inspect/remove answers the sheet's states need, and the hub's own
// problem wording; the group adds a fixture per sheet state and one for the machine states.

import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import { asText, isObject, type JsonObject, type JsonValue } from "../kit/json.ts";
import { LONG_TITLE } from "../kit/text.ts";

const objects = (v: JsonValue | undefined): Array<JsonObject> => (Array.isArray(v) ? v.filter(isObject) : []);

const projectsOf = (f: Fixture) => objects(f.snapshot?.["projects"]);
const machinesOf = (f: Fixture) => objects(f.snapshot?.["machines"]);

const baseName = (path: string) => path.split("/").pop() ?? path;

const inspect = (repo: string | null, ci: boolean): JsonObject => ({
  ...(repo === null ? {} : { repo }),
  defaultBranch: "main",
  ci: ci ? { workflows: ["ci", "e2e"], requiredChecks: ["ci"] } : { workflows: [], requiredChecks: [] },
  merge: ci ? { protected: true, rulesets: ["main"], squashAllowed: true, requiredReviews: 1, strict: true } : { protected: false, rulesets: [], squashAllowed: true },
  leadNeeds: ci ? "CI runs on pull requests; the merge train waits for ci" : "no CI found: the merge train will only use local checks",
  notes: [],
});

/** What project_discover finds: the snapshot's projects as added checkouts, a few more to add, and gh's list. */
const discover = (f: Fixture, extra: { longName?: string; offline?: string } = {}): JsonObject => {
  const machines = machinesOf(f);
  const projects = projectsOf(f);
  const out: Array<JsonObject> = machines.map((m) => {
    const id = asText(m["machineId"]);
    const root = "/home/dev/src";
    const added = projects
      .filter((p) => asText(p["machineId"]) === id)
      .map((p): JsonObject => {
        const path = asText(p["workspaceRoot"]);
        return { path, name: baseName(path), remote: `github.com/acme/${baseName(path)}`, repo: `acme/${baseName(path)}`, projectId: asText(p["projectId"]) };
      });
    const more: Array<JsonObject> =
      id === "devbox"
        ? [
            { path: `${root}/ledger-ui`, name: "ledger-ui", remote: "github.com/acme/ledger-ui", repo: "acme/ledger-ui" },
            { path: `${root}/pricing`, name: "pricing", remote: "github.com/acme/pricing", repo: "acme/pricing" },
            { path: "/home/dev/code/notes-cli", name: "notes-cli" },
            ...(extra.longName ? [{ path: `${root}/${extra.longName}`, name: extra.longName, remote: `github.com/acme/${extra.longName}`, repo: `acme/${extra.longName}` }] : []),
          ]
        : [{ path: `${root}/ci-images`, name: "ci-images", remote: "github.com/acme/ci-images", repo: "acme/ci-images" }];
    if (extra.offline === id) {
      return {
        machineId: id,
        online: false,
        repos: [],
        problem: { code: "machine_offline", message: `${id} is offline`, fix: `Start the node on ${id} (fleetd node run) or check its network, then retry` },
      };
    }
    return { machineId: id, online: true, cloneRoot: root, repos: [...added, ...more] };
  });
  const checkout = (repo: string): Array<JsonObject> =>
    out.flatMap((m) =>
      objects(m["repos"])
        .filter((r) => r["repo"] === repo)
        .map((r): JsonObject => ({ machineId: asText(m["machineId"]), path: asText(r["path"]), ...(r["projectId"] === undefined ? {} : { projectId: r["projectId"] }) })),
    );
  const gh = (repo: string, description: string | null, priv: boolean): JsonObject => ({
    repo,
    url: `https://github.com/${repo}`,
    private: priv,
    ...(description === null ? {} : { description }),
    pushedAt: at(f.now, -3_600_000),
    checkouts: checkout(repo),
  });
  return {
    machines: out,
    github: {
      ghOn: "hub",
      owners: ["acme", "acme-labs"],
      repos: [
        ...projects.map((p) => gh(`acme/${baseName(asText(p["workspaceRoot"]))}`, null, false)),
        gh("acme/ledger-ui", "Ledger front end", true),
        gh("acme/checkout-v2", "Checkout rewrite", true),
        gh("acme/brand-site", extra.longName ? LONG_TITLE : "Marketing site", false),
        gh("acme-labs/edge-cache", "CDN worker", false),
      ],
    },
    best: machines.find((m) => m["status"] === "online" && asText(m["machineId"]) !== extra.offline)?.["machineId"] ?? "devbox",
  };
};

/** The adds the registry's open steps make: a folder (ready at once), a clone (starts), a clone into an existing folder. */
const addAnswers = (f: Fixture) => {
  f.drop("project_discover");
  f.answer("project_add", { path: "/home/dev/src/pricing" }, {
    machineId: "devbox",
    path: "/home/dev/src/pricing",
    projectId: "pricing",
    created: true,
    inspect: inspect("acme/pricing", false),
  });
  f.answer("project_add", { url: "acme/checkout-v2" }, { machineId: "devbox", path: "/home/dev/src/checkout-v2", created: true, addId: "add-1" });
  f.fail("project_add", { url: "acme/ledger-ui" }, {
    code: "invalid",
    message: "/home/dev/src/ledger-ui already exists on devbox",
    fix: "Add the existing checkout at /home/dev/src/ledger-ui on devbox instead, or clone into another folder",
  });
  f.answer("project_inspect", { url: "acme/ledger-ui" }, {
    ...inspect("acme/ledger-ui", true),
    clone: { machineId: "devbox", path: "/home/dev/src/ledger-ui", exists: true, sameRemote: true },
  });
  f.answer("project_add", { url: "acme/ledger-ui", useExisting: true }, {
    machineId: "devbox",
    path: "/home/dev/src/ledger-ui",
    projectId: "ledger-ui",
    created: true,
    inspect: inspect("acme/ledger-ui", true),
  });
  f.answer("project_remove", undefined, { ok: true });
};

const typical = (f: Fixture) => {
  addAnswers(f);
  f.answer("project_discover", undefined, discover(f));
};

/** One failing input per ProjectProblemCode, worded as the hub words it (hub/projects). */
const problems: ReadonlyArray<readonly [JsonObject, string, string, string]> = [
  [{ url: "acme/payments" }, "machine_offline", "buildbox is offline", "Start the node on buildbox (fleetd node run) or check its network, then retry"],
  [{ url: "acme/no-worker" }, "no_worker", "no machine is online to add the project on", "Start a node (fleetd node run on the machine) or pass a machine id"],
  [{ url: "acme/gh-missing" }, "gh_unavailable", "gh isn't logged in on the hub or any worker", "Run gh auth login on the hub, then add it again"],
  [{ url: "acme/secret" }, "gh_no_access", "gh on the hub can't see acme/secret: it is private to another account, renamed, or misspelled", "On devbox, run `gh auth login` with an account that can read acme/secret, then add it again"],
  [{ path: "/home/dev/src/missing" }, "path_missing", "/home/dev/src/missing does not exist on devbox", "Check the path, or clone the repo there first"],
  [{ path: "/home/dev/code/notes-cli" }, "not_a_git_repo", "/home/dev/code/notes-cli on devbox is not a git checkout", "Run git init there, or pick the repo's folder"],
  [{ url: "acme/ledger-ui" }, "dest_exists", "/home/dev/src/ledger-ui already exists on devbox", "Add the existing checkout at /home/dev/src/ledger-ui on devbox instead, or clone into another folder"],
  [{ url: "acme/huge-monorepo" }, "clone_failed", "fatal: write error: No space left on device", "Free disk space on devbox, then add it again"],
  [{ url: "acme/old-node" }, "node_too_old", "devbox's node did not answer: it may predate adding projects", "Run fleetd update on devbox"],
  [{ url: "acme/weird" }, "other", "the node on devbox answered with an error", "fleetd doctor shows what is wrong on devbox"],
];
const ERROR_CODE: Readonly<Record<string, string>> = {
  machine_offline: "machine_offline",
  gh_no_access: "not_found",
  path_missing: "not_found",
  no_worker: "invalid",
  not_a_git_repo: "invalid",
  dest_exists: "invalid",
};

export default defineGroup({
  extend: {
    typical,
    "many-agents": typical,
    "long-text": (f) => {
      addAnswers(f);
      f.answer("project_discover", undefined, discover(f, { longName: "receipts-and-invoices-date-formatting-service-with-a-very-long-repository-name" }));
    },
    empty: (f) => {
      f.drop("project_discover");
      f.answer("project_discover", undefined, {
        machines: machinesOf(f).map((m) => ({ machineId: asText(m["machineId"]), online: true, cloneRoot: "/home/dev/src", repos: [] })),
        github: { owners: [], repos: [], problem: { code: "gh_unavailable", message: "gh isn't logged in on the hub or any worker", fix: "Run gh auth login on the hub, then reopen Add project" } },
        ...(machinesOf(f)[0] ? { best: asText(machinesOf(f)[0]?.["machineId"]) } : {}),
      });
    },
    "node-too-old": (f) => {
      f.drop("project_discover");
      const d = discover(f);
      const machines = objects(d["machines"]).map((m, i) =>
        i === 0
          ? m
          : {
              machineId: asText(m["machineId"]),
              online: true,
              repos: [],
              problem: { code: "node_too_old", message: `${asText(m["machineId"])}'s node is too old to find, inspect or clone repos`, fix: `Run fleetd update on ${asText(m["machineId"])}, then retry` },
            },
      );
      f.answer("project_discover", undefined, { ...d, machines });
    },
  },
  fixtures: (base) => [
    (() => {
      // Each ProjectProblemCode fails one input to project_add.
      const f = Fixture.from(base("typical"), "projects-errors", "Add project: every problem the hub can report, one input each");
      for (const [input, code, message, fix] of problems) {
        f.fail("project_add", input, { code: ERROR_CODE[code] ?? "failed", message, fix });
      }
      // A clone that was accepted, then failed: what project.add_failed carries.
      f.events.push({
        seq: 9_000,
        at: f.now,
        type: "project.add_failed",
        machineId: "devbox",
        summary: "clone of acme/huge-monorepo failed",
        data: { addId: "add-9", repo: "acme/huge-monorepo", path: "/home/dev/src/huge-monorepo", code: "clone_failed", message: "fatal: write error: No space left on device", fix: "Free disk space on devbox, then add it again" },
      });
      return f;
    })(),
    (() => {
      // Machines in every state: one asleep a while ago and back, one degraded, one offline for a while.
      const f = Fixture.from(base("typical"), "projects-machines", "Machines: slept, degraded, offline, usage near its limits");
      const now = Date.parse(f.now);
      const machines = machinesOf(f);
      machines.push({ machineId: "spare", name: "spare", tags: ["mac"], status: "offline", lastSeenAt: at(f.now, -47 * 60_000), nodeVersion: "0.0.0" });
      for (const m of machines) {
        if (m["machineId"] === "devbox") m["lastSlept"] = { fromMs: now - 25 * 60_000, toMs: now - 14 * 60_000 };
        if (m["machineId"] === "buildbox") {
          m["status"] = "degraded";
          m["degradedReason"] = "claude is logged out on buildbox: run claude /login there";
        }
      }
      if (f.snapshot) f.snapshot["machines"] = machines;
      for (const frame of f.live) {
        for (const m of objects(frame["machines"])) {
          if (m["machineId"] === "devbox") {
            m["slept"] = { fromMs: now - 25 * 60_000, toMs: now - 14 * 60_000 };
            m["load"] = {
              cpus: 32,
              load1: 7.4,
              memUsedPct: 63,
              limits: [
                { limitType: "five_hour", utilization: 0.92, status: "allowed_warning", observedAt: f.now },
                { limitType: "seven_day", utilization: 0.47, status: "allowed", observedAt: f.now },
              ],
            };
          }
        }
      }
      f.events.push({ seq: 9_001, at: at(f.now, -14 * 60_000), type: "machine.slept", machineId: "devbox", summary: "devbox slept 11m00s", data: { fromMs: now - 25 * 60_000, toMs: now - 14 * 60_000 } });
      return f;
    })(),
  ],
});
