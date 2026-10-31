import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addStep, initialAdd, type AddMsg, type AddState, type HubEvent, type ProfilesListOutput } from "../../desktop";
import { fakeHub } from "../../hub/fake";
import { Session } from "../../session";
import { addCall, createNavi, deleteProject, discover, FORGET_MS, forgetSignins, naviHomes, readForDelete, readInfo, REMOVE_MS, removePicture, rename, setIcon, setPicture, setProfile } from "./api";

const AT = "2026-10-28T10:00:00Z";
const NOW = Date.parse(AT);

const summary = (projectId: string, title: string, kind?: "assistant") => ({
  machineId: "devbox",
  projectId,
  title,
  workspaceRoot: `/home/ada/${projectId}`,
  lastActivityAt: AT,
  threads: { running: 0, waiting: 0, failed: 0, idle: 0 },
  ...(kind === undefined ? {} : { kind }),
});
const NAVI = summary("ada", "Ada", "assistant");
const SHOP = summary("shop", "storefront");
const REF = { machineId: "devbox", projectId: "shop" };

const setup = () => {
  const hub = fakeHub();
  const session = new Session({ hub: "http://devbox:4791", key: "key_abc", transport: hub.transport, now: () => NOW });
  session.start();
  hub.ready();
  hub.link.frame({ t: "snapshot", cursor: 1, attention: [], machines: [], projects: [NAVI, SHOP], chats: [] });
  const calls = (tool: string) => hub.sentOf("call").filter((c) => c.tool === tool);
  return { hub, session, calls };
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("New Navi", () => {
  it("makes it on the machine picked, or leaves the pick to the hub", async () => {
    const { hub, session, calls } = setup();
    const made = createNavi(session, "Ada", "devbox");
    expect(calls("navi_create").at(-1)?.input).toEqual({ name: "Ada", machineId: "devbox" });
    hub.answer("navi_create", { navi: NAVI });
    await expect(made).resolves.toEqual({ ok: true, value: NAVI });

    void createNavi(session, "Home", undefined);
    expect(calls("navi_create").at(-1)?.input).toEqual({ name: "Home" });
  });

  it("says the hub's refusal", async () => {
    const { hub, session } = setup();
    const made = createNavi(session, "Ada", undefined);
    hub.fail("navi_create", "forbidden", "This key can't operate devbox.");
    await expect(made).resolves.toMatchObject({ ok: false, error: { code: "forbidden", message: "This key can't operate devbox." } });
  });

  it("lists where it may live, and nothing from a hub without machine_roles", async () => {
    const { hub, session } = setup();
    const homes = naviHomes(session);
    hub.answer("machine_roles", { best: "devbox", machines: [{ machineId: "devbox", name: "devbox", online: true }] });
    await expect(homes).resolves.toMatchObject({ best: "devbox", machines: [{ machineId: "devbox" }] });
    const old = naviHomes(session);
    hub.fail("machine_roles", "unknown_tool", "No such tool.");
    await expect(old).resolves.toEqual({ machines: [] });
  });
});

describe("Rename", () => {
  it("renames a Navi with navi_rename and a project with its settings' title", async () => {
    const { hub, session, calls } = setup();
    const navi = rename(session, NAVI, "Ada Lovelace");
    expect(calls("navi_rename").at(-1)?.input).toEqual({ machineId: "devbox", projectId: "ada", name: "Ada Lovelace" });
    hub.answer("navi_rename", { navi: NAVI });
    await expect(navi).resolves.toEqual({ ok: true, value: null });

    const project = rename(session, SHOP, "Shop");
    expect(calls("project_settings_set").at(-1)?.input).toEqual({ machineId: "devbox", projectId: "shop", title: "Shop" });
    hub.answer("project_settings_set", { settings: {} });
    await expect(project).resolves.toEqual({ ok: true, value: null });
    expect(calls("navi_rename")).toHaveLength(1);
  });
});

describe("A project's screen", () => {
  it("reads what runs, its orders, checklist, last two weeks' merges and profiles side by side", async () => {
    const { hub, session, calls } = setup();
    const info = readInfo(session, SHOP, NOW);
    const projectRef = REF;
    expect(calls("agents_list").at(-1)?.input).toEqual({ projectRef });
    expect(calls("checklist_get").at(-1)?.input).toEqual({ projectRef });
    expect(calls("orders_board").at(-1)?.input).toEqual({ projectRef });
    expect(calls("pr_list").at(-1)?.input).toEqual({ projectRef, closedSince: "2026-10-14T10:00:00.000Z" });
    expect(calls("profiles_list").at(-1)?.input).toEqual({ projectRef });
    hub.answer("agents_list", { agents: [{ laneId: "l1", role: "lead", status: "working", title: "Lead", projectRef, projectTitle: "storefront" }], at: AT });
    hub.answer("checklist_get", { items: [{ id: 1, state: "todo", text: "Ship it", updatedAt: AT }], projectRef });
    hub.answer("orders_board", { orders: [], trains: [], at: AT });
    hub.fail("pr_list", "github", "GitHub didn't answer.");
    hub.answer("profiles_list", { profiles: [], models: [], efforts: [], modelsFrom: "builtin" });
    const got = await info;
    expect(got.agents).toHaveLength(1);
    expect(got.checklist).toHaveLength(1);
    expect(got.orders).toEqual([]);
    expect(got.prs).toBeUndefined();
    expect(got.error).toMatchObject({ message: "GitHub didn't answer." });
  });

  it("reads a Navi's agents, checklist and skills only", async () => {
    const { hub, session, calls } = setup();
    const info = readInfo(session, NAVI, NOW);
    expect(calls("agents_list")).toHaveLength(1);
    expect(calls("checklist_get")).toHaveLength(1);
    expect(calls("skills_list").at(-1)?.input).toEqual({ projectRef: { machineId: "devbox", projectId: "ada" } });
    expect([...calls("orders_board"), ...calls("pr_list"), ...calls("profiles_list")]).toEqual([]);
    hub.answer("agents_list", { agents: [], at: AT });
    hub.answer("checklist_get", { items: [], projectRef: { machineId: "devbox", projectId: "ada" } });
    hub.answer("skills_list", { skills: [{ name: "weekly-invoices", description: "", origin: "project" }] });
    await expect(info).resolves.toMatchObject({ skills: [{ name: "weekly-invoices" }] });
  });

  it("leaves a project's skills to the desktop", () => {
    const { session, calls } = setup();
    void readInfo(session, SHOP, NOW);
    expect(calls("skills_list")).toEqual([]);
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
  it("forgets a Navi's sign-ins, waiting as long as ending its browser takes", async () => {
    const { hub, session, calls } = setup();
    const call = vi.spyOn(session, "call");
    const forgot = forgetSignins(session, NAVI);
    expect(calls("navi_signins_forget").at(-1)?.input).toEqual({ machineId: "devbox", projectId: "ada" });
    expect(call).toHaveBeenLastCalledWith("navi_signins_forget", { machineId: "devbox", projectId: "ada" }, FORGET_MS);
    hub.answer("navi_signins_forget", { ok: true });
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
});

describe("Session", () => {
  it("reads who this phone's person is, whose Navis are theirs", async () => {
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
    const set = setPicture(session, NAVI, new Uint8Array([1]), "image/png", { x: 0, y: 0, size: 1 });
    hub.fail("attachment_put", "invalid", "The file is too big.");
    await expect(set).resolves.toMatchObject({ ok: false, error: { message: "The file is too big." } });
    expect(calls("project_avatar_set")).toEqual([]);

    const removed = removePicture(session, SHOP);
    expect(calls("project_avatar_set").at(-1)?.input).toEqual(REF);
    hub.answer("project_avatar_set", { project: SHOP });
    await expect(removed).resolves.toEqual({ ok: true, value: SHOP });
  });

  it("sends a face and color picked, and says why the hub wouldn't take it", async () => {
    const { hub, session, calls } = setup();
    const icon = { face: "wink", color: "sun" } as const;
    const set = setIcon(session, NAVI, icon);
    expect(calls("project_icon_set").at(-1)?.input).toEqual({ machineId: NAVI.machineId, projectId: NAVI.projectId, icon });
    const shown = { ...NAVI, icon };
    hub.answer("project_icon_set", { project: shown });
    await expect(set).resolves.toEqual({ ok: true, value: shown });

    const refused = setIcon(session, SHOP, icon);
    hub.fail("project_icon_set", "forbidden", "Only its owner can change it.");
    await expect(refused).resolves.toMatchObject({ ok: false, error: { message: "Only its owner can change it." } });
  });
});
