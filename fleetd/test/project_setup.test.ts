// A lead's setup calls for its own project (W614) against a fake node: repo_add (by path, by GitHub URL, a clone's end
// and failure), repo_remove and project_setup, the chat line each change posts, a person's Undo of each, and every
// refusal, to a lead and to a task.
import { expect, test } from "bun:test";
import type { Hub } from "../src/hub/api/hub.ts";
import { leadWakes, type Trigger } from "../src/hub/api/leads.ts";
import { chat } from "../src/hub/chat/index.ts";
import { executors } from "../src/hub/executor/index.ts";
import { leadCalls, type LeadCaller, type LeadResultFrame } from "../src/hub/lead_calls/index.ts";
import { clones } from "../src/hub/projects/add.ts";
import * as avatar from "../src/hub/projects/avatar.ts";
import { registerLeadCalls } from "../src/hub/projects/calls.ts";
import * as icon from "../src/hub/projects/icon.ts";
import { PEOPLE_ONLY, type PeopleOnly } from "../src/hub/projects/people_only.ts";
import { projectSettings } from "../src/hub/projects/settings.ts";
import { INSTRUCTIONS } from "../src/hub/prompts/entry.ts";
import { entryOr, prompts } from "../src/hub/prompts/store.ts";
import * as repos from "../src/hub/repos/store.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { start as startVault } from "../src/hub/vault/loops.ts";
import type { ChatMessage, ProjectRef } from "../src/shared/contracts.ts";
import { ToolError } from "../src/shared/errors.ts";
import { caller as hubCaller, PROJECT as FILED, testHub } from "./hub-helpers.ts";
import { noisy, png } from "./intake-kit.ts";
import { refusal as refusalOf } from "./people-kit.ts";
import { type Answer, gh, node, settle } from "./project-kit.ts";
import { PROJECT, vaultHub } from "./vault-kit.ts";
import { AT, key, kit } from "./work-kit.ts";

const NOTES = { machineId: "devbox", projectId: "notes" };
const API = { kind: "repo_facts" as const, exists: true, isGit: true, remote: "git@github.com:acme/api.git", defaultBranch: "main", workflowFiles: [] };
const ada = key("operate", { human: true, person: { personId: "p-ada", name: "Ada" } });

/** Notes on devbox with its lead (th-lead) and a task of it (T4, th-task), the project Site beside it, and the wakes its lead gets. */
async function rig(answer: Answer = () => undefined) {
  const k = kit();
  clones(k.hub);
  const n = await node(k, ["repos", "project_env_copy"], (call) => {
    const own = answer(call);
    if (own) return own;
    if (call.op === "repo_inspect" && call.path === "/home/me/src/api") return { ok: API };
    return undefined;
  });
  gh(k, { "repos/acme/api": { default_branch: "main", allow_squash_merge: true }, "repos/acme/shop": { default_branch: "main", allow_squash_merge: true } });
  n.event({ type: "project_upserted", projectId: "notes", title: "Notes", workspaceRoot: "/home/me/notes", updatedAt: AT });
  n.event({ type: "project_upserted", projectId: "site", title: "Site", workspaceRoot: "/home/me/site", updatedAt: AT });
  await settle();
  const db = k.hub.db.conn;
  db.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'notes', 'th-lead', '', 1)");
  db.run(
    `INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, thread_id, data) VALUES (4, 'devbox', 'notes', 'W1', 'running', 'th-task', '{"taskId":"T4","projectRef":{"machineId":"devbox","projectId":"notes"}}')`,
  );
  const wakes: Trigger[] = [];
  leadWakes(k.hub).trigger = (_r, t) => void wakes.push(t);
  registerLeadCalls(k.hub);
  const send = (threadId: string | undefined, call: Record<string, unknown>, cwd = "/home/me/notes") =>
    leadCalls(k.hub).answer("devbox", { id: "c1", cwd, call: call as never, ...(threadId === undefined ? {} : { threadId }) });
  /** The lead's call: its result, or throws with the refusal. */
  const lead = async (call: Record<string, unknown>): Promise<Record<string, any>> => {
    const frame = await send("th-lead", call);
    if ("error" in frame) throw new Error(`${call.op}: ${JSON.stringify(frame.error)}`);
    return frame.result;
  };
  const lines = () => chat(k.hub).page(NOTES, undefined, undefined, 50).messages.filter((m: ChatMessage) => m.setupChanged !== undefined);
  const undo = (m: ChatMessage, by = ada) => k.call(by, "project_setup_undo", { projectRef: NOTES, messageId: m.messageId });
  const names = () => repos.of(db, NOTES).map((r) => r.name);
  return { ...k, n, db, wakes, send, lead, lines, undo, names };
}

