import { describe, expect, it } from "vitest";
import type { AgentRow, OrderCard, PrRow, ProfilesListOutput, ProjectSettings, ProjectSummary, TodoItem } from "../../desktop";
import { deleteWords as desktopDeleteWords } from "../../desktop";
import { machineName, offFooter } from "./model";
import { agentLines, checklist, createRefusal, deleteBlocked, deleteConfirmed, deleteWords, merges, leadLines, leadSections, leadValue, LEAD_HUB, orderLines, profileLines, profilesValue, NOT_CONNECTED, refusalNow, subtitle } from "./model";

const AT = "2026-10-28T10:00:00Z";

const project = (extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  machineId: "devbox",
  projectId: "shop",
  title: "storefront",
  workspaceRoot: "/home/ada/src/shop",
  lastActivityAt: AT,
  threads: { running: 0, waiting: 0, failed: 0, idle: 0 },
  ...extra,
});
const own = (extra: Partial<ProjectSummary> = {}) => project({ projectId: "ada", title: "Ada", workspaceRoot: "/home/ada/.fleetd/inbox/ada", ...extra });

const settings = (extra: Partial<ProjectSettings> = {}): ProjectSettings => ({
  machineId: "devbox",
  projectId: "shop",
  title: "storefront",
  workspaceRoot: "/home/ada/src/shop",
  env: [],
  setup: { commands: [] } as unknown as ProjectSettings["setup"],
  worktrees: { dir: "/home/ada/.fleetd/worktrees/shop", worktrees: [] },
  ...extra,
});

