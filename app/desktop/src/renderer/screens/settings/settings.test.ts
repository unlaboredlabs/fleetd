import { describe as group, expect, it } from "vitest";
import { GROUPS, describe, groupOf, sections } from "./catalog";
import type { PromptDetail, PromptSummary } from "./contracts";
import { diffLines, sameProse } from "./diff";
import {
  HUB,
  canSave,
  editScope,
  effectLines,
  fillBase,
  hasConflictMarkers,
  insertAt,
  parseScope,
  refill,
  shownDraft,
  startOn,
  synced,
  syncedMerge,
  updateTarget,
  warningLine,
  type Filled,
} from "./editor";
import registry from "./fixture/registry.json";
import { formatRoute, parseRoute } from "./route";

const summary = (id: string, extra: Partial<PromptSummary> = {}): PromptSummary => ({
  id,
  title: `Hub title of ${id}`,
  kind: "msg",
  group: "messages",
  sentWhen: "per something",
  scope: "default",
  defaultRef: `${id}@0000000000`,
  stale: false,
  ...extra,
});

const all = registry.prompts.map((p) => summary(p.id, { title: p.title, sentWhen: p.sentWhen }));

group("the prompt catalog", () => {
  it("names, describes and groups every editable prompt this fleetd ships", () => {
    // Fifteen editable prompts; the instructions have their own page.
    expect(all.length).toBe(15);
    const unknown = all.filter((p) => groupOf(p) === "other").map((p) => p.id);
    expect(unknown).toEqual([]);
    for (const p of all) {
      const d = describe(p);
      expect(d.name, p.id).not.toMatch(/^(Wake|Digest):|\./u);
      expect(d.description.length, p.id).toBeGreaterThan(20);
    }
    // No two prompts in one group read the same.
    for (const s of sections(all)) {
      const names = s.rows.map((r) => r.name);
      expect(new Set(names).size, s.group.key).toBe(names.length);
    }
  });

  it("keeps the groups in their order, leaves out empty ones and the instructions", () => {
    const shown = sections([...all, summary("instructions", { kind: "instructions", group: "instructions" })]);
    const order = GROUPS.map((g) => g.key);
    const keys = shown.map((s) => s.group.key);
    expect(keys).toEqual(order.filter((k) => keys.includes(k)));
    expect(keys).not.toContain("other");
    expect(shown.flatMap((s) => s.rows).some((r) => r.summary.id === "instructions")).toBe(false);
  });

  it("shows a prompt from a newer hub in its hub group, with the hub's own words", () => {
    const [messages] = sections([summary("wake.something_new", { title: "Wake: something new", sentWhen: "per `wake_set` that fired late." })]);
    expect(messages?.group.key).toBe("messages");
    expect(messages?.rows[0]).toMatchObject({ name: "Wake: something new", description: "Sent per wake set that fired late." });
  });
});

group("the editor", () => {
  const filled = (over: Partial<Filled> = {}): Filled => ({ scope: "hub", id: "lead.start", ref: "lead.start@aaaaaaaaaa", text: "old", base: "lead.start@aaaaaaaaaa", ...over });

  it("refills for another prompt or scope, and for a hub change only when there is no draft", () => {
    const before = filled();
    expect(refill(null, before, "")).toBe(true);
    expect(refill(before, filled({ id: "router" }), "my draft")).toBe(true);
    expect(refill(before, filled({ scope: "devbox/storefront" }), "my draft")).toBe(true);
    expect(refill(before, filled({ ref: "lead.start@bbbbbbbbbb", text: "new" }), "old")).toBe(true);
    expect(refill(before, filled({ ref: "lead.start@bbbbbbbbbb", text: "new" }), "my draft")).toBe(false);
    expect(refill(before, filled(), "my draft")).toBe(false);
  });

  it("offers Save only for a real, non-empty change with nothing in flight", () => {
    expect(canSave("same", "same", false)).toBe(false);
    expect(canSave("  \n", "text", false)).toBe(false);
    expect(canSave("new", "text", true)).toBe(false);
    expect(canSave("new", "text", false)).toBe(true);
  });

  it("inserts a placeholder over the selection and puts the caret after it", () => {
    expect(insertAt("Hello world", 6, 11, "{{who}}")).toEqual({ value: "Hello {{who}}", caret: 13 });
    expect(insertAt("abc", 99, 99, "X")).toEqual({ value: "abcX", caret: 4 });
  });

  it("saves a hub-wide-only prompt hub-wide even with a project picked", () => {
    const d = { perProject: false, scope: "default" } as PromptDetail;
    const storefront = parseScope("devbox/storefront");
    expect(editScope(d, storefront)).toBe("global");
    expect(editScope({ ...d, perProject: true }, storefront)).toBe("project");
    expect(editScope({ ...d, perProject: true }, HUB)).toBe("global");
    expect(effectLines(d, storefront, "acme/storefront").lands).toBe("This prompt has one hub-wide text: saving changes it for every project.");
  });

  it("says who still keeps a safety rule the text dropped", () => {
    const w = { code: "safety_rule_missing", message: "The text no longer says it never merges.", rule: "never-merge" } as const;
    expect(warningLine({ ...w, enforced: "code" })).toMatch(/fleetd still enforces this/u);
    expect(warningLine({ ...w, enforced: "prompt" })).toMatch(/Nothing else enforces this/u);
  });

  it("spots merge conflict markers only at a line start", () => {
    expect(hasConflictMarkers("a\n<<<<<<< yours\nb")).toBe(true);
    expect(hasConflictMarkers("compare a <<<<<<< b")).toBe(false);
  });
});

