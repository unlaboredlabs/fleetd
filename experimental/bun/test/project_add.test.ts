// Adding, removing and inspecting projects against a fake node (crates/fleetd/src/hub/projects/create_tests.rs,
// repos_tests.rs, order_env_tests.rs): project_discover, project_add (path, create, clone), project_repo_add/list/
// remove, project_remove's gates, and an order's variables.
import { expect, test } from "bun:test";
import { approvals } from "../src/hub/approvals/index.ts";
import { executors } from "../src/hub/executor/index.ts";
import { link } from "../src/hub/link/index.ts";
import { clones } from "../src/hub/projects/add.ts";
import { start as startLoops } from "../src/hub/projects/loops.ts";
import { addingGh } from "../src/hub/projects/discover.ts";
import { FOLDER_NEEDS } from "../src/hub/projects/inspect.ts";
import { dropClosed, orderEnvStore, refusal, saved } from "../src/hub/projects/order_env.ts";
import * as repos from "../src/hub/repos/store.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { TrainGitHub } from "../src/hub/train/github.ts";
import type { SessionCall, SessionReplyFrame } from "../src/shared/sessions.ts";
import { AT, key, kit, workstream } from "./work-kit.ts";

const ROOT = "/home/me/fleetd/projects";
const settle = () => Bun.sleep(5);
type Answer = (call: SessionCall) => SessionReplyFrame["result"] | undefined;

/** devbox's node, listing `caps`: answers each call with `answer`, else the defaults below, and records them. */
async function node(k: ReturnType<typeof kit>, caps: string[], answer: Answer = () => undefined) {
  store(k.hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT });
  const ex = executors(k.hub);
  const calls: SessionCall[] = [];
  // Each folder made, and whether git init ran in it.
  const made = new Map<string, boolean>();
  let seq = 1;
  const event = (e: unknown) => ex.handleFrame("devbox", { t: "machine_event", seq: ++seq, at: AT, event: e as never });
  const defaults = (call: SessionCall): SessionReplyFrame["result"] => {
    switch (call.op) {
      case "repo_scan":
        return { ok: { kind: "repos", cloneRoot: "/home/me/src", repos: [], projectsRoot: ROOT } };
      case "folder_make":
        if (call.path === `${ROOT}/full`) return { err: { code: "invalid", message: `folder not empty: ${call.path}` } };
        if (!call.dryRun) made.set(call.path, call.gitInit === true);
        return { ok: { kind: "folder", path: call.path } };
      case "repo_inspect": {
        const git = made.get(call.path);
        return { ok: { kind: "repo_facts", exists: git !== undefined, isGit: git === true, workflowFiles: [] } };
      }
      case "project_upsert":
        event({ type: "project_upserted", projectId: call.projectId, title: call.title, workspaceRoot: call.workspaceRoot, updatedAt: AT });
        return { ok: { kind: "done" } };
      default:
        return { ok: { kind: "done" } };
    }
  };
  ex.attach("devbox", {
    linkId: 1,
    send(frame) {
      if (frame.call.op !== "subscribe") calls.push(frame.call);
      queueMicrotask(() => ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result: answer(frame.call) ?? defaults(frame.call) }));
    },
  });
  await ex.awaitLive("devbox");
  event({ type: "snapshot", projects: [], sessions: [] });
  (link(k.hub) as unknown as { capabilities: Map<string, Set<string>> }).capabilities.set("devbox", new Set(caps));
  await settle();
  return { calls, made, event };
}

/** gh on the hub answering `paths` (404 for any other), and no `gh repo list`. */
function gh(k: ReturnType<typeof kit>, paths: Record<string, unknown>) {
  const noFresh = { expect() {}, forget() {}, touch() {}, fail() {} };
  const runner = {
    run: async (args: string[]) => {
      const path = args[args.length - 1] as string;
      return path in paths
        ? { exitCode: 0, stdout: JSON.stringify(paths[path]), stderr: "" }
        : { exitCode: 1, stdout: '{"message":"Not Found"}', stderr: "gh: Not Found (HTTP 404)" };
    },
  };
  Object.assign(addingGh(k.hub), {
    github: () => new TrainGitHub(runner, noFresh, Date.now, async () => {}),
    repoList: async () => ({ owners: [], repos: [], problem: "gh is not logged in" }),
  });
}