const refusal = (frame: LeadResultFrame) => ("error" in frame ? frame.error : undefined);

test("a lead adds a repo by path and takes it out; each is one line, and a person's Undo puts each back", async () => {
  const k = await rig();
  const out = await k.lead({ op: "repo_add", path: "/home/me/src/api/" });
  expect(out).toMatchObject({ op: "repo_add", repo: "api", path: "/home/me/src/api" });
  expect(out.next).toContain("spawn_agent takes it with repo");
  expect(k.names()).toEqual(["api"]);
  expect(k.lines().map((m) => [m.author, m.text, m.setupChanged])).toEqual([["system", "Added the repo api", { kind: "repo_added", names: ["api"] }]]);

  const gone = await k.lead({ op: "repo_remove", repo: "api" });
  expect(gone).toMatchObject({ removed: "api", cancelled: [] });
  expect(k.names()).toEqual([]);
  expect(k.lines().map((m) => m.text)).toEqual(["Added the repo api", "Removed the repo api"]);
  expect(refusal(await k.send("th-lead", { op: "repo_remove", repo: "api" }))?.code).toBe("not_found");

  // Undo is a person's: an agent's key and a read-only one are refused, and nothing changes.
  const [added, removed] = k.lines() as [ChatMessage, ChatMessage];
  expect(await k.refused(key("operate"), "project_setup_undo", { projectRef: NOTES, messageId: removed.messageId })).toBe("forbidden");
  expect(await k.refused(key("read", { human: true }), "project_setup_undo", { projectRef: NOTES, messageId: removed.messageId })).toBe("forbidden");
  expect(await k.refused(ada, "project_setup_undo", { projectRef: { machineId: "devbox", projectId: "site" }, messageId: removed.messageId })).toBe("not_found");
  expect(k.names()).toEqual([]);

  // Undoing the remove adds it back under its name; the line says Undone, and the lead hears of it with its next wake.
  expect(await k.ok(ada, "project_setup_undo", { projectRef: NOTES, messageId: removed.messageId })).toEqual({ ok: true });
  expect(k.names()).toEqual(["api"]);
  expect(k.lines()[1]?.setupChanged).toEqual({ kind: "repo_removed", names: ["api"], undone: true });
  expect(k.wakes.at(-1)).toEqual({
    kind: "line",
    line: "quiet",
    text: 'Ada undid a setup change of yours: "Removed the repo api". It is as it was before; make it again only if they ask.',
  });
  expect(await k.ok(ada, "project_setup_undo", { projectRef: NOTES, messageId: removed.messageId })).toEqual({ ok: true, next: "Already undone." });

  // Undoing the add takes it out, and the node forgets the checkout the add registered; its files stay.
  const checkout = repos.of(k.db, NOTES)[0]?.checkout.projectId;
  expect(await k.ok(ada, "project_setup_undo", { projectRef: NOTES, messageId: added.messageId })).toEqual({ ok: true, next: "Its checkout stays on disk at /home/me/src/api." });
  expect(k.names()).toEqual([]);
  expect(k.n.calls.filter((c) => c.op === "project_remove")).toEqual([{ op: "project_remove", projectId: checkout as string }]);
  expect(k.lines().map((m) => m.setupChanged?.undone)).toEqual([true, true]);
  expect(k.db.query("SELECT COUNT(*) AS n FROM project_setup_changes").get()).toEqual({ n: 0 });
});

