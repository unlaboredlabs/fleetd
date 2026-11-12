import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addStep, initialAdd, PROJECT_TOOLS, type AddMsg, type AddState, type HubEvent, type ProfilesListOutput } from "../../desktop";
import { fakeHub } from "../../hub/fake";
import { Session } from "../../session";
import { addCall, deleteProject, discover, FORGET_MS, forgetSignins, readApprovals, readApprovedPage, readForDelete, readInfo, readLinks, REMOVE_MS, removeLink, removePicture, rename, setApprovalMode, setArchived, setBotColor, setMyName, setPicture, setProfile, withPart } from "./api";

const AT = "2026-10-28T10:00:00Z";
const NOW = Date.parse(AT);

const summary = (projectId: string, title: string) => ({
  machineId: "devbox",
  projectId,
  title,
  workspaceRoot: `/home/ada/${projectId}`,
  lastActivityAt: AT,
  threads: { running: 0, waiting: 0, failed: 0, idle: 0 },
});
const ADA = summary("ada", "Ada");
const SHOP = summary("shop", "storefront");
const REF = { machineId: "devbox", projectId: "shop" };

const setup = () => {
  const hub = fakeHub();
  const session = new Session({ hub: "http://devbox:4791", key: "key_abc", transport: hub.transport, now: () => NOW });
  session.start();
  hub.ready();
  hub.link.frame({ t: "snapshot", cursor: 1, attention: [], machines: [], projects: [ADA, SHOP], chats: [] });
  const calls = (tool: string) => hub.sentOf("call").filter((c) => c.tool === tool);
  return { hub, session, calls };
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Rename and Archive", () => {
  it("renames any project by its settings' title", async () => {
    const { hub, session, calls } = setup();
    const renamed = rename(session, ADA, "Ada Lovelace");
    expect(calls("project_settings_set").at(-1)?.input).toEqual({ machineId: "devbox", projectId: "ada", title: "Ada Lovelace" });
    hub.answer("project_settings_set", { settings: {} });
    await expect(renamed).resolves.toEqual({ ok: true, value: null });
  });

  it("gives its bot a color by its settings, and a project keeps it in its summary", async () => {
    const { hub, session, calls } = setup();
    const set = setBotColor(session, SHOP, "sage");
    expect(calls("project_settings_set").at(-1)?.input).toEqual({ ...REF, avatarColor: "sage" });
    hub.answer("project_settings_set", { settings: {} });
    await expect(set).resolves.toEqual({ ok: true, value: null });
    hub.link.frame({ t: "snapshot", cursor: 2, attention: [], machines: [], projects: [ADA, { ...SHOP, avatarColor: "sage" }], chats: [] });
    expect(session.state.projects?.["devbox/shop"]?.avatarColor).toBe("sage");
  });

  it("archives any project and brings it back, by the project's archive tool", async () => {
    const { hub, session, calls } = setup();
    const archived = setArchived(session, SHOP, true);
    expect(calls(PROJECT_TOOLS.archive).at(-1)?.input).toEqual({ ...REF, archived: true });
    hub.answer(PROJECT_TOOLS.archive, { navi: SHOP });
    await expect(archived).resolves.toEqual({ ok: true, value: null });
    void setArchived(session, SHOP, false);
    expect(calls(PROJECT_TOOLS.archive).at(-1)?.input).toEqual({ ...REF, archived: false });
  });
});