const operate = key("operate");
const person = key("operate", { human: true, person: { personId: "p-ada", name: "Ada" } });
const added = (k: ReturnType<typeof kit>) => events(k.hub).page(0, ["project.added"]).events;

test("a new project gets a folder under the projects root and no repo", async () => {
  const k = kit();
  const n = await node(k, ["repos", "folder_make"]);
  gh(k, {});
  const found = await k.ok(operate, "project_discover", { github: false });
  expect(found.machines).toEqual([{ machineId: "devbox", online: true, cloneRoot: "/home/me/src", projectsRoot: ROOT, repos: [] }]);
  expect(found.best).toBe("devbox");
  const out = await k.ok(person, "project_add", { machineId: "devbox", create: true, title: "Field Notes" });
  const path = `${ROOT}/field-notes`;
  expect([out.path, out.created, out.inspect.leadNeeds]).toEqual([path, true, FOLDER_NEEDS]);
  expect(out.next).toContain("project_repo_add");
  // Checked first, then made; then registered under its title.
  expect(n.calls.filter((c) => c.op === "folder_make")).toEqual([
    { op: "folder_make", path, gitInit: false, dryRun: true },
    { op: "folder_make", path, gitInit: false, dryRun: false },
  ]);
  expect(n.calls.find((c) => c.op === "project_upsert")).toMatchObject({ title: "Field Notes", workspaceRoot: path });
  await settle();
  const r = { machineId: "devbox", projectId: out.projectId };
  expect(repos.of(k.hub.db.conn, r)).toEqual([]);
  expect(store(k.hub).projectGet(r)?.title).toBe("Field Notes");
  // A plain folder is Only me, the caller's.
  expect(k.hub.db.conn.query("SELECT only_me, owner_person FROM project_settings").get()).toEqual({ only_me: 1, owner_person: "p-ada" });
  const event = added(k).at(-1);
  expect(event?.summary).toBe(`Field Notes added on devbox: ${FOLDER_NEEDS}`);
  expect(event?.data).toMatchObject({ title: "Field Notes", path, created: true });
});

test("a folder given is made there, git init runs only when asked, and a full one is refused", async () => {
  const k = kit();
  const n = await node(k, ["repos", "folder_make"]);
  gh(k, {});
  const dry = await k.ok(operate, "project_add", { machineId: "devbox", create: true, title: "Site", dryRun: true });
  expect(dry.path).toBe(`${ROOT}/site`);
  expect(dry.projectId).toBeUndefined();
  expect(dry.next).toBe(`project_add with create makes ${ROOT}/site on devbox, a new project.`);
  expect(n.calls.map((c) => c.op)).toEqual(["repo_scan", "folder_make"]);
  const site = await k.ok(operate, "project_add", { machineId: "devbox", create: true, path: "/home/me/work/site/", gitInit: true });
  expect(site.path).toBe("/home/me/work/site");
  expect(site.inspect.leadNeeds).toStartWith("no GitHub remote");
  expect(n.calls.find((c) => c.op === "project_upsert")).toMatchObject({ title: "site" });
  expect(repos.of(k.hub.db.conn, { machineId: "devbox", projectId: site.projectId })).toHaveLength(1);
  // A name with nothing to keep still gets a folder.
  expect((await k.ok(operate, "project_add", { create: true, title: "✨" })).path).toBe(`${ROOT}/project`);
  expect(await k.refused(operate, "project_add", { machineId: "devbox", create: true, path: `${ROOT}/full` })).toBe("invalid");
  // The same empty folder again is that project: refused, never renamed.
  await settle();
  expect(await k.refused(operate, "project_add", { machineId: "devbox", create: true, path: "/home/me/work/site" })).toBe("invalid");
  // The contracts' rules on the input.
  expect(await k.refused(operate, "project_add", { create: true, url: "acme/shop", title: "x" })).toBe("invalid");
  expect(await k.refused(operate, "project_add", { gitInit: true, path: "/x" })).toBe("invalid");
  expect(await k.refused(operate, "project_add", {})).toBe("invalid");
});