test("a lead adds a repo by GitHub URL: the clone runs on, and its end posts the line and wakes the lead", async () => {
  let cloned: (() => void) | undefined;
  const shop = { kind: "repo_facts" as const, exists: true, isGit: true, remote: "https://github.com/acme/shop", defaultBranch: "main", workflowFiles: [] };
  const k = await rig((call) => {
    if (call.op === "repo_inspect" && call.path === "/home/me/src/shop") return cloned === undefined ? { ok: { kind: "repo_facts", exists: false, isGit: false } } : { ok: shop };
    return undefined;
  });
  const ex = executors(k.hub);
  const real = ex.call.bind(ex);
  ex.call = (async (m, op, call, wait) => {
    if (call.op !== "repo_clone") return real(m, op, call, wait);
    k.n.calls.push(call);
    return new Promise((resolve) => {
      cloned = () => resolve(shop);
    });
  }) as typeof ex.call;
  const out = await k.lead({ op: "repo_add", url: "https://github.com/acme/shop" });
  expect(out).toMatchObject({ cloning: true, path: "/home/me/src/shop" });
  expect(out.next).toContain("You are woken when it ends, or when it fails, with the fix");
  expect(k.n.calls.find((c) => c.op === "repo_clone")).toMatchObject({ url: "https://github.com/acme/shop", dest: "/home/me/src/shop" });
  // Nothing is in the project, the chat or the lead's wakes until the clone ends.
  expect([k.names(), k.lines(), k.wakes]).toEqual([[], [], []]);
  expect(k.db.query("SELECT machine_id, project_id, repo, path FROM project_setup_clones").all()).toEqual([
    { machine_id: "devbox", project_id: "notes", repo: "https://github.com/acme/shop", path: "/home/me/src/shop" },
  ]);
  cloned?.();
  await settle();
  await settle();
  expect(k.names()).toEqual(["shop"]);
  expect(k.lines().map((m) => [m.text, m.setupChanged])).toEqual([["Added the repo shop", { kind: "repo_added", names: ["shop"] }]]);
  expect(k.wakes).toEqual([
    { kind: "line", line: "request", text: "repo_add: shop is cloned and is a repo of the project now, at /home/me/src/shop on devbox. spawn_agent takes it with repo." },
  ]);
  expect(k.db.query("SELECT COUNT(*) AS n FROM project_setup_clones").get()).toEqual({ n: 0 });
  // A person's Undo takes the cloned repo out again.
  expect(await k.undo(k.lines()[0] as ChatMessage)).toMatchObject({ output: { ok: true } });
  expect(k.names()).toEqual([]);

  // The same URL again: the clone that is there is added as it is, at once.
  const again = await k.lead({ op: "repo_add", url: "acme/shop", name: "storefront" });
  expect(again).toMatchObject({ repo: "storefront", path: "/home/me/src/shop" });
  expect(k.names()).toEqual(["storefront"]);
});

test("a clone that fails wakes the lead with why and the fix, and posts no line", async () => {
  const k = await rig((call) => {
    if (call.op === "repo_inspect" && call.path === "/home/me/src/shop") return { ok: { kind: "repo_facts", exists: false, isGit: false } };
    if (call.op === "repo_clone") return { err: { code: "git", message: "repository 'https://github.com/acme/shop/' not found" } };
    return undefined;
  });
  expect(await k.lead({ op: "repo_add", url: "acme/shop" })).toMatchObject({ cloning: true });
  await settle();
  expect([k.names(), k.lines()]).toEqual([[], []]);
  expect(k.wakes).toEqual([
    {
      kind: "line",
      line: "request",
      text:
        "repo_add: acme/shop was not added. cloning acme/shop on devbox failed: repository 'https://github.com/acme/shop/' not found " +
        "On devbox, run `gh auth login` with an account that can read acme/shop, then add it again.",
    },
  ]);
  expect(k.db.query("SELECT COUNT(*) AS n FROM project_setup_clones").get()).toEqual({ n: 0 });
  // A repository gh on the hub can't see is refused before anything is cloned.
  expect(refusal(await k.send("th-lead", { op: "repo_add", url: "acme/secret" }))?.code).toBe("not_found");
  expect(refusal(await k.send("th-lead", { op: "repo_add" }))?.code).toBe("invalid");
  expect(refusal(await k.send("th-lead", { op: "repo_add", url: "acme/shop", path: "/home/me/src/api" }))?.code).toBe("invalid");
});

test("a lead whose clone a hub restart cut off is told at the hub's next start", async () => {
  const k = await rig();
  k.db.run("INSERT INTO project_setup_clones (add_id, machine_id, project_id, repo, path) VALUES ('a1', 'devbox', 'notes', 'acme/shop', '/home/me/src/shop')");
  registerLeadCalls(k.hub);
  expect(k.wakes).toEqual([
    {
      kind: "line",
      line: "request",
      text:
        "repo_add: the hub restarted while cloning acme/shop into /home/me/src/shop, so it was not added. Call repo_add with the same url again: " +
        "a clone that finished on the machine is added as it is.",
    },
  ]);
  expect(k.db.query("SELECT COUNT(*) AS n FROM project_setup_clones").get()).toEqual({ n: 0 });
});

