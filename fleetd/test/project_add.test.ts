// Adding, removing and inspecting projects against a fake node (crates/fleetd/src/hub/projects/create_tests.rs,
// repos_tests.rs, order_env_tests.rs): project_discover, project_add (path, create, clone), project_repo_add/list/
// remove, project_remove's gates, and an order's variables.
import { expect, test } from "bun:test";
import { approvals } from "../src/hub/approvals/index.ts";
import { checksDone, onThreadEvent } from "../src/hub/approvals/permissions.ts";
import { executors } from "../src/hub/executor/index.ts";
import { link } from "../src/hub/link/index.ts";
import { start as startLeadArea } from "../src/hub/navi/loops.ts";
import { clones } from "../src/hub/projects/add.ts";
import { start as startLoops } from "../src/hub/projects/loops.ts";
import { FOLDER_NEEDS } from "../src/hub/projects/inspect.ts";
import { dropClosed, orderEnvStore, refusal, saved } from "../src/hub/projects/order_env.ts";
import * as repos from "../src/hub/repos/store.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { gh, node, ROOT, settle } from "./project-kit.ts";
import { AT, key, kit, workstream } from "./work-kit.ts";

const operate = key("operate");
const person = key("operate", { human: true, person: { personId: "p-ada", name: "Ada" } });
const added = (k: ReturnType<typeof kit>) => events(k.hub).page(0, ["project.added"]).events;
/** The approval mode `project_approvals` reports for a project on devbox, read by Ada. */
const mode = async (k: ReturnType<typeof kit>, projectId: unknown) => (await k.ok(person, "project_approvals", { machineId: "devbox", projectId })).approvals.mode;

test("a new project gets a folder under the projects root and no repo", async () => {
  const k = kit();
  const n = await node(k, ["repos", "folder_make"]);
  gh(k, {});
  const found = await k.ok(operate, "project_discover", { github: false });
  expect(found.machines).toEqual([{ machineId: "devbox", online: true, cloneRoot: "/home/me/src", projectsRoot: ROOT, repos: [] }]);
  expect(found.best).toBe("devbox");
  // An older app still sends onlyMe: it is ignored, without an error (D491).
  const out = await k.ok(person, "project_add", { machineId: "devbox", create: true, title: "Field Notes", onlyMe: true });
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
  // A plain folder is open like any project (D491): another person and an agent's key list it, with no Only me or owner.
  expect(k.hub.db.conn.query("SELECT 1 FROM project_settings WHERE only_me = 1").get()).toBeNull();
  const bo = key("read", { human: true, person: { personId: "p-bo", name: "Bo" }, name: "bo" });
  for (const reader of [bo, key("read")]) {
    const listed = (await k.ok(reader, "project_get", {})).projects as Record<string, unknown>[];
    const notes = listed.find((p) => p.projectId === out.projectId);
    expect(notes).toMatchObject({ title: "Field Notes" });
    expect(notes).not.toHaveProperty("onlyMe");
    expect(notes).not.toHaveProperty("owner");
  }
  // A new project starts in YOLO.
  expect(await mode(k, out.projectId)).toBe("yolo");
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
  // With a repo and an agent's key too: any new project starts in YOLO.
  expect(await mode(k, site.projectId)).toBe("yolo");
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
  // A repo folder is open like any project.
  expect(k.hub.db.conn.query("SELECT 1 FROM project_settings WHERE only_me = 1").get()).toBeNull();
  await settle();
  expect(await mode(k, out.projectId)).toBe("yolo");
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
  expect(await mode(k, landed[0]?.projectId)).toBe("yolo");
});

test("a project that was there before keeps its mode: the one stored, or the checker with none stored", async () => {
  const k = kit();
  const n = await node(k, ["repos", "folder_make"]);
  gh(k, {});
  // Two projects from before new ones started in YOLO: one never set (no row), one set to ask.
  for (const projectId of ["old", "careful"]) {
    n.event({ type: "project_upserted", projectId, title: projectId, workspaceRoot: `/home/me/${projectId}`, updatedAt: AT });
    n.made.set(`/home/me/${projectId}`, false);
  }
  await settle();
  await k.ok(person, "project_approvals_set", { machineId: "devbox", projectId: "careful", mode: "ask" });
  const stored = () => k.hub.db.conn.query("SELECT project_id, mode FROM project_approvals ORDER BY project_id").all();
  expect([await mode(k, "old"), await mode(k, "careful")]).toEqual(["checker", "ask"]);
  expect(stored()).toEqual([{ project_id: "careful", mode: "ask" }]);
  // Added again, renamed, and reported again by its node: each is the same project, in the mode it had.
  for (const projectId of ["old", "careful"]) {
    const again = await k.ok(person, "project_add", { machineId: "devbox", path: `/home/me/${projectId}`, title: `${projectId} 2` });
    expect([again.projectId, again.created]).toEqual([projectId, false]);
  }
  n.event({ type: "snapshot", projects: ["old", "careful"].map((projectId) => ({ projectId, title: projectId, workspaceRoot: `/home/me/${projectId}`, updatedAt: AT })), sessions: [] });
  await settle();
  expect([await mode(k, "old"), await mode(k, "careful")]).toEqual(["checker", "ask"]);
  expect(stored()).toEqual([{ project_id: "careful", mode: "ask" }]);
  // A new one beside them starts in YOLO, and a person's change of it holds when it is added again.
  const fresh = await k.ok(person, "project_add", { machineId: "devbox", create: true, title: "Fresh" });
  expect(await mode(k, fresh.projectId)).toBe("yolo");
  await k.ok(person, "project_approvals_set", { machineId: "devbox", projectId: fresh.projectId, mode: "checker" });
  await settle();
  expect((await k.ok(person, "project_add", { machineId: "devbox", path: fresh.path, title: "Fresher" })).created).toBe(false);
  expect(await mode(k, fresh.projectId)).toBe("checker");
});