test("a node too old to make a folder or read repos is told to update; a read key can't add", async () => {
  const k = kit();
  await node(k, ["repos"]);
  gh(k, {});
  const made = await k.call(operate, "project_add", { machineId: "devbox", create: true, title: "x" });
  expect(made).toMatchObject({ error: { error: { code: "failed", message: "devbox's node is too old to make a new project's folder" } } });
  (link(k.hub) as unknown as { capabilities: Map<string, Set<string>> }).capabilities.set("devbox", new Set());
  expect(await k.refused(operate, "project_add", { machineId: "devbox", path: "/x" })).toBe("failed");
  expect(await k.refused(key("read"), "project_add", { machineId: "devbox", path: "/x" })).toBe("forbidden");
  const found = await k.ok(key("read"), "project_discover", { github: false });
  expect(found.machines[0].problem).toMatchObject({ code: "node_too_old" });
});

test("a checkout on GitHub is inspected through gh, bound to its repo and base, and added once", async () => {
  const k = kit();
  const facts = { kind: "repo_facts" as const, exists: true, isGit: true, remote: "git@github.com:acme/shop.git", defaultBranch: "main", workflowFiles: [] };
  const n = await node(k, ["repos"], (call) => (call.op === "repo_inspect" && call.path === "/home/me/src/shop" ? { ok: facts } : undefined));
  gh(k, {
    "repos/acme/shop": { default_branch: "main", allow_squash_merge: true },
    "repos/acme/shop/branches/main": { protected: true },
    "repos/acme/shop/rules/branches/main": [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }],
    "repos/acme/shop/rulesets": [],
    "repos/acme/shop/actions/workflows": { workflows: [{ name: "CI", state: "active", path: ".github/workflows/ci.yml" }] },
  });
  const dry = await k.ok(operate, "project_add", { machineId: "devbox", path: "/home/me/src/shop/", dryRun: true });
  expect(dry.inspect).toEqual({
    repo: "acme/shop",
    defaultBranch: "main",
    ci: { workflows: ["CI"], requiredChecks: ["ci"] },
    merge: { protected: true, rulesets: [], squashAllowed: true },
    leadNeeds: "ready: main requires ci; the train waits for them before each squash merge",
    notes: [],
  });
  expect(n.calls.some((c) => c.op === "project_upsert")).toBe(false);
  const out = await k.ok(person, "project_add", { machineId: "devbox", path: "/home/me/src/shop", title: "Shop" });
  expect(out.created).toBe(true);
  expect(out.next).toBe("ready: main requires ci; the train waits for them before each squash merge. Write to its lead with chat_send; the lead starts with the first message.");
  const r = { machineId: "devbox", projectId: out.projectId };
  expect(k.hub.db.conn.query("SELECT repo_key, base FROM work_projects").get()).toEqual({ repo_key: "github.com/acme/shop", base: "main" });
  expect(repos.own(k.hub.db.conn, r)).toMatchObject({ name: "shop", repoKey: "github.com/acme/shop", base: "main" });
  // A repo folder is not Only me unless asked.
  expect(k.hub.db.conn.query("SELECT only_me FROM project_settings").get()).toEqual({ only_me: 0 });
  await settle();
  // The same directory again is the same project; only a title other than its folder's name renames it.
  const again = await k.ok(operate, "project_add", { machineId: "devbox", path: "/home/me/src/shop" });
  expect([again.projectId, again.created]).toEqual([out.projectId, false]);
  expect(n.calls.filter((c) => c.op === "project_upsert")).toHaveLength(1);
  await k.ok(operate, "project_add", { machineId: "devbox", path: "/home/me/src/shop", title: "Storefront" });
  expect(n.calls.filter((c) => c.op === "project_upsert").at(-1)).toMatchObject({ projectId: out.projectId, title: "Storefront" });
  // A path that isn't there.
  expect(await k.refused(operate, "project_add", { machineId: "devbox", path: "/nope" })).toBe("not_found");
});