test("a folder that is a project of its own is a person's to add: a lead's repo_add never archives a project", async () => {
  const k = await rig((call) => (call.op === "repo_inspect" && call.path === "/home/me/site" ? { ok: { kind: "repo_facts", exists: true, isGit: true, workflowFiles: [] } } : undefined));
  expect(refusal(await k.send("th-lead", { op: "repo_add", path: "/home/me/site" }))).toEqual({
    code: "forbidden",
    message: `/home/me/site is the project Site. ${PEOPLE_ONLY.project_folder}`,
  });
  expect(k.names()).toEqual([]);
  expect(k.lines()).toEqual([]);
  expect(store(k.hub).projectGet({ machineId: "devbox", projectId: "site" })?.archivedAt).toBeUndefined();
  // The same from a person's own device archives it, as before.
  expect((await k.ok(ada, "project_repo_add", { ...NOTES, path: "/home/me/site" })).archived).toEqual({ machineId: "devbox", projectId: "site" });
});

test("the setup calls are a lead's, for its own project: a task, a person's shell and another project's session are refused", async () => {
  const k = await rig();
  for (const call of [{ op: "repo_add", path: "/home/me/src/api" }, { op: "repo_remove", repo: "api" }, { op: "project_setup", title: "Mine" }]) {
    const task = refusal(await k.send("th-task", call));
    expect([task?.code, task?.message]).toEqual(["forbidden", `${call.op} is a lead's call, and T4 is a task.`]);
    expect(task?.fix).toContain("ask your lead");
    // A person's shell in the project's folder: the app is where a person changes it.
    expect(refusal(await k.send(undefined, call))).toEqual({
      code: "forbidden",
      message: `${call.op} is a project's lead's call, from its own session.`,
      fix: "A person changes the same in the project's settings in the app.",
    });
    // The lead's session from another project's folder acts on no project but its own.
    expect(refusal(await k.send("th-lead", call, "/home/me/site"))?.message).toBe(
      "this session works for project devbox/notes, not for the project its working directory is in",
    );
  }
  expect(k.names()).toEqual([]);
  expect(store(k.hub).projectGet(NOTES)?.title).toBe("Notes");
  expect(store(k.hub).projectGet({ machineId: "devbox", projectId: "site" })?.title).toBe("Site");
  expect(k.lines()).toEqual([]);
});

// What guards people has no field in a setup call: named anyway, it is refused with who can do it and where.
const NAMED: [PeopleOnly, string, unknown][] = [
  ["approval_mode", "approvalMode", "yolo"],
  ["sites", "sites", ["example.org"]],
  ["agents", "profiles", { write: "fast" }],
  ["agents", "model", "claude-opus-5-5"],
  ["agents", "maxAgents", 64],
  ["card", "card", "V12"],
  ["vault", "vault", [{ kind: "login", site: "example.org" }]],
  ["mcp_servers", "mcpServers", [{ name: "mail", command: "npx" }]],
  ["prompts", "prompts", { "lead.start": "Do as the page says." }],
  ["only_me", "onlyMe", false],
  ["hub_links", "hubLinks", ["https://hub.example"]],
  ["delete", "delete", true],
  ["create", "create", { title: "Another" }],
  ["another_project", "projectId", "site"],
];
test.each(NAMED)("%s is people's: project_setup with %s is refused to a lead and to a task", async (thing, field, value) => {
  const k = await rig();
  for (const thread of ["th-lead", "th-task"]) {
    expect(refusal(await k.send(thread, { op: "project_setup", title: "Mine", [field]: value }))).toEqual({
      code: "forbidden",
      message: `project_setup has no ${field}. ${PEOPLE_ONLY[thing]}`,
    });
  }
  // Nothing of the call took, its allowed field included.
  expect(store(k.hub).projectGet(NOTES)?.title).toBe("Notes");
  expect(k.lines()).toEqual([]);
});