describe("A project's screen", () => {
  it("reads what runs, its orders, checklist, last two weeks' merges, profiles, skills and DMs' count side by side", async () => {
    const { hub, session, calls } = setup();
    const info = readInfo(session, SHOP, NOW, { skills: true, dms: true });
    const projectRef = REF;
    expect(calls("agents_list").at(-1)?.input).toEqual({ projectRef });
    expect(calls("checklist_get").at(-1)?.input).toEqual({ projectRef });
    expect(calls("orders_board").at(-1)?.input).toEqual({ projectRef });
    expect(calls("pr_list").at(-1)?.input).toEqual({ projectRef, closedSince: "2026-10-14T10:00:00.000Z" });
    expect(calls("profiles_list").at(-1)?.input).toEqual({ projectRef });
    expect(calls("skills_list").at(-1)?.input).toEqual({ projectRef });
    expect(calls("agent_messages").at(-1)?.input).toEqual({ projectRef, limit: 1 });
    hub.answer("agents_list", { agents: [{ laneId: "l1", role: "lead", status: "working", title: "Lead", projectRef, projectTitle: "storefront" }], at: AT });
    hub.answer("checklist_get", { items: [{ id: 1, state: "todo", text: "Ship it", updatedAt: AT }], projectRef });
    hub.answer("orders_board", { orders: [], trains: [], at: AT });
    hub.fail("pr_list", "github", "GitHub didn't answer.");
    hub.answer("profiles_list", { profiles: [], models: [], efforts: [], modelsFrom: "builtin" });
    hub.answer("skills_list", { skills: [{ name: "weekly-invoices", description: "", origin: "project" }] });
    hub.answer("agent_messages", { messages: [], more: true, total: 8 });
    const got = await info;
    expect(got.agents).toHaveLength(1);
    expect(got.checklist).toHaveLength(1);
    expect(got.orders).toEqual([]);
    expect(got.prs).toBeUndefined();
    expect(got.skills).toMatchObject([{ name: "weekly-invoices" }]);
    expect(got.dms).toBe(8);
    expect(got.error).toMatchObject({ message: "GitHub didn't answer." });
  });

  it("hands each read over as it lands, so what runs shows while pr_list still waits on GitHub", async () => {
    const { hub, session } = setup();
    const parts: object[] = [];
    let done = false;
    void readInfo(session, SHOP, NOW, { skills: false, dms: false }, (got) => parts.push(got)).then(() => (done = true));
    hub.answer("agents_list", { agents: [{ laneId: "T1", role: "implementer", status: "working", title: "Fix it", projectRef: REF, projectTitle: "storefront" }], at: AT });
    await flush();
    expect(parts).toEqual([{ agents: [expect.objectContaining({ laneId: "T1" })] }]);
    hub.fail("orders_board", "failed", "The board didn't read.");
    hub.fail("checklist_get", "failed", "The checklist didn't read.");
    await flush();
    expect(parts.slice(1)).toEqual([{ error: expect.objectContaining({ message: "The board didn't read." }) }, { error: expect.objectContaining({ message: "The checklist didn't read." }) }]);
    expect(done).toBe(false);
    hub.answer("profiles_list", { profiles: [], models: [], efforts: [], modelsFrom: "builtin" });
    hub.answer("pr_list", { prs: [] });
    await flush();
    expect(done).toBe(true);
  });

  it("keeps the first failure, and each section the read that brought it", () => {
    const first = { message: "first" } as never;
    expect(withPart({ agents: [], error: first }, { orders: [], error: { message: "second" } as never })).toEqual({ agents: [], orders: [], error: first });
    expect(withPart({ agents: [], checklist: [] }, { agents: [], error: first })).toEqual({ agents: [], checklist: [], error: first });
  });

  it("leaves its skills and DMs out on a hub that doesn't keep them", () => {
    const { session, calls } = setup();
    void readInfo(session, SHOP, NOW, { skills: false, dms: false });
    expect(calls("agents_list")).toHaveLength(1);
    expect(calls("skills_list")).toEqual([]);
    expect(calls("agent_messages")).toEqual([]);
  });

  it("checks a profile for its agents, keeping the others and leaving the default out", async () => {
    const { hub, session, calls } = setup();
    const view = {
      profiles: [
        { id: 1, name: "high", default: true, note: "", model: "m", effort: "high" as const, fast: false, updatedAt: AT },
        { id: 2, name: "max", default: false, note: "", model: "m", effort: "max" as const, fast: false, updatedAt: AT },
        { id: 3, name: "quick", default: false, note: "", model: "m", effort: "low" as const, fast: false, updatedAt: AT },
      ],
      allowed: ["high", "quick"],
      models: [],
      efforts: [],
      modelsFrom: "builtin",
    } as unknown as ProfilesListOutput;
    const on = setProfile(session, REF, view, "max", true);
    expect(calls("project_set").at(-1)?.input).toEqual({ ...REF, profiles: ["max", "quick"] });
    hub.answer("project_set", { profiles: ["high", "max", "quick"] });
    await expect(on).resolves.toEqual({ ok: true, value: ["high", "max", "quick"] });
    void setProfile(session, REF, view, "quick", false);
    expect(calls("project_set").at(-1)?.input).toEqual({ ...REF, profiles: [] });
  });
});

