// F8: Add project and Machines. The shared fixtures get acme-only discovery (checkouts on the snapshot's machines,
// the snapshot's projects marked as added), the add/inspect/remove answers the sheet's states need, and the hub's own
// problem wording; the group adds a fixture per sheet state and one for the machine states.

import { Fixture, HUB, PROTOCOL } from "../kit/fixture.ts";
import { writeChat } from "../kit/chat.ts";
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
  leadNeeds: ci ? "CI runs on pull requests; the merge train waits for ci" : "no CI found: the merge train holds its PRs until the repo has CI",
  notes: [],
});

/** Where a new project's folder goes on every machine (node/repos.rs projects_root). */
const PROJECTS_ROOT = "/home/dev/fleetd/projects";

/** A plain folder's inspect, as the hub words it (hub/projects/inspect.rs folder). */
const folderInspect: JsonObject = {
  ci: { workflows: [], requiredChecks: [] },
  merge: { protected: false, rulesets: [] },
  leadNeeds: "a plain folder with no git: its lead chats, remembers and uses screens here; agents that change code need a git repo",
  notes: [],
};

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
    return { machineId: id, online: true, cloneRoot: root, projectsRoot: PROJECTS_ROOT, repos: [...added, ...more] };
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
      owners: ["acme"],
      repos: [
        ...projects.map((p) => gh(`acme/${baseName(asText(p["workspaceRoot"]))}`, null, false)),
        gh("acme/ledger-ui", "Ledger front end", true),
        gh("acme/checkout-v2", "Checkout rewrite", true),
        gh("acme/brand-site", extra.longName ? LONG_TITLE : "Marketing site", false),
        gh("acme/edge-cache", "CDN worker", false),
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
  f.answer("project_add", { url: "acme/ledger-ui", dryRun: true }, {
    machineId: "devbox",
    path: "/home/dev/src/ledger-ui",
    created: false,
    inspect: inspect("acme/ledger-ui", true),
    clone: { machineId: "devbox", path: "/home/dev/src/ledger-ui", exists: true, sameRemote: true },
  });
  f.answer("project_add", { url: "acme/ledger-ui", useExisting: true }, {
    machineId: "devbox",
    path: "/home/dev/src/ledger-ui",
    projectId: "ledger-ui",
    created: true,
    inspect: inspect("acme/ledger-ui", true),
  });
  // A new project: made under the projects root, or refused because that folder holds files.
  f.answer("project_add", { create: true, path: `${PROJECTS_ROOT}/field-notes` }, {
    machineId: "devbox",
    path: `${PROJECTS_ROOT}/field-notes`,
    projectId: "field-notes",
    created: true,
    inspect: folderInspect,
  });
  f.fail("project_add", { create: true, path: `${PROJECTS_ROOT}/old-notes` }, {
    code: "invalid",
    message: `${PROJECTS_ROOT}/old-notes on devbox already holds files`,
    fix: "Pick another folder for the new project, or add that one as it is by typing its path",
  });
  f.answer("project_remove", undefined, { ok: true });
};

/** The recorded checks predate the hub saying claude's login method in words (hub/doctor/checks.rs). */
const loginInWords = (f: Fixture) =>
  f.update("doctor_list", (out) =>
    isObject(out)
      ? {
          ...out,
          checks: objects(out["checks"]).map((c) =>
            typeof c["message"] === "string" ? { ...c, message: c["message"].replace(" (oauth_token);", " with a long-lived login token;") } : c,
          ),
        }
      : out,
  );