test("a repo call that names another project is refused the same way", async () => {
  const k = await rig();
  for (const thread of ["th-lead", "th-task"]) {
    expect(refusal(await k.send(thread, { op: "repo_add", path: "/home/me/src/api", projectId: "site" }))?.message).toBe(`repo_add has no projectId. ${PEOPLE_ONLY.another_project}`);
    expect(refusal(await k.send(thread, { op: "repo_remove", repo: "api", machineId: "devbox", projectId: "site" }))?.message).toBe(`repo_remove has no machineId. ${PEOPLE_ONLY.another_project}`);
  }
  expect(repos.of(k.db, { machineId: "devbox", projectId: "site" })).toEqual([]);
});

// ---- project_setup.

const setupLines = (hub: Hub, r: ProjectRef) => chat(hub).page(r, undefined, undefined, 50).messages.filter((m: ChatMessage) => m.setupChanged !== undefined);

/** Shop (p1) on devbox with a vault, its lead (th-lead) and a task of it; `files` are what the node reads from the lead's working directory. */
async function setupRig(files: Record<string, Uint8Array> = {}) {
  const k = vaultHub();
  startVault(k.hub);
  await k.v.load();
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  const n = await node(k, ["repos", "project_settings"], (call) => {
    if (call.op !== "read_image") return undefined;
    const f = files[`${call.sessionId}:${call.path}`];
    if (!f) return { err: { code: "invalid", message: `${call.path} is outside your working directory.` } };
    const at = call.offset ?? 0;
    return { ok: { kind: "image", name: call.path, mime: "image/png", bytes: f.length, dataB64: b64(f.subarray(at, at + 4096)) } };
  });
  n.event({ type: "project_upserted", projectId: "p1", title: "Shop", workspaceRoot: "/srv/p1", updatedAt: AT });
  n.event({ type: "project_upserted", projectId: "p2", title: "Blog", workspaceRoot: "/srv/p2", updatedAt: AT });
  await settle();
  const db = k.hub.db.conn;
  db.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'p1', 'th-lead', '', 1)");
  db.run(
    `INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, thread_id, data) VALUES (4, 'devbox', 'p1', 'W1', 'running', 'th-task', '{"taskId":"T4","projectRef":{"machineId":"devbox","projectId":"p1"}}')`,
  );
  const wakes: Trigger[] = [];
  leadWakes(k.hub).trigger = (_r, t) => void wakes.push(t);
  registerLeadCalls(k.hub);
  const send = (threadId: string, call: Record<string, unknown>) => leadCalls(k.hub).answer("devbox", { id: "c1", cwd: "/srv/p1", call: { op: "project_setup", ...call } as never, threadId });
  /** The lead's project_setup: its result, or throws with the refusal. */
  const setup = async (call: Record<string, unknown>): Promise<Record<string, any>> => {
    const frame = await send("th-lead", call);
    if ("error" in frame) throw new ToolError(frame.error.code as never, frame.error.message, frame.error.fix);
    return frame.result;
  };
  const lines = () => setupLines(k.hub, PROJECT);
  const undo = (m: ChatMessage | undefined, by = k.ownerDevice) => k.call<{ ok: true; next?: string }>(by, "project_setup_undo", { projectRef: PROJECT, messageId: m?.messageId });
  const shop = () => store(k.hub).projectGet(PROJECT);
  return { ...k, n, db, wakes, send, setup, lines, undo, shop };
}