// Review blockers on #185: the Update view's level, the base a save sends, and a kept draft on every entry path.
group("defaults that change under an edit", () => {
  const storefront = parseScope("devbox/storefront");
  const v = (id: string, text: string) => ({ ref: `lead.start@${id.padEnd(10, "0")}`, text });
  const v1 = v("1", "Default one.\n");
  const v2 = v("2", "Default two.\n");
  const mine = v("3", "Default one.\nMine.\n");
  const detail = (over: Partial<PromptDetail> = {}): PromptDetail => ({
    id: "lead.start",
    title: "Lead: first message",
    kind: "start",
    group: "lead",
    sentWhen: "lead start",
    perProject: true,
    default: v2,
    scope: "default",
    effective: v2,
    placeholders: [],
    safetyRules: [],
    warnings: [],
    ...over,
  });
  const stale = { scope: "global", base: v1, current: v2, yours: mine, merged: "Default two.\nMine.\n", conflicts: false } as const;
  const staleHubWide = detail({ scope: "global", global: { ...mine, base: v1.ref }, effective: mine, stale });

  it("acts on the level that owns the stale edit, not the scope on screen", () => {
    // A project with no edit of its own, looking at a stale hub-wide edit: Update saves and resets hub-wide.
    expect(updateTarget(staleHubWide, storefront)).toEqual({ scope: "global" });
    expect(editScope(staleHubWide, storefront)).toBe("project");
    const staleOwn = detail({ ...staleHubWide, scope: "project", stale: { ...stale, scope: "project" } });
    expect(updateTarget(staleOwn, storefront)).toEqual({ scope: "project", projectRef: { machineId: "devbox", projectId: "storefront" } });
    expect(updateTarget(staleHubWide, HUB)).toEqual({ scope: "global" });
  });

  it("saves a draft against the default it was written from, so the hub keeps fleetd's change to merge", () => {
    // Filled from default one, edited, then the hub upgraded to default two.
    const first = synced(null, detail({ default: v1, effective: v1 }), "hub", "");
    expect(first.filled.base).toBe(v1.ref);
    const after = synced(first.filled, detail(), "hub", "Default one, edited.\n");
    expect(after.refill).toBe(false);
    expect(after.filled.base).toBe(v1.ref);
    // Without a draft, the new default is simply taken.
    expect(synced(first.filled, detail(), "hub", first.filled.text)).toMatchObject({ refill: true, filled: { base: v2.ref } });
  });

  it("keeps a stale edit's own base when it is edited from the Edit tab", () => {
    expect(fillBase(staleHubWide)).toBe(v1.ref);
    expect(synced(null, staleHubWide, "devbox/storefront", "").filled.base).toBe(v1.ref);
    // No record of the base: nothing to send, and the Edit tab won't save it.
    const { base: _, ...noBase } = stale;
    expect(fillBase(detail({ ...staleHubWide, stale: noBase }))).toBeNull();
  });

  it("keeps a merge in progress against the default it merges, when fleetd's default moves again", () => {
    const first = syncedMerge(null, staleHubWide, "hub", "");
    expect(first?.filled.base).toBe(v2.ref);
    // Default three ships while the merge is being edited.
    const v3 = v("4", "Default three.\n");
    const moved = detail({ ...staleHubWide, default: v3, stale: { ...stale, current: v3, merged: "Default three.\nMine.\n" } });
    const during = syncedMerge(first?.filled ?? null, moved, "hub", "Default two.\nMine, merged.\n");
    expect(during).toMatchObject({ refill: false, filled: { base: v2.ref } });
    // An untouched merge simply takes the newer one.
    expect(syncedMerge(first?.filled ?? null, moved, "hub", first?.filled.text ?? "")).toMatchObject({ refill: true, filled: { base: v3.ref } });
    expect(syncedMerge(null, detail(), "hub", "")).toBeNull();
  });

  it("asks before a link drops a merge-only draft", () => {
    const filled = { scope: "hub", id: "lead.start", ref: mine.ref, text: mine.text, base: v1.ref };
    const mergeDraft = { filled, text: mine.text, mergedFilled: { ...filled, ref: v2.ref, text: "merged", base: v2.ref }, merged: "merged, edited" };
    expect(startOn(mergeDraft, { prompt: "router", for: null })).toMatchObject({ id: "lead.start", ask: { id: "router" } });
    expect(startOn({ ...mergeDraft, merged: "merged" }, { prompt: "router", for: null }).ask).toBeNull();
  });

  it("opens on a kept draft and asks before following a link to another prompt or scope", () => {
    const draft = { filled: { scope: "hub", id: "lead.start", ref: v2.ref, text: "Default two.\n", base: v2.ref }, text: "Edited.\n" };
    expect(startOn(draft, { prompt: "router", for: null })).toEqual({
      scope: HUB,
      id: "lead.start",
      ask: { scope: HUB, id: "router" },
    });
    expect(startOn(draft, { prompt: "lead.start", for: "devbox/storefront" }).ask).toEqual({ scope: storefront, id: "lead.start" });
    expect(startOn(draft, { prompt: "lead.start", for: null }).ask).toBeNull();
    expect(startOn(draft, { prompt: null, for: null })).toMatchObject({ id: "lead.start", ask: null });
    // A clean kept text is no draft: the link just opens.
    expect(startOn({ ...draft, text: draft.filled.text }, { prompt: "router", for: null })).toEqual({ scope: HUB, id: "router", ask: null });
  });
});