describe("Forget sign-ins and Delete", () => {
  it("forgets its sign-ins, waiting as long as ending its browser takes", async () => {
    const { hub, session, calls } = setup();
    const call = vi.spyOn(session, "call");
    const forgot = forgetSignins(session, SHOP);
    expect(calls(PROJECT_TOOLS.signinsForget).at(-1)?.input).toEqual(REF);
    expect(call).toHaveBeenLastCalledWith(PROJECT_TOOLS.signinsForget, REF, FORGET_MS);
    hub.answer(PROJECT_TOOLS.signinsForget, { ok: true });
    await expect(forgot).resolves.toEqual({ ok: true, value: null });
  });

  it("reads its worktrees fresh, then deletes it with them", async () => {
    const { hub, session, calls } = setup();
    const read = readForDelete(session, SHOP);
    expect(calls("project_settings_get").at(-1)?.input).toEqual(REF);
    hub.answer("project_settings_get", { settings: { title: "storefront" } });
    await expect(read).resolves.toMatchObject({ ok: true, value: { title: "storefront" } });

    const call = vi.spyOn(session, "call");
    const gone = deleteProject(session, SHOP);
    expect(calls("project_remove").at(-1)?.input).toEqual({ ...REF, removeWorktrees: true });
    expect(call).toHaveBeenLastCalledWith("project_remove", { ...REF, removeWorktrees: true }, REMOVE_MS);
    hub.answer("project_remove", { ok: true });
    await expect(gone).resolves.toEqual({ ok: true, value: null });
    // Its folder, ticked, goes too.
    void deleteProject(session, SHOP, true);
    expect(calls("project_remove").at(-1)?.input).toEqual({ ...REF, removeWorktrees: true, removeFolder: true });
  });

  it("says why a delete was refused", async () => {
    const { hub, session } = setup();
    const gone = deleteProject(session, SHOP);
    hub.fail("project_remove", "machine_offline", "devbox is offline.");
    await expect(gone).resolves.toMatchObject({ ok: false, error: { code: "machine_offline" } });
  });
});