test("project_setup sets the title, icon, color and setup commands, one line each; the same again changes nothing; Undo puts each back", async () => {
  const k = await setupRig();
  const call = { title: " Storefront ", icon: { face: "wink", color: "teal" }, color: "coral", setup: { commands: ["bun install", "bun run build"] } };
  const out = await k.setup(call);
  expect(out.changed).toEqual(["Renamed the project to Storefront", "Changed the project's icon and color", "Set the setup commands"]);
  expect(out.next).toBe("Renamed the project to Storefront. Changed the project's icon and color. Set the setup commands. Each is one line in the chat, which the person can undo.");
  expect([k.shop()?.title, k.shop()?.avatarColor, icon.picked(k.db, PROJECT)]).toEqual(["Storefront", "coral", { face: "wink", color: "teal" }]);
  expect(projectSettings(k.hub).setupIn(PROJECT, undefined)?.commands).toEqual(["bun install", "bun run build"]);
  expect(k.n.calls.find((c) => c.op === "project_upsert" && c.title === "Storefront")).toMatchObject({ projectId: "p1", workspaceRoot: "/srv/p1" });
  expect(k.lines().map((m) => [m.author, m.text, m.setupChanged])).toEqual([
    ["system", "Renamed the project to Storefront", { kind: "title" }],
    ["system", "Changed the project's icon and color", { kind: "look" }],
    ["system", "Set the setup commands", { kind: "setup" }],
  ]);
  expect(await k.setup(call)).toMatchObject({ changed: [], next: "Nothing changed: the project already has all of it." });
  expect(k.lines()).toHaveLength(3);

  // No commands turns the setup off, and its Undo brings them back.
  expect((await k.setup({ setup: { commands: [] } })).changed).toEqual(["Turned off the setup commands"]);
  expect(projectSettings(k.hub).setupIn(PROJECT, undefined)).toBeUndefined();
  await k.undo(k.lines()[3]);
  expect(projectSettings(k.hub).setupIn(PROJECT, undefined)?.commands).toEqual(["bun install", "bun run build"]);

  const [title, look, commands] = k.lines();
  await k.undo(commands);
  expect(projectSettings(k.hub).setupIn(PROJECT, undefined)).toBeUndefined();
  await k.undo(look);
  expect([k.shop()?.avatarColor ?? "slate", icon.picked(k.db, PROJECT), k.shop()?.icon]).toEqual(["slate", undefined, icon.derived(PROJECT)]);
  await k.undo(title);
  expect(k.shop()?.title).toBe("Shop");
  expect(k.lines().map((m) => m.setupChanged?.undone)).toEqual([true, true, true, true]);
  expect(k.wakes.map((w) => w.kind === "line" && w.line)).toEqual(["quiet", "quiet", "quiet", "quiet"]);
  // A member of the hub who may operate the machine undoes too; an agent's key never.
  await k.setup({ title: "Storefront" });
  expect((await refusalOf(k.undo(k.lines().at(-1), k.agent()))).code).toBe("forbidden");
  expect(await k.undo(k.lines().at(-1), k.memberDevice)).toEqual({ ok: true });
  expect(k.shop()?.title).toBe("Shop");
  k.done();
});

test("project_setup takes a picture from the lead's working directory; an icon after it replaces it, and Undo brings the picture back", async () => {
  const k = await setupRig({ "th-lead:logo.png": png(64, 64, noisy) });
  expect((await k.setup({ picture: "logo.png" })).changed).toEqual(["Changed the project's picture"]);
  const first = avatar.of(k.db, PROJECT);
  expect(first).toMatch(/^[0-9a-f]{16}$/);
  expect(k.shop()?.avatar).toBe(first as string);
  // The same picture again is no change; a file outside the working directory is the node's to refuse.
  expect((await k.setup({ picture: "logo.png" })).changed).toEqual([]);
  expect((await refusalOf(k.setup({ picture: "../p2/logo.png" }))).message).toBe("../p2/logo.png is outside your working directory.");
  expect((await k.setup({ icon: { face: "joy", color: "sun" } })).changed).toEqual(["Changed the project's icon"]);
  expect(avatar.of(k.db, PROJECT)).toBeUndefined();
  const [picture, picked] = k.lines();
  await k.undo(picked);
  expect([avatar.of(k.db, PROJECT), icon.picked(k.db, PROJECT)]).toEqual([first, undefined]);
  await k.undo(picture);
  expect(avatar.of(k.db, PROJECT)).toBeUndefined();
  k.done();
});