test("a new project's lead sends without asking, and is still refused or asked what every mode refuses or asks", async () => {
  const k = kit();
  const n = await node(k, ["repos", "folder_make"]);
  gh(k, {});
  const out = await k.ok(person, "project_add", { machineId: "devbox", create: true, title: "Fresh" });
  startLeadArea(k.hub);
  try {
    k.hub.db.conn.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', ?, 't-lead', '', 1)", [out.projectId]);
    const a = approvals(k.hub);
    /** The lead's prompt for `toolName`: the node's answer to it, or the card it became. */
    const prompt = async (requestId: string, toolName: string, input: unknown) => {
      const data = { permission: { requestId, toolName, summary: "", input } };
      await onThreadEvent(a, { seq: 1, at: AT, type: "thread.waiting", machineId: "devbox", projectId: out.projectId, threadId: "t-lead", summary: "", data });
      await checksDone(a);
      const answer = n.calls.find((c) => c.op === "answer" && c.requestId === requestId);
      const card = a.listQuiet({ states: ["open"] }).find((q) => q.permission?.requestId === requestId);
      return answer?.op === "answer" ? [answer.decision.behavior, "message" in answer.decision ? answer.decision.message : undefined] : ["card", card?.permission?.preview?.action];
    };
    // YOLO: a send and a first visit to a site run, with no card and no checker.
    expect(await prompt("p-1", "mcp__mail__send_message", { to: ["sam@example.org"], body: "Saturday works" })).toEqual(["allow", undefined]);
    expect(await prompt("p-2", "WebFetch", { url: "https://example.org/x" })).toEqual(["allow", undefined]);
    expect(k.hub.db.conn.query("SELECT COUNT(*) AS n FROM project_auto_approved").get()).toEqual({ n: 2 });
    // The floors: a money move, by a tool or by a link, and a credential in what goes out.
    const MONEY = "Blocked by fleetd: an assistant never moves money between accounts, even with your approval.";
    expect(await prompt("p-3", "mcp__bank__transfer_funds", { to: "sam", amount: 5 })).toEqual(["deny", expect.stringContaining(MONEY)]);
    expect(await prompt("p-4", "WebFetch", { url: "https://bank.example/transfer?amount=50&to=sam" })).toEqual(["deny", expect.stringContaining(MONEY)]);
    const leak = { to: ["sam@example.org"], body: `the key is sk-ant-api03-${"a".repeat(48)}` };
    expect(await prompt("p-5", "mcp__mail__send_message", leak)).toEqual(["deny", expect.stringContaining("what looks like a password, key or token")]);
    // Spending through a server's tool still asks the person.
    expect(await prompt("p-6", "mcp__shop__create_order", { item: "tea" })).toEqual(["card", "spend"]);
  } finally {
    k.hub.shutdown.abort();
  }
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

test("removing a project checks its gates, then removes it and the checkouts only it holds, and erases it", async () => {
  const k = kit();
  const app = { machineId: "devbox", projectId: "app" };
  const caps = (list: string[]) => (link(k.hub) as unknown as { capabilities: Map<string, Set<string>> }).capabilities.set("devbox", new Set(list));
  store(k.hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "offline", lastSeenAt: AT });
  expect(await k.refused(operate, "project_remove", app)).toBe("machine_offline");
  const git = { kind: "repo_facts" as const, exists: true, isGit: true, workflowFiles: [] };
  const n = await node(k, ["repos"], (call) => (call.op === "repo_inspect" ? { ok: git } : undefined));
  gh(k, {});
  for (const [id, root] of [["app", "/work/app"], ["shop", "/work/shop"]]) {
    n.event({ type: "project_upserted", projectId: id, title: id, workspaceRoot: root, updatedAt: AT });
  }
  await settle();
  const old = await k.call(operate, "project_remove", app);
  expect(old).toMatchObject({ error: { error: { code: "invalid", message: "Update fleetd on devbox first: its node is too old to erase a project, so nothing was deleted" } } });
  caps(["repos", "project_erase"]);
  // Its worktrees go only from a node that takes project settings.
  expect(await k.refused(operate, "project_remove", { ...app, removeWorktrees: true })).toBe("invalid");
  expect(await k.refused(key("read"), "project_remove", app)).toBe("forbidden");
  caps(["repos", "project_erase", "project_settings"]);
  // app holds api alone; api2 is shop's too, so it stays.
  await k.ok(operate, "project_repo_add", { ...app, path: "/work/api" });
  await settle();
  await k.ok(operate, "project_repo_add", { ...app, path: "/work/api2" });
  await settle();
  await k.ok(operate, "project_repo_add", { machineId: "devbox", projectId: "shop", path: "/work/api2" });
  const checkout = (name: string) => repos.byName(k.hub.db.conn, app, name)?.checkout.projectId;
  const api = checkout("api");
  const api2 = checkout("api2");
  n.calls.length = 0;
  const out = await k.ok(operate, "project_remove", { ...app, removeWorktrees: true });
  expect(out).toEqual({
    ok: true,
    next: "Erased: its chat, memory, skills, approvals and purchases, asks and decisions, orders and tasks, automations, kept browser sign-ins, linked hubs, transcripts, attachments and screen recordings. Its folder, files and branches stay on the machine.",
  });
  expect(n.calls.filter((c) => c.op === "project_remove")).toEqual([
    { op: "project_remove", projectId: "app", removeWorktrees: true, erase: true },
    { op: "project_remove", projectId: api as string, removeWorktrees: true },
  ]);
  // Erased in the hub, its mark included; the node's project_removed takes it and api out of the list.
  expect(k.hub.db.conn.query("SELECT COUNT(*) AS n FROM project_erases").get()).toEqual({ n: 0 });
  await settle();
  expect(store(k.hub).projectsList("devbox").map((p) => p.projectId).sort()).toEqual([api2 as string, "shop"].sort());
  // Its folder goes only when asked, never a checkout's; shop holds api2 alone now, so it goes too.
  n.calls.length = 0;
  const folder = await k.ok(operate, "project_remove", { machineId: "devbox", projectId: "shop", removeFolder: true });
  expect(folder.next).toEndWith(", and its folder with everything in it.");
  expect(n.calls.filter((c) => c.op === "project_remove")).toEqual([
    { op: "project_remove", projectId: "shop", erase: true, removeFolder: true },
    { op: "project_remove", projectId: api2 as string },
  ]);
});

test("a project of a machine the hub no longer has is forgotten in the hub, and says so", async () => {
  const k = kit();
  const r = { machineId: "gone", projectId: "app" };
  expect(await k.refused(operate, "project_remove", r)).toBe("not_found");
  store(k.hub).projectsUpsertMany("gone", [
    { machineId: "gone", projectId: "app", title: "App", workspaceRoot: "/w/app", lastActivityAt: AT, threads: { running: 0, idle: 0, failed: 0, waiting: 0 } } as never,
  ]);
  const out = await k.ok(operate, "project_remove", r);
  expect(out.next).toBe("gone is no longer in the hub, so no machine held its files: fleetd forgot the project, its chat and its settings.");
  expect(store(k.hub).projectGet(r)).toBeUndefined();
  expect(events(k.hub).page(0, ["project.removed"]).events.map((e) => [e.summary, e.data])).toEqual([
    ['Project "App" on gone was forgotten: its machine was removed', { title: "App" }],
  ]);
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

test("removing a repo names the tasks the leads area's removals cancelled", async () => {
  const k = kit();
  const r = { machineId: "devbox", projectId: "notes" };
  const api = { kind: "repo_facts" as const, exists: true, isGit: true, workflowFiles: [] };
  const n = await node(k, ["repos"], (call) => (call.op === "repo_inspect" ? { ok: api } : undefined));
  n.event({ type: "project_upserted", projectId: "notes", title: "Notes", workspaceRoot: "/home/me/notes", updatedAt: AT });
  gh(k, {});
  await settle();
  await k.ok(operate, "project_repo_add", { ...r, path: "/home/me/src/api", name: "api" });
  // The leads area makes it at its start; here, the area as its owner would.
  k.hub.area("lead_removals", () => ({ reconcile: async () => {}, endRemovedRepos: async () => ["T7"] }));
  expect((await k.ok(operate, "project_repo_remove", { ...r, name: "api" })).cancelled).toEqual(["T7"]);
});