describe("New Project", () => {
  it("lists what the hub found, machine ids as names", async () => {
    const { hub, session } = setup();
    const found = discover(session, (id) => (id === "devbox" ? "Dev Box" : id));
    hub.answer("project_discover", {
      best: "devbox",
      machines: [{ machineId: "devbox", online: true, cloneRoot: "/home/ada/src", repos: [{ name: "api", path: "/home/ada/src/api", repo: "acme/api" }] }],
      github: { owners: ["acme"], repos: [{ repo: "acme/web", url: "https://github.com/acme/web", private: true, checkouts: [] }] },
    });
    const r = await found;
    expect(r.ok && r.value.workers).toEqual([{ machineId: "devbox", name: "Dev Box", online: true, cloneRoot: "/home/ada/src" }]);
    expect(r.ok && r.value.found.map((f) => f.name)).toEqual(["api", "acme/web"]);
  });

  it("clones with the name typed, then follows the clone's events to ready", async () => {
    const { hub, session, calls } = setup();
    let s: AddState = { ...initialAdd, live: true };
    const send = (msg: AddMsg) => {
      const [next, out] = addStep(s, msg, (id) => id);
      s = next;
      for (const call of out) void addCall(session, call, "Web").then((outcome) => send({ t: "answer", call, outcome }));
    };
    const off = session.onEvent((event: HubEvent) => send({ t: "event", event }));
    send({ t: "start", request: { kind: "clone", repo: "acme/web", machineId: "devbox", useExisting: false }, path: "" });
    expect(calls("project_add").at(-1)?.input).toEqual({ machineId: "devbox", url: "acme/web", title: "Web" });
    hub.answer("project_add", { addId: "a1", created: false, machineId: "devbox", path: "/home/ada/src/web" });
    await flush();
    hub.link.frame({ t: "event", seq: 2, type: "project.clone_progress", at: AT, data: { addId: "a1", phase: "receiving", percent: 40 } });
    expect(s.phase).toMatchObject({ kind: "working", job: { detail: "Receiving objects 40%", fraction: 0.4 } });
    hub.link.frame({
      t: "event",
      seq: 3,
      type: "project.added",
      at: AT,
      machineId: "devbox",
      projectId: "web",
      data: {
        addId: "a1",
        title: "Web",
        path: "/home/ada/src/web",
        inspect: { repo: "acme/web", defaultBranch: "main", ci: { workflows: ["ci"], requiredChecks: [] }, merge: { protected: false, rulesets: [], squashAllowed: true }, leadNeeds: "required checks", notes: [] },
      },
    });
    expect(s.phase).toMatchObject({ kind: "ready", ready: { title: "Web", project: { machineId: "devbox", projectId: "web" } } });
    off();
  });

  it("adds a folder as it is, unnamed when no name is typed", () => {
    const { session, calls } = setup();
    void addCall(session, { purpose: "add", gen: 1, input: { machineId: "devbox", path: "~/src/api" } }, "");
    expect(calls("project_add").at(-1)?.input).toEqual({ machineId: "devbox", path: "~/src/api" });
    // A dry run that inspects a clone's folder is never named.
    void addCall(session, { purpose: "inspect", gen: 1, input: { machineId: "devbox", url: "acme/web", dryRun: true } }, "Web");
    expect(calls("project_add").at(-1)?.input).toEqual({ machineId: "devbox", url: "acme/web", dryRun: true });
  });

  it("makes a new folder of its own", async () => {
    const { hub, session, calls } = setup();
    let s: AddState = { ...initialAdd, live: true };
    const send = (msg: AddMsg) => {
      const [next, out] = addStep(s, msg, (id) => id);
      s = next;
      for (const call of out) void addCall(session, call, "Ada").then((outcome) => send({ t: "answer", call, outcome }));
    };
    const off = session.onEvent((event: HubEvent) => send({ t: "event", event }));
    send({ t: "start", request: { kind: "new", machineId: "devbox", name: "Ada", path: "/home/ada/projects/ada", gitInit: false }, path: "/home/ada/projects/ada" });
    expect(calls("project_add").at(-1)?.input).toEqual({ machineId: "devbox", path: "/home/ada/projects/ada", title: "Ada", create: true });
    hub.answer("project_add", { addId: "a2", created: true, machineId: "devbox", path: "/home/ada/projects/ada" });
    await flush();
    hub.link.frame({
      t: "event",
      seq: 2,
      type: "project.added",
      at: AT,
      machineId: "devbox",
      projectId: "ada2",
      data: {
        addId: "a2",
        title: "Ada",
        path: "/home/ada/projects/ada",
        inspect: { defaultBranch: "main", ci: { workflows: [], requiredChecks: [] }, merge: { protected: false, rulesets: [], squashAllowed: false }, leadNeeds: "", notes: [] },
      },
    });
    expect(s.phase).toMatchObject({ kind: "ready", ready: { project: { machineId: "devbox", projectId: "ada2" } } });
    off();
  });
});

describe("Session", () => {
  it("reads who this phone's person is", async () => {
    const { hub, session } = setup();
    hub.answer("hub_info", { busy: [], protocol: 1, version: "0.9.0", me: { personId: "p_ada", name: "Ada", role: "member", createdAt: AT } });
    await flush();
    expect(session.state.me).toBe("p_ada");
    expect(session.state.admin).toBe(false);
  });
});