describe("its screen", () => {
  it("says where it lives under its name", () => {
    expect(subtitle(project(), "Dev Box")).toBe("Bot on Dev Box");
    const repo = (name: string) => ({ repoId: name, name, checkout: { machineId: "devbox", projectId: name } });
    expect(subtitle(project({ repos: [repo("shop"), repo("api")] }), "Dev Box")).toBe("2 repos on Dev Box");
    expect(subtitle(own(), "Dev Box")).toBe("Bot on Dev Box");
  });

  const agent = (laneId: string, role: AgentRow["role"], status: AgentRow["status"], extra: Partial<AgentRow> = {}): AgentRow => ({
    laneId,
    role,
    status,
    title: `Task ${laneId}`,
    projectRef: { machineId: "devbox", projectId: "shop" },
    projectTitle: "storefront",
    ...extra,
  });

  it("lists what runs, the lead first, ended ones left out", () => {
    const lines = agentLines([
      agent("a", "implementer", "working", { profile: "max" }),
      agent("b", "reviewer", "done"),
      agent("lead", "lead", "idle", { profile: "high" }),
      agent("c", "reader", "parked", { statusReason: "until 14:00" }),
    ]);
    expect(lines).toEqual([
      { id: "lead", title: "Lead", role: "high", status: "Idle", tone: "quiet" },
      { id: "a", title: "Task a", role: "Writer · max", status: "Working", tone: "accent" },
      { id: "c", title: "Task c", role: "Reader", status: "Paused at the usage limit: until 14:00", tone: "warning" },
    ]);
  });

  const order = (id: string, phase: OrderCard["phase"], updatedAt: string, extra: Partial<OrderCard> = {}): OrderCard => ({
    workstreamId: id,
    title: `Order ${id}`,
    phase,
    state: "open",
    createdAt: AT,
    updatedAt,
    lanes: [],
    needsYou: 0,
    prs: [],
    settled: 0,
    total: 1,
    projectRef: { machineId: "devbox", projectId: "shop" },
    ...extra,
  });

  it("lists open orders, what needs you first, then the newest", () => {
    const lines = orderLines([
      order("old", "working", "2026-10-27T10:00:00Z", { settled: 1, total: 3 }),
      order("new", "reviewing", "2026-10-28T09:00:00Z"),
      order("you", "waiting_on_you", "2026-10-26T10:00:00Z"),
      order("done", "done", "2026-10-28T10:00:00Z", { state: "done" }),
    ]);
    expect(lines.map((l) => [l.id, l.phase, l.progress])).toEqual([
      ["you", "Needs you", undefined],
      ["new", "In review", undefined],
      ["old", "Working", "1 of 3"],
    ]);
  });

  it("shows its newest merges only", () => {
    const pr = (number: number, state: string, mergedAt?: string): PrRow =>
      ({ number, state, title: `PR ${String(number)}`, repo: "acme/shop", url: `https://github.com/acme/shop/pull/${String(number)}`, createdAt: AT, updatedAt: AT, ...(mergedAt === undefined ? {} : { mergedAt }) }) as PrRow;
    const rows = merges([pr(1, "merged", "2026-10-20T00:00:00Z"), pr(2, "open"), pr(3, "merged", "2026-10-27T00:00:00Z"), pr(4, "closed"), ...[5, 6, 7, 8, 9].map((n) => pr(n, "merged", `2026-10-0${String(n)}T00:00:00Z`))]);
    expect(rows.map((r) => r.number)).toEqual([3, 1, 9, 8, 7]);
  });

  it("lists its checklist, what's being done first, and counts the rest", () => {
    const item = (id: number, state: TodoItem["state"]): TodoItem => ({ id, state, text: `Item ${String(id)}`, updatedAt: AT });
    const c = checklist([item(1, "done"), item(2, "todo"), item(3, "doing"), ...[4, 5, 6, 7, 8, 9].map((n) => item(n, "todo"))]);
    expect(c.items.map((i) => i.id)).toEqual([3, 2, 4, 5, 6, 7, 8, 9]);
    expect(c.summary).toBe("1 of 9 done");
    expect(c.more).toBe(1);
    expect(checklist([])).toEqual({ items: [], more: 0 });
  });

  it("checks the default profile always, and the ones it allows", () => {
    const view = {
      profiles: [
        { id: 1, name: "high", default: true, note: "Most work." },
        { id: 2, name: "max", default: false, note: "" },
        { id: 3, name: "quick", default: false, note: "Small fixes." },
      ],
      allowed: ["high", "quick"],
    } as unknown as ProfilesListOutput;
    expect(profileLines(view)).toEqual([
      { name: "high", note: "Always allowed. Most work.", checked: true, fixed: true },
      { name: "max", note: "", checked: false, fixed: false },
      { name: "quick", note: "Small fixes.", checked: true, fixed: false },
    ]);
    expect(profilesValue(view)).toBe("high, quick");
  });

  it("lists its lead's model: the hub's lead profile first, then the hub's profiles, one claude refused not to pick", () => {
    const view = {
      profiles: [
        { id: 1, name: "high", default: true, note: "", model: "claude-opus-5-5" },
        { id: 2, name: "max", default: false, lead: true, note: "", model: "claude-opus-5-5" },
        { id: 3, name: "quick", default: false, note: "", model: "claude-haiku-5-5", refused: "claude refused claude-haiku-5-5" },
      ],
      models: [],
      allowed: ["high"],
    } as unknown as ProfilesListOutput;
    expect(leadLines(view)).toEqual([
      { value: LEAD_HUB, title: "Hub default (max)", checked: true, disabled: false },
      { value: "high", title: "high", checked: false, disabled: false, group: "Anthropic" },
      { value: "max", title: "max", checked: false, disabled: false, group: "Anthropic" },
      { value: "quick", title: "quick", checked: false, disabled: true, why: "claude refused claude-haiku-5-5", group: "Anthropic" },
    ]);
    expect(leadValue(view)).toBe("Hub default");
    const own = { ...view, leadProfile: "high" };
    expect(leadLines(own).filter((l) => l.checked).map((l) => l.value)).toEqual(["high"]);
    expect(leadValue(own)).toBe("high");
  });

  it("lists its lead's model by provider: Google's profiles under Google, and for an admin each Gemini model no profile runs on", () => {
    const view = {
      profiles: [
        { id: 1, name: "high", default: true, note: "", model: "claude-opus-5-5" },
        { id: 2, name: "gemini", default: false, note: "", model: "gemini-4-argon" },
      ],
      models: [
        { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", fast: true },
        { id: "gemini-4-neon", displayName: "Gemini 4 Neon (Antigravity)", fast: false },
        { id: "gemini-4-argon", displayName: "Gemini 4 Argon (Antigravity)", fast: false },
      ],
    } as unknown as ProfilesListOutput;
    // A member picks among the profiles alone: a new one is an admin's to make.
    expect(leadSections(leadLines(view)).map((s) => [s.group, ...s.lines.map((l) => l.value)])).toEqual([
      [undefined, LEAD_HUB],
      ["Anthropic", "high"],
      ["Google", "gemini"],
    ]);
    expect(leadSections(leadLines(view, true)).map((s) => [s.group, ...s.lines.map((l) => l.title)])).toEqual([
      [undefined, "Hub default (high)"],
      ["Anthropic", "high"],
      ["Google", "gemini", "Gemini 4 Neon"],
    ]);
    expect(leadLines(view, true).at(-1)?.value).toBe("model:gemini-4-neon");
  });
});

describe("Delete", () => {
  it("erases any bot in the desktop's words, with a tickbox naming its folder", () => {
    for (const p of [own(), project()]) {
      const root = p.workspaceRoot;
      const w = deleteWords(p, settings({ workspaceRoot: root }), "devbox");
      expect(w.title).toBe(`Delete ${p.title}?`);
      expect(w.button).toBe("Delete Bot");
      const desktop = desktopDeleteWords(p.title, "devbox", root.replace("/home/ada", "~"));
      expect(w.message).toBe(desktop.message);
      expect(`${w.folder.label}, ${w.folder.path}`).toBe(desktop.folder);
      expect(w.folder.note).toBe(desktop.folderNote);
    }
    expect(deleteWords(own(), settings({ workspaceRoot: "/home/ada/.fleetd/inbox/ada" }), "devbox").folder).toMatchObject({ label: "Also delete its folder", path: "~/.fleetd/inbox/ada" });
  });

  it("names the worktrees with uncommitted changes, a worktree without a branch by its path", () => {
    const w = deleteWords(
      project(),
      settings({ worktrees: { dir: "/w", worktrees: [{ path: "/w/a", branch: "fleetd/T1-fix", sessionId: "s1", uncommitted: true }, { path: "/w/b", sessionId: "s2", uncommitted: false }] } }),
      "devbox",
    );
    expect(w.unsaved).toEqual(["fleetd/T1-fix"]);
    const noBranch = deleteWords(project(), settings({ worktrees: { dir: "/w", worktrees: [{ path: "/home/ada/w/c", sessionId: "s3", uncommitted: true }] } }), "devbox");
    expect(noBranch.unsaved).toEqual(["~/w/c"]);
    expect(deleteWords(project(), settings(), "devbox").unsaved).toEqual([]);
  });

  it("enables the delete only once its name is typed exactly", () => {
    expect(deleteConfirmed("", "storefront")).toBe(false);
    expect(deleteConfirmed("store", "storefront")).toBe(false);
    expect(deleteConfirmed("Storefront", "storefront")).toBe(false);
    expect(deleteConfirmed("  storefront ", "storefront")).toBe(true);
    expect(deleteConfirmed("", " ")).toBe(false);
  });

  it("waits until its machine lists its worktrees", () => {
    expect(deleteBlocked(settings())).toBeUndefined();
    const { worktrees: _w, ...unlisted } = settings();
    expect(deleteBlocked({ ...unlisted, worktreesUnknown: "devbox is offline." })).toBe("Its worktrees can't be listed now: devbox is offline. Delete once they can.");
  });
});

describe("New Bot's Create", () => {
  const ok = { live: true, typed: null, typedBot: undefined, block: undefined, named: "Shop" };

  it("goes when the hub is there and it has a name or a repo to take one from", () => {
    expect(createRefusal(ok)).toBeUndefined();
    expect(createRefusal({ ...ok, typed: { repo: { kind: "clone", repo: "acme/shop" } } })).toBeUndefined();
  });

  it("is never grey without why: offline first, then what's typed, then the machine, then a name", () => {
    expect(createRefusal({ ...ok, live: false, named: "" })).toBe(NOT_CONNECTED);
    expect(createRefusal({ ...ok, typed: { why: "Type the folder's full path, starting with /." } })).toBe("Type the folder's full path, starting with /.");
    expect(createRefusal({ ...ok, typedBot: { title: "Notes", workspaceRoot: "/home/ada/notes" } })).toBe("~/notes is already the bot Notes: open it from Chats.");
    expect(createRefusal({ ...ok, block: "devbox needs a fleetd update to make a bot with no folder: update fleetd there, or add a folder that's already on devbox." })).toContain("devbox needs a fleetd update");
    expect(createRefusal({ ...ok, named: "" })).toBe("Name it, or add a repo.");
  });

  it("stops saying the hub isn't there once the link is back, and keeps any other refusal", () => {
    expect(refusalNow(NOT_CONNECTED, true)).toBeUndefined();
    expect(refusalNow(NOT_CONNECTED, false)).toBe(NOT_CONNECTED);
    expect(refusalNow("Name it, or add a repo.", true)).toBe("Name it, or add a repo.");
  });
});

describe("a machine's name", () => {
  it("calls a fleetd cloud team's hosted runner fleetd's computers, never its id or name", () => {
    const machines = [{ machineId: "hosted", name: "Hosted sandboxes" }, { machineId: "devbox", name: "devbox" }] as unknown as Parameters<typeof machineName>[0];
    expect(machineName(machines, "hosted", true)).toBe("fleetd's computers");
    expect(machineName(machines, "devbox", true)).toBe("devbox");
    // A self-hosted hub's own hosted sandboxes keep their name.
    expect(machineName(machines, "hosted")).toBe("Hosted sandboxes");
  });
});

describe("where an admin fixes a screen kind that can't open", () => {
  const off = (fix: "update" | "roles" | "none") => ({ why: "Off.", short: "Off", fix });
  it("names Machines' Updates for an update, a page the desktop's Settings has, as Team on a cloud team", () => {
    expect(offFooter(off("update"), true, null, false).footer).toBe("Fix it in the desktop app, under Settings › Hub › Machines › Updates.");
    expect(offFooter(off("update"), true, null, true).footer).toBe("Fix it in the desktop app, under Settings › Team › Machines › Updates.");
    expect(offFooter(off("roles"), true, null, true).footer).toBe("Fix it in the desktop app, under Settings › Team › Machines.");
  });
  it("tells a member who to ask, and says nothing where nobody can fix it", () => {
    expect(offFooter(off("update"), false, "Ask Ada.", true).footer).toBe("Ask Ada.");
    expect(offFooter(off("none"), true, null, true)).toEqual({});
  });
});