test("a clone streams its progress, then lands as a project with its addId", async () => {
  const k = kit();
  clones(k.hub);
  let cloned: (() => void) | undefined;
  const facts = { kind: "repo_facts" as const, exists: true, isGit: true, remote: "https://github.com/acme/shop", defaultBranch: "main", workflowFiles: [] };
  const n = await node(k, ["repos"], (call) => {
    if (call.op === "repo_inspect") return call.path === "/home/me/src/shop" && cloned === undefined ? { ok: { kind: "repo_facts", exists: false, isGit: false } } : { ok: facts };
    return undefined;
  });
  gh(k, { "repos/acme/shop": { default_branch: "main", allow_squash_merge: true } });
  // The clone answers only once the test lets it.
  const ex = executors(k.hub);
  const real = ex.call.bind(ex);
  ex.call = (async (m, op, call, wait) => {
    if (call.op !== "repo_clone") return real(m, op, call, wait);
    n.calls.push(call);
    return new Promise((resolve) => {
      cloned = () => resolve(facts);
    });
  }) as typeof ex.call;
  const dry = await k.ok(operate, "project_add", { url: "https://github.com/acme/shop/tree/main", dryRun: true, machineId: "devbox" });
  expect(dry.clone).toEqual({ machineId: "devbox", path: "/home/me/src/shop", exists: false, sameRemote: false });
  expect(dry.next).toBe("project_add clones it to /home/me/src/shop on devbox.");
  const out = await k.ok(person, "project_add", { url: "acme/shop", machineId: "devbox" });
  expect(typeof out.addId).toBe("string");
  expect(out).toMatchObject({ machineId: "devbox", path: "/home/me/src/shop", created: true });
  expect(out.projectId).toBeUndefined();
  expect(n.calls.find((c) => c.op === "repo_clone")).toEqual({ op: "repo_clone", addId: out.addId, url: "https://github.com/acme/shop", dest: "/home/me/src/shop" });
  ex.handleFrame("devbox", { t: "clone_progress", addId: out.addId, phase: "receiving", percent: 40, detail: "12 MiB" });
  ex.handleFrame("devbox", { t: "clone_progress", addId: out.addId, phase: "receiving", percent: 41 });
  expect(cloned).toBeDefined();
  cloned?.();
  await settle();
  await settle();
  const progress = events(k.hub).page(0, ["project.clone_progress"]).events;
  expect(progress.map((e) => e.summary)).toEqual([
    "cloning acme/shop on devbox: starting",
    "cloning acme/shop on devbox: receiving 40%",
    "cloning acme/shop on devbox: inspecting",
  ]);
  expect(progress[1]?.data).toEqual({ addId: out.addId, repo: "acme/shop", path: "/home/me/src/shop", phase: "receiving", percent: 40, detail: "12 MiB" });
  const landed = added(k);
  expect(landed).toHaveLength(1);
  expect(landed[0]?.data).toMatchObject({ addId: out.addId, title: "shop", path: "/home/me/src/shop", created: true });
});

test("a clone that fails says why, with git's fix", async () => {
  const k = kit();
  clones(k.hub);
  await node(k, ["repos"], (call) => {
    if (call.op === "repo_inspect") return { ok: { kind: "repo_facts", exists: false, isGit: false } };
    if (call.op === "repo_clone") return { err: { code: "git", message: "repository 'https://github.com/acme/shop/' not found" } };
    return undefined;
  });
  gh(k, { "repos/acme/shop": { default_branch: "main" } });
  const out = await k.ok(operate, "project_add", { url: "acme/shop", machineId: "devbox" });
  await settle();
  const failed = events(k.hub).page(0, ["project.add_failed"]).events;
  expect(failed.map((e) => e.data)).toEqual([
    {
      addId: out.addId,
      repo: "acme/shop",
      path: "/home/me/src/shop",
      code: "gh_no_access",
      message: "cloning acme/shop on devbox failed: repository 'https://github.com/acme/shop/' not found",
      fix: "On devbox, run `gh auth login` with an account that can read acme/shop, then add it again",
    },
  ]);
  // gh on the hub can't see a repository: refused before anything is cloned.
  expect(await k.refused(operate, "project_add", { url: "acme/secret", machineId: "devbox" })).toBe("not_found");
});

