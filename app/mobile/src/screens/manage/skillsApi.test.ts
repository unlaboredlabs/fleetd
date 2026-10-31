import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubEvent } from "../../desktop";
import { fakeHub } from "../../hub/fake";
import { Session } from "../../session";
import { deleteSkill, listSkills, readSkill, readSkillView, restoreSkill, saveSkill, touchesSkills, turnSkillOff } from "./skillsApi";

const AT = "2026-10-31T10:00:00Z";
const REF = { machineId: "devbox", projectId: "nova" };
const NOVA = { ...REF, title: "Nova", kind: "assistant", workspaceRoot: "/home/ada/.fleetd/navi/nova", lastActivityAt: AT, threads: { running: 0, waiting: 0, failed: 0, idle: 0 } };
const SKILL = { name: "weekly-invoices", description: "Sends the week's invoices", origin: "project" };
const V2 = { version: 2, author: "agent", by: "Nova", at: AT, why: "Learned the export step" };

const setup = () => {
  const hub = fakeHub();
  const session = new Session({ hub: "http://devbox:4791", key: "key_abc", transport: hub.transport, now: () => Date.parse(AT) });
  session.start();
  hub.ready();
  hub.link.frame({ t: "snapshot", cursor: 1, attention: [], machines: [], projects: [NOVA], chats: [] });
  const last = (tool: string) => hub.sentOf("call").filter((c) => c.tool === tool).at(-1)?.input;
  return { hub, session, last };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a Navi's skills", () => {
  it("lists them for the Navi alone", async () => {
    const { hub, session, last } = setup();
    const listed = listSkills(session, REF);
    expect(last("skills_list")).toEqual({ projectRef: REF });
    hub.answer("skills_list", { skills: [{ ...SKILL, changed: V2, lastUsedAt: AT }] });
    await expect(listed).resolves.toEqual({ ok: true, value: [{ ...SKILL, changed: V2, lastUsedAt: AT }] });
  });

  it("reads one with its versions, and an older version's text", async () => {
    const { hub, session, last } = setup();
    const current = readSkill(session, REF, "project", "weekly-invoices");
    expect(last("skill_get")).toEqual({ origin: "project", projectRef: REF, name: "weekly-invoices" });
    hub.answer("skill_get", { skill: SKILL, text: "v2 text", versions: [V2, { ...V2, version: 1 }] });
    await expect(current).resolves.toMatchObject({ ok: true, value: { text: "v2 text", versions: [{ version: 2 }, { version: 1 }] } });

    const older = readSkill(session, REF, "project", "weekly-invoices", 1);
    expect(last("skill_get")).toEqual({ origin: "project", projectRef: REF, name: "weekly-invoices", version: 1 });
    hub.answer("skill_get", { skill: SKILL, text: "v1 text" });
    await expect(older).resolves.toMatchObject({ ok: true, value: { text: "v1 text", versions: [] } });
  });

  it("reads a skill's view with whether it is off, its last use and its rival from its list row, which skill_get leaves out", async () => {
    const { hub, session, last } = setup();
    const view = readSkillView(session, REF, "project", "weekly-invoices");
    expect(last("skill_get")).toEqual({ origin: "project", projectRef: REF, name: "weekly-invoices" });
    expect(last("skills_list")).toEqual({ projectRef: REF });
    hub.answer("skill_get", { skill: SKILL, text: "v2 text", versions: [V2] });
    hub.answer("skills_list", { skills: [{ ...SKILL, origin: "global", off: false }, { ...SKILL, off: true, lastUsedAt: AT, shadowedBy: "repo_agents" }] });
    await expect(view).resolves.toEqual({ ok: true, value: { skill: { ...SKILL, off: true, lastUsedAt: AT, shadowedBy: "repo_agents" }, text: "v2 text", versions: [V2] } });
  });

  it("reads a skill's view as on when the list doesn't name it", async () => {
    const { hub, session } = setup();
    const view = readSkillView(session, REF, "project", "weekly-invoices");
    hub.answer("skill_get", { skill: { ...SKILL, off: true }, text: "t", versions: [] });
    hub.fail("skills_list", "machine_offline", "devbox is offline.");
    await expect(view).resolves.toEqual({ ok: true, value: { skill: SKILL, text: "t", versions: [] } });
  });

  it("saves the person's edit with their why, and without an empty one", async () => {
    const { hub, session, last } = setup();
    const saved = saveSkill(session, REF, "weekly-invoices", "new text", "  Use PDF  ");
    expect(last("skill_set")).toEqual({ scope: "project", projectRef: REF, name: "weekly-invoices", text: "new text", why: "Use PDF" });
    hub.answer("skill_set", { skill: SKILL });
    await expect(saved).resolves.toEqual({ ok: true, value: SKILL });

    void saveSkill(session, REF, "weekly-invoices", "new text", " ");
    expect(last("skill_set")).toEqual({ scope: "project", projectRef: REF, name: "weekly-invoices", text: "new text" });
  });

  it("restores a version, turns one off and deletes one", async () => {
    const { hub, session, last } = setup();
    const restored = restoreSkill(session, REF, "weekly-invoices", 1);
    expect(last("skill_revert")).toEqual({ scope: "project", projectRef: REF, name: "weekly-invoices", version: 1 });
    hub.answer("skill_revert", { skill: SKILL });
    await expect(restored).resolves.toEqual({ ok: true, value: SKILL });

    const off = turnSkillOff(session, REF, "weekly-invoices", true);
    expect(last("skill_off")).toEqual({ projectRef: REF, name: "weekly-invoices", off: true });
    hub.answer("skill_off", { ok: true });
    await expect(off).resolves.toEqual({ ok: true, value: null });

    const gone = deleteSkill(session, REF, "weekly-invoices");
    expect(last("skill_delete")).toEqual({ scope: "project", projectRef: REF, name: "weekly-invoices" });
    hub.fail("skill_delete", "forbidden", "Only Nova's owner can change its skills.");
    await expect(gone).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("reads again on a change to this Navi's skills or a hub-wide one, not another's", () => {
    const event = (data: unknown): HubEvent => ({ type: "skills.changed", at: AT, data }) as HubEvent;
    expect(touchesSkills(event({ scope: "project", projectRef: REF, names: ["a"] }), REF)).toBe(true);
    expect(touchesSkills(event({ scope: "global", names: ["a"] }), REF)).toBe(true);
    expect(touchesSkills(event({ scope: "project", projectRef: { machineId: "devbox", projectId: "ada" } }), REF)).toBe(false);
    expect(touchesSkills({ type: "chat.message", at: AT } as HubEvent, REF)).toBe(false);
  });
});