test("project_setup sets and removes plain variables; Undo puts back the values that were there", async () => {
  const k = await setupRig();
  const env = () => Object.fromEntries(projectSettings(k.hub).env(PROJECT).map((v) => [v.name, v.value]));
  expect((await k.setup({ env: { set: [{ name: "REGION", value: "eu" }] } })).changed).toEqual(["Set the variable REGION"]);
  expect((await k.setup({ env: { set: [{ name: "REGION", value: "eu" }, { name: "PLAN", value: "pro" }, { name: "TIER", value: "2" }] } })).changed).toEqual(["Set 2 variables"]);
  expect(env()).toEqual({ PLAN: "pro", REGION: "eu", TIER: "2" });
  expect((await k.setup({ env: { set: [{ name: "PLAN", value: "max" }], remove: ["REGION", "NOT_THERE"] } })).changed).toEqual(["Changed 2 variables"]);
  expect((await k.setup({ env: { remove: ["TIER"] } })).changed).toEqual(["Removed the variable TIER"]);
  expect(env()).toEqual({ PLAN: "max" });
  expect(k.lines().map((m) => m.setupChanged)).toEqual([
    { kind: "env", names: ["REGION"] },
    { kind: "env", names: ["PLAN", "TIER"] },
    { kind: "env", names: ["PLAN", "REGION"] },
    { kind: "env", names: ["TIER"] },
  ]);
  const [region, two, changed, tier] = k.lines();
  await k.undo(tier);
  await k.undo(changed);
  expect(env()).toEqual({ PLAN: "pro", REGION: "eu", TIER: "2" });
  await k.undo(two);
  expect(env()).toEqual({ REGION: "eu" });
  await k.undo(region);
  expect(env()).toEqual({});
  k.done();
});

test("project_setup refuses a value that looks like a key, a secret a person set, and fleetd's own names; nothing of the call takes", async () => {
  const k = await setupRig();
  const token = `sk-ant-api03-${"a".repeat(48)}`;
  // A payment key by its shape under any name, and an opaque value under a name that usually holds a credential.
  const paid = `sk_live_${"4eC3".repeat(6)}`;
  const keys = [
    { name: "MODEL_KEY", value: token },
    { name: "DB_PASSWORD", value: "hunter2hunter2" },
    { name: "DATABASE_URL", value: "postgres://shop:s3cretpass@db.example/shop" },
    { name: "STRIPE_KEY", value: paid },
    { name: "PAYMENTS", value: paid.replace("sk_live", "rk_test") },
    { name: "SESSION_COOKIE", value: "f3a91c07b2d84e65" },
  ];
  for (const v of keys) {
    const refused = await refusalOf(k.setup({ title: "Storefront", env: { set: [{ name: "REGION", value: "eu" }, v] } }));
    expect([refused.code, refused.message, refused.fix]).toEqual([
      "forbidden",
      `${v.name}'s value looks like a key or a password, and project_setup sets plain variables only.`,
      `Call request_secret for ${v.name}: the person enters it on their own device, and it never passes through you`,
    ]);
  }
  // A secret a person set is theirs: a lead neither overwrites nor removes it.
  const sealed = Buffer.from((await import("../src/shared/sealed_box.ts")).seal(k.hubPub(), Buffer.from("planted-setup-1"))).toString("base64");
  await k.call(k.ownerDevice, "project_env_set", { ...PROJECT, set: [{ kind: "secret", name: "STRIPE", sealed }] });
  for (const env of [{ set: [{ name: "STRIPE", value: "off" }] }, { remove: ["STRIPE"] }]) {
    expect((await refusalOf(k.setup({ env }))).message).toBe(`STRIPE is a secret a person set. ${PEOPLE_ONLY.vault}`);
  }
  expect((await refusalOf(k.setup({ env: { set: [{ name: "FLEETD_HOME", value: "/x" }] } }))).code).toBe("invalid");
  expect((await refusalOf(k.setup({ env: { set: [{ name: "A", value: "1" }], remove: ["A"] } }))).message).toBe("A is both set and removed.");
  expect([k.shop()?.title, projectSettings(k.hub).env(PROJECT).map((v) => [v.name, v.kind]), k.lines()]).toEqual(["Shop", [["STRIPE", "secret"]], []]);
  // Such a name alone refuses nothing: a word, a number and a plain address under it are plain.
  const plainOnes = [{ name: "SORT_KEY", value: "createdAt" }, { name: "SESSION_TTL", value: "3600" }, { name: "AUTH_URL", value: "https://login.example.com" }, { name: "PUBLISHABLE", value: paid.replace("sk_", "pk_") }];
  expect((await k.setup({ env: { set: plainOnes } })).changed).toEqual(["Set 4 variables"]);
  k.done();
});