test("a plain folder takes a repo by path, lists it and takes it out again", async () => {
  const k = kit();
  const r = { machineId: "devbox", projectId: "notes" };
  const api = { kind: "repo_facts" as const, exists: true, isGit: true, remote: "git@github.com:acme/api.git", defaultBranch: "main", workflowFiles: [] };
  const n = await node(k, ["repos", "project_env_copy"], (call) => {
    if (call.op === "repo_inspect" && call.path === "/home/me/src/api") return { ok: api };
    if (call.op === "repo_inspect" && call.path === "/home/me/plain") return { ok: { kind: "repo_facts", exists: true, isGit: false } };
    return undefined;
  });
  n.event({ type: "project_upserted", projectId: "notes", title: "Notes", workspaceRoot: "/home/me/notes", updatedAt: AT });
  gh(k, { "repos/acme/api": { default_branch: "main", allow_squash_merge: true } });
  await settle();
  expect((await k.ok(key("read"), "project_repo_list", r)).next).toBe("A plain folder: project_repo_add adds a repo by path or GitHub URL.");
  expect(await k.refused(operate, "project_repo_add", { ...r, path: "/home/me/notes" })).toBe("invalid");
  expect(await k.refused(operate, "project_repo_add", { ...r, path: "/home/me/plain" })).toBe("invalid");
  expect(await k.refused(operate, "project_repo_add", { ...r, path: "/x", url: "acme/api" })).toBe("invalid");
  const out = await k.ok(operate, "project_repo_add", { ...r, path: "/home/me/src/api/" });
  expect(out.repo).toMatchObject({ name: "api", repoKey: "github.com/acme/api", base: "main", path: "/home/me/src/api" });
  expect(out.next).toBe("api is a repo of the project now, at /home/me/src/api on devbox.");
  const copy = n.calls.find((c) => c.op === "project_env_copy");
  expect(copy).toMatchObject({ from: "notes" });
  const listed = await k.ok(key("read"), "project_repo_list", r);
  expect(listed.repos.map((x: { name: string }) => x.name)).toEqual(["api"]);
  expect(added(k).at(-1)?.summary).toStartWith("api added to Notes on devbox: ");
  expect(await k.refused(operate, "project_repo_add", { ...r, path: "/home/me/src/api", name: "api" })).toBe("invalid");
  // The checkout is hidden while the project holds it; taken out, it shows again.
  const removed = await k.ok(operate, "project_repo_remove", { ...r, name: "api" });
  expect(removed.cancelled).toEqual([]);
  expect(removed.next).toBe(
    "Its checkout stays at /home/me/src/api on devbox, files and all. No project holds it now, so it shows as a project of its own again; project_remove forgets it (its files stay).",
  );
  expect(events(k.hub).page(0, ["project.settings"]).events.at(-1)?.data).toEqual({ repoRemoved: "api" });
  expect(await k.refused(operate, "project_repo_remove", { ...r, name: "api" })).toBe("not_found");
});

test("attaching a project of its own archives it, and an archived project takes no repo", async () => {
  const k = kit();
  const n = await node(k, ["repos"], (call) =>
    call.op === "repo_inspect" ? { ok: { kind: "repo_facts", exists: true, isGit: true, workflowFiles: [] } } : undefined,
  );
  gh(k, {});
  n.event({ type: "project_upserted", projectId: "web", title: "Web", workspaceRoot: "/home/me/web", updatedAt: AT });
  n.event({ type: "project_upserted", projectId: "site", title: "Site", workspaceRoot: "/home/me/site", updatedAt: AT });
  await settle();
  const web = { machineId: "devbox", projectId: "web" };
  const site = { machineId: "devbox", projectId: "site" };
  // Its agents still run: refused.
  k.hub.db.conn.run(`INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES ('devbox', 'site', 'W1', 'running', '{"projectRef":{"machineId":"devbox","projectId":"site"}}')`);
  expect(await k.refused(operate, "project_repo_add", { ...web, path: "/home/me/site" })).toBe("invalid");
  k.hub.db.conn.run("UPDATE tasks SET state = 'done'");
  const out = await k.ok(operate, "project_repo_add", { ...web, path: "/home/me/site" });
  expect(out.archived).toEqual(site);
  expect(out.next).toContain("The project site it was is archived");
  const refused = await k.call(operate, "project_repo_add", { ...site, path: "/home/me/web" });
  expect(refused).toMatchObject({ error: { error: { code: "invalid", message: "This project is archived: its directory is repo site of project web on devbox." } } });
});

