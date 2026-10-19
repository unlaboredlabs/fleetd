import { describe as group, expect, it } from "vitest";
import { GROUPS, describe, groupOf, sections } from "./catalog";
import type { PromptDetail, PromptSummary } from "./contracts";
import { diffLines, sameProse } from "./diff";
import { HUB, canSave, editScope, effectLines, hasConflictMarkers, insertAt, parseScope, refill, warningLine, type Filled } from "./editor";
import registry from "./fixture/registry.json";
import { parseCollapsed } from "./prefs";
import { formatRoute, parseRoute } from "./route";

const summary = (id: string, extra: Partial<PromptSummary> = {}): PromptSummary => ({
  id,
  title: `Hub title of ${id}`,
  kind: "wake",
  group: "wakes_and_messages",
  sentWhen: "per something",
  scope: "default",
  defaultRef: `${id}@0000000000`,
  stale: false,
  ...extra,
});

const all = registry.prompts.map((p) => summary(p.id, { title: p.title, sentWhen: p.sentWhen }));

group("the prompt catalog", () => {
  it("names, describes and groups every prompt this fleetd ships", () => {
    expect(all.length).toBeGreaterThanOrEqual(60);
    const unknown = all.filter((p) => groupOf(p) === "other").map((p) => p.id);
    expect(unknown).toEqual([]);
    for (const p of all) {
      const d = describe(p);
      expect(d.name, p.id).not.toMatch(/^(Wake|Digest):|\./u);
      expect(d.description.length, p.id).toBeGreaterThan(20);
    }
    // No two prompts in one group read the same.
    for (const s of sections(all, "")) {
      const names = s.rows.map((r) => r.name);
      expect(new Set(names).size, s.group.key).toBe(names.length);
    }
  });

  it("finds a prompt by any word of its name, description, hub title or id, accents and case aside", () => {
    const ids = (q: string) => sections(all, q).flatMap((s) => s.rows.map((r) => r.summary.id));
    expect(ids("WOULD not TAKE")).toEqual(["wake.train.refused"]);
    expect(ids("pull request refused")).toEqual(["wake.train.refused", "wake.train.gave_up"]);
    expect(ids("status.headline")).toEqual(["status.headline"]);
    expect(ids("waivéd")).toEqual(["digest.train.waived"]);
    expect(ids("no such words")).toEqual([]);
  });

  it("keeps the groups in their order, leaves out empty ones and the instructions", () => {
    const shown = sections([...all, summary("instructions", { kind: "instructions", group: "instructions" })], "");
    const order = GROUPS.map((g) => g.key);
    const keys = shown.map((s) => s.group.key);
    expect(keys).toEqual(order.filter((k) => keys.includes(k)));
    expect(keys).not.toContain("other");
    expect(shown.flatMap((s) => s.rows).some((r) => r.summary.id === "instructions")).toBe(false);
  });

  it("shows a prompt from a newer hub in Other, with the hub's own words", () => {
    const [other] = sections([summary("wake.something_new", { title: "Wake: something new", sentWhen: "per new thing." })], "");
    expect(other?.group.key).toBe("other");
    expect(other?.rows[0]).toMatchObject({ name: "Wake: something new", description: "Sent per new thing." });
  });
});

group("the editor", () => {
  const filled = (over: Partial<Filled> = {}): Filled => ({ scope: "hub", id: "lead.start", ref: "lead.start@aaaaaaaaaa", text: "old", ...over });

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

  it("remembers folded groups, and starts with only the lead's and the tasks' open", () => {
    expect([...parseCollapsed(JSON.stringify(["digest"]))]).toEqual(["digest"]);
    const first = parseCollapsed(null);
    expect(first.has("lead") || first.has("tasks")).toBe(false);
    expect(first.has("digest")).toBe(true);
    expect(parseCollapsed("{damaged")).toEqual(first);
  });
});