test("project_setup archives the project, and only a person brings it back", async () => {
  const k = await setupRig();
  const out = await k.setup({ archive: true });
  expect(out.changed).toEqual(["Archived the project"]);
  expect(out.next).toEndWith("The project is archived: say so in one line and end your turn; nothing wakes you until a person brings it back.");
  expect(k.shop()?.archivedAt).toBeDefined();
  expect((await k.setup({ archive: true })).changed).toEqual([]);
  expect((await refusalOf(k.setup({ archive: false }))).message).toBe("archive takes true only: a person brings an archived project back, from the app.");
  expect(await k.undo(k.lines()[0])).toEqual({ ok: true, next: "Its lead starts with the next chat message." });
  expect(k.shop()?.archivedAt).toBeUndefined();
  k.done();
});

test("project_setup checks the whole call before it changes anything, and a failure part-way names what changed", async () => {
  const k = await setupRig();
  const bad: [Record<string, unknown>, string][] = [
    [{}, "project_setup changes nothing as sent."],
    [{ title: "Mine", icon: { face: "wink", color: "teal" }, picture: "logo.png" }, "Give icon or picture, not both: an icon replaces a picture."],
    [{ title: "   " }, "A project's title has at least one letter."],
  ];
  for (const [call, message] of bad) expect((await refusalOf(k.setup(call))).message).toBe(message);
  expect((await refusalOf(k.setup({ title: "Mine", setup: { commands: ["make"], repo: "nope" } }))).code).toBe("not_found");
  // An icon or a color fleetd doesn't draw never passes the call's contract.
  expect((await refusalOf(k.setup({ title: "Mine", icon: { face: "dragon", color: "teal" } }))).code).toBe("invalid");
  expect((await refusalOf(k.setup({ title: "Mine", color: "neon" }))).code).toBe("invalid");
  expect([k.shop()?.title, k.lines()]).toEqual(["Shop", []]);
  // This hub keeps no prompt files, so the instructions fail after the title took: the refusal says so.
  const part = await refusalOf(k.setup({ title: "Mine", instructions: "Ship small." }));
  expect(part.message).toEndWith(" Changed before that, each with its line in the chat: Renamed the project to Mine.");
  expect(k.lines().map((m) => m.text)).toEqual(["Renamed the project to Mine"]);
  k.done();
});

test("project_setup writes and clears the project's Instructions, and Undo restores the text that was there", async () => {
  const { hub, done } = testHub();
  const tools = new Registry();
  registerAll(tools);
  registerLeadCalls(hub);
  const lead: LeadCaller = { projectRef: FILED, by: `lead:${FILED.machineId}/${FILED.projectId}`, agent: { kind: "lead" } };
  const setup = (call: Record<string, unknown>) => Promise.resolve(leadCalls(hub).handler("project_setup")!(lead, { op: "project_setup", ...call } as never)) as Promise<Record<string, any>>;
  const text = () => prompts(hub.db).overrideOf(entryOr(INSTRUCTIONS), FILED)?.text;
  const undo = async (m: ChatMessage | undefined) => tools.call(hub, hubCaller("operate", true), "project_setup_undo", { projectRef: FILED, messageId: m?.messageId });
  expect(text()).toBeUndefined();
  expect((await setup({ instructions: "Ship small PRs.\n" })).changed).toEqual(["Wrote the project's instructions"]);
  expect(text()).toBe("Ship small PRs.\n");
  expect((await setup({ instructions: "Ship small PRs.\n" })).changed).toEqual([]);
  expect((await setup({ instructions: "A person merges.\n" })).changed).toEqual(["Wrote the project's instructions"]);
  expect((await setup({ instructions: "" })).changed).toEqual(["Cleared the project's instructions"]);
  expect(text()).toBeUndefined();
  const [first, second, cleared] = setupLines(hub, FILED);
  expect(await undo(cleared)).toEqual({ output: { ok: true } });
  expect(text()).toBe("A person merges.\n");
  await undo(second);
  expect(text()).toBe("Ship small PRs.\n");
  await undo(first);
  expect(text()).toBeUndefined();
  expect(setupLines(hub, FILED).map((m) => [m.setupChanged?.kind, m.setupChanged?.undone])).toEqual([["instructions", true], ["instructions", true], ["instructions", true]]);
  // An agent's key never undoes.
  await setup({ instructions: "Mine.\n" });
  expect(await tools.call(hub, hubCaller("operate"), "project_setup_undo", { projectRef: FILED, messageId: setupLines(hub, FILED).at(-1)?.messageId })).toMatchObject({
    error: { error: { code: "forbidden" } },
  });
  expect(text()).toBe("Mine.\n");
  done();
});