test("removing a project waits for the erase port, after its gates", async () => {
  const k = kit();
  const r = { machineId: "devbox", projectId: "app" };
  // A machine the hub no longer has: the project is unknown, or forgotten once the erase is ported.
  expect(await k.refused(operate, "project_remove", r)).toBe("not_found");
  store(k.hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "offline", lastSeenAt: AT });
  expect(await k.refused(operate, "project_remove", r)).toBe("machine_offline");
  await node(k, ["repos"]);
  const old = await k.call(operate, "project_remove", r);
  expect(old).toMatchObject({ error: { error: { code: "invalid", message: "Update fleetd on devbox first: its node is too old to erase a project, so nothing was deleted" } } });
  (link(k.hub) as unknown as { capabilities: Map<string, Set<string>> }).capabilities.set("devbox", new Set(["project_erase"]));
  expect(await k.refused(operate, "project_remove", { ...r, removeWorktrees: true })).toBe("invalid");
  const pending = await k.call(operate, "project_remove", r);
  expect(pending).toMatchObject({ error: { error: { code: "failed", message: expect.stringContaining("src/hub/navi/erase.ts") } } });
  expect(await k.refused(key("read"), "project_remove", r)).toBe("forbidden");
});

test("an order's variables: refused for a closed order, recorded, and dropped once it closes", async () => {
  const k = kit();
  const r = { machineId: "devbox", projectId: "app" };
  const n = await node(k, ["order_env"]);
  const w = workstream(k.hub, r, "Ship it");
  expect(refusal(k.hub, r, "nope")).toBe("nope is no order id.");
  expect(refusal(k.hub, { machineId: "devbox", projectId: "other" }, w.workstreamId)).toBe(`The project has no order ${w.workstreamId}.`);
  expect(refusal(k.hub, r, w.workstreamId)).toBeUndefined();
  const s = { project: r, orderId: w.workstreamId, name: "TOKEN", fingerprint: "fp1", bytes: 12, requestId: "q1" };
  expect(await saved(k.hub, s, AT)).toBeUndefined();
  expect(await saved(k.hub, { ...s, name: "1bad" }, AT)).toBe(`1bad for ${w.workstreamId} is not a variable the hub can record`);
  expect(orderEnvStore.list(k.hub.db.conn, r, w.workstreamId)).toEqual([{ name: "TOKEN", fingerprint: "fp1", bytes: 12, requestId: "q1", updatedAt: AT }]);
  // Open: kept.
  expect(await dropClosed(k.hub)).toBe(0);
  k.hub.db.conn.run("UPDATE workstreams SET state = 'done', data = json_set(data, '$.state', 'done')");
  expect(refusal(k.hub, r, w.workstreamId)).toBe(`${w.workstreamId} is closed: its agents are done.`);
  expect(await dropClosed(k.hub)).toBe(1);
  expect(n.calls.filter((c) => c.op === "order_env_drop")).toEqual([{ op: "order_env_drop", projectId: "app", orderId: w.workstreamId }]);
  expect(orderEnvStore.held(k.hub.db.conn)).toEqual([]);
});

test("the projects loops answer the approvals area's order checks, and a closing order's next event drops its variables", async () => {
  const k = kit();
  const r = { machineId: "devbox", projectId: "app" };
  const n = await node(k, ["order_env"]);
  const w = workstream(k.hub, r, "Ship it");
  startLoops(k.hub);
  const hooks = approvals(k.hub).deps.hooks;
  expect(await hooks.orderRefusal(r, w.workstreamId)).toBeUndefined();
  expect(await hooks.orderEnvSaved({ project: r, orderId: w.workstreamId, name: "TOKEN", fingerprint: "fp", bytes: 3, requestId: "q" }, AT)).toBeUndefined();
  k.hub.db.conn.run("UPDATE workstreams SET state = 'stopped', data = json_set(data, '$.state', 'stopped')");
  events(k.hub).append({ at: AT, type: "workstream.state", summary: "stopped" });
  for (let i = 0; i < 20 && orderEnvStore.held(k.hub.db.conn).length > 0; i++) await settle();
  expect(orderEnvStore.held(k.hub.db.conn)).toEqual([]);
  expect(n.calls.filter((c) => c.op === "order_env_drop")).toHaveLength(1);
});