const typical = (f: Fixture) => {
  loginInWords(f);
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
      loginInWords(f);
      addAnswers(f);
      f.answer("project_discover", undefined, discover(f, { longName: "receipts-and-invoices-date-formatting-service-with-a-very-long-repository-name" }));
    },
    empty: (f) => {
      loginInWords(f);
      f.drop("project_discover");
      f.answer("project_discover", undefined, {
        machines: machinesOf(f).map((m) => ({ machineId: asText(m["machineId"]), online: true, cloneRoot: "/home/dev/src", repos: [] })),
        github: { owners: [], repos: [], problem: { code: "gh_unavailable", message: "gh isn't logged in on the hub or any worker", fix: "Run gh auth login on the hub, then reopen Add project" } },
        ...(machinesOf(f)[0] ? { best: asText(machinesOf(f)[0]?.["machineId"]) } : {}),
      });
    },
    "node-too-old": (f) => {
      loginInWords(f);
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
      // A clone part way through. Calls are static, so its progress comes as timed events from launch. They must land
      // after the QA step has typed acme/checkout-v2 and pressed Enter, so the harness doesn't wait for them before
      // the step (settle 0); the step itself waits for the bar at 42%.
      const f = Fixture.from(base("typical"), "projects-cloning", "Add project: a clone receiving objects, 42% in");
      // Past every event the fixture already plays: the store drops an event older than the last it applied.
      const seqs = [f.snapshot?.["cursor"], ...f.events.map((e) => e["seq"])].filter((n): n is number => typeof n === "number");
      const cursor = Math.max(0, ...seqs, ...f.timeline.map((t) => (typeof t.payload["seq"] === "number" ? t.payload["seq"] : 0)));
      const progress = (n: number, phase: string, percent: number | null, detail: string | null): JsonObject => ({
        seq: cursor + n,
        at: f.now,
        type: "project.clone_progress",
        machineId: "devbox",
        summary: "cloning acme/checkout-v2",
        data: {
          addId: "add-1",
          repo: "acme/checkout-v2",
          path: "/home/dev/src/checkout-v2",
          phase,
          ...(percent === null ? {} : { percent }),
          ...(detail === null ? {} : { detail }),
        },
      });
      f.later(6_000, "event", progress(1, "starting", null, null));
      f.later(6_300, "event", progress(2, "receiving", 12, "1.20 MiB | 2.31 MiB/s"));
      f.later(6_600, "event", progress(3, "receiving", 42, "4.10 MiB | 2.31 MiB/s"));
      f.settleAt(0);
      return f;
    })(),
    (() => {
      // The link drops before project_add answers, then comes back with a snapshot that doesn't list the project yet.
      // Timed past the QA step's Enter, as projects-cloning's progress is.
      const f = Fixture.from(base("typical"), "projects-dropped", "Add project: the link drops mid-add and the hub doesn't list it yet");
      f.fail("project_add", { url: "acme/checkout-v2" }, { code: "disconnected", message: "The connection to the hub closed." });
      f.later(6_000, "state", { phase: "connecting", hub: HUB, attempt: 1 });
      f.later(6_300, "state", { phase: "live", hub: HUB, protocol: PROTOCOL });
      if (f.snapshot !== undefined) f.later(6_600, "snapshot", f.snapshot);
      f.settleAt(0);
      return f;
    })(),
    (() => {
      // A new project made from the sheet: the hub's next snapshot lists it, a plain folder with no repo, and Settings
      // says so. Timed past the QA step's Enter, as projects-cloning's progress is.
      const f = Fixture.from(base("typical"), "projects-new", "Add project: a new, empty project made in a folder the hub makes, then opened");
      const made: JsonObject = { machineId: "devbox", projectId: "field-notes", title: "Field notes", workspaceRoot: `${PROJECTS_ROOT}/field-notes`, threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: f.now, repos: [] };
      if (f.snapshot !== undefined) f.later(6_000, "snapshot", { ...f.snapshot, projects: [...projectsOf(f), made] });
      f.answer("project_settings_get", { machineId: "devbox", projectId: "field-notes" }, {
        settings: {
          machineId: "devbox",
          projectId: "field-notes",
          title: "Field notes",
          workspaceRoot: `${PROJECTS_ROOT}/field-notes`,
          env: [],
          setup: { commands: [], timeoutSec: 600, runAnyway: false, inputs: [] },
          worktrees: { dir: "/home/dev/.fleetd/node/worktrees/field-notes", worktrees: [] },
        },
      });
      f.answer("mcp_servers_get", undefined, { global: [], project: [], userServers: true });
      // Its chat: no messages yet.
      writeChat(f, { machineId: "devbox", projectId: "field-notes" }, []);
      f.settleAt(0);
      return f;
    })(),
  ],
});