describe("Its picture", () => {
  it("sends the photo as picked, then names the square to keep", async () => {
    const { hub, session, calls } = setup();
    const crop = { x: 500, y: 0, size: 3000 };
    const set = setPicture(session, SHOP, new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg", crop);
    expect(calls("attachment_put").at(-1)?.input).toEqual({ name: "picture.jpg", mime: "image/jpeg", dataB64: "/9j/" });
    hub.answer("attachment_put", { attachmentId: "F7", bytes: 3, sha256: "x".repeat(64) });
    await flush();
    expect(calls("project_avatar_set").at(-1)?.input).toEqual({ ...REF, attachmentId: "F7", crop });
    const shown = { ...SHOP, avatar: "a1b2c3d4e5f60718" };
    hub.answer("project_avatar_set", { project: shown });
    await expect(set).resolves.toEqual({ ok: true, value: shown });
  });

  it("says why the hub wouldn't take it, and removes it with no attachment", async () => {
    const { hub, session, calls } = setup();
    const set = setPicture(session, ADA, new Uint8Array([1]), "image/png", { x: 0, y: 0, size: 1 });
    hub.fail("attachment_put", "invalid", "The file is too big.");
    await expect(set).resolves.toMatchObject({ ok: false, error: { message: "The file is too big." } });
    expect(calls("project_avatar_set")).toEqual([]);

    const removed = removePicture(session, SHOP);
    expect(calls("project_avatar_set").at(-1)?.input).toEqual(REF);
    hub.answer("project_avatar_set", { project: SHOP });
    await expect(removed).resolves.toEqual({ ok: true, value: SHOP });
  });
});

describe("Your name", () => {
  it("sends the name as typed, and gives back the one the hub kept", async () => {
    const { hub, session, calls } = setup();
    const set = setMyName(session, "  Ada Lovelace ");
    expect(calls("person_name_set").at(-1)?.input).toEqual({ name: "  Ada Lovelace " });
    hub.answer("person_name_set", { person: { personId: "p_ada", name: "Ada Lovelace", role: "member", createdAt: AT } });
    await expect(set).resolves.toEqual({ ok: true, value: "Ada Lovelace" });
  });

  it("gives back the hub's refusal of an empty one, in its words", async () => {
    const { hub, session, calls } = setup();
    const set = setMyName(session, "");
    expect(calls("person_name_set").at(-1)?.input).toEqual({ name: "" });
    hub.fail("person_name_set", "invalid", "The name is empty.");
    await expect(set).resolves.toMatchObject({ ok: false, error: { code: "invalid", message: "The name is empty." } });
  });
});

describe("Approvals and Linked hubs", () => {
  const approvals = { mode: "checker" as const, model: "claude-opus-5-5", effort: "high" as const, defaults: true };

  it("reads its approvals, and nothing about the checker's model", async () => {
    const { hub, session, calls } = setup();
    const read = readApprovals(session, SHOP);
    // Only the newest page: the screen shows the newest few, and the rest in pages on its own screen (W601).
    expect(calls(PROJECT_TOOLS.approvals).at(-1)?.input).toEqual({ ...REF, limit: 25 });
    expect(calls("profiles_list")).toEqual([]);
    hub.answer(PROJECT_TOOLS.approvals, { approvals, log: [] });
    await expect(read).resolves.toMatchObject({ ok: true, value: { approvals: { mode: "checker" }, log: [] } });
  });

  it("picks a mode, and only the mode", () => {
    const { session, calls } = setup();
    void setApprovalMode(session, SHOP, "ask");
    expect(calls(PROJECT_TOOLS.approvalsSet).at(-1)?.input).toEqual({ ...REF, mode: "ask" });
  });

  it("reads what ran without asking in pages, each older one from the last one's cursor", async () => {
    const { hub, session, calls } = setup();
    const entry = { at: AT, by: "yolo" as const, tool: "WebFetch", what: "Fetch `a.example`" };
    const first = readApprovedPage(session, SHOP);
    expect(calls(PROJECT_TOOLS.approvals).at(-1)?.input).toEqual({ ...REF, limit: 50 });
    hub.answer(PROJECT_TOOLS.approvals, { approvals, log: [entry], older: 51, total: 120 });
    await expect(first).resolves.toEqual({ ok: true, value: { log: [entry], older: 51 } });
    const next = readApprovedPage(session, SHOP, 51);
    expect(calls(PROJECT_TOOLS.approvals).at(-1)?.input).toEqual({ ...REF, limit: 50, before: 51 });
    hub.answer(PROJECT_TOOLS.approvals, { approvals, log: [entry] });
    await expect(next).resolves.toEqual({ ok: true, value: { log: [entry], older: undefined } });
  });

  it("lists only its own hub links, and removes one", async () => {
    const { hub, session, calls } = setup();
    const read = readLinks(session, SHOP);
    expect(calls("hub_links_get").at(-1)?.input).toEqual({ navi: REF });
    const link = (linkId: string, navi: typeof REF) => ({ linkId, label: "Acme", url: "https://acme.example", state: "ok", createdAt: AT, navi });
    hub.answer("hub_links_get", { boxPubKey: "k", issued: [], links: [link("hl_1", REF), link("hl_2", { machineId: "devbox", projectId: "ada" })] });
    await expect(read).resolves.toMatchObject({ ok: true, value: [{ linkId: "hl_1" }] });
    const removed = removeLink(session, "hl_1");
    expect(calls("hub_link_remove").at(-1)?.input).toEqual({ linkId: "hl_1" });
    hub.answer("hub_link_remove", { revokedThere: true });
    await expect(removed).resolves.toEqual({ ok: true, value: { revokedThere: true } });
  });
});