group("instructions across a reconnect", () => {
  it("hides the last connection's text until the hub answers again, but keeps what you typed", () => {
    const untouched = { from: "Keep PRs small.", text: "Keep PRs small." };
    const typed = { from: "Keep PRs small.", text: "Keep PRs small. Use pnpm." };
    expect(shownDraft(true, untouched)).toBe(untouched);
    expect(shownDraft(false, untouched)).toBeNull();
    expect(shownDraft(false, typed)).toBe(typed);
    expect(shownDraft(false, null)).toBeNull();
  });
});

group("the prose diff", () => {
  it("marks the changed words inside an edited paragraph", () => {
    const d = diffLines("Keep it short.\nNever merge a PR.\n", "Keep it short.\nNever merge a pull request.\n");
    expect(d.map((l) => l.op)).toEqual(["same", "del", "add"]);
    const added = d[2]?.words?.filter((w) => w.op === "add").map((w) => w.text.trim());
    expect(added).toEqual(["pull request."]);
  });

  it("does not pair paragraphs that have nothing in common", () => {
    const d = diffLines("Alpha beta gamma.", "Completely different words here.");
    expect(d.every((l) => l.words === undefined)).toBe(true);
  });

  it("treats a reflow as the same prose", () => {
    expect(sameProse("one two\nthree", "one two three\n")).toBe(true);
    expect(sameProse("one two", "one three")).toBe(false);
  });
});

group("settings state", () => {
  it("round-trips a link to one prompt of one project", () => {
    const hash = formatRoute({ tab: "prompts", prompt: "task.brief.write", for: "devbox/storefront" });
    expect(hash).toBe("#/settings/prompts?prompt=task.brief.write&for=devbox/storefront");
    expect(parseRoute(hash)).toEqual({ tab: "prompts", prompt: "task.brief.write", for: "devbox/storefront", view: "edit" });
    expect(parseRoute(`${hash}&view=update`).view).toBe("update");
    expect(parseRoute("#/settings")).toEqual({ tab: "general", prompt: null, for: null, view: "edit" });
    expect(parseScope("devbox/storefront")).toEqual({ kind: "project", ref: { machineId: "devbox", projectId: "storefront" } });
    expect(parseScope("nonsense")).toEqual(HUB);
  });

});
