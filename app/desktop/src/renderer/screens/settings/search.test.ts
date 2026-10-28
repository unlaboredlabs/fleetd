import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRoute, replaceRoute } from "./route";
import { OPTIONS, optionHref, optionsFor, searchSettings } from "./search";

/** What a member finds; an admin finds the Hub group's too. */
const labels = (q: string, admin = false) => searchSettings(q, optionsFor(admin)).map((o) => o.label);

describe("settings search", () => {
  it("finds an option by its own name, name matches first", () => {
    expect(labels("max agents")[0]).toBe("Max agents");
    // The fleet and machine caps are the Hub group's: a member never finds them, an admin does.
    expect(labels("max agents")).not.toContain("Machine max agents");
    expect(labels("fleet cap")).toEqual([]);
    expect(labels("fleet cap", true)).toEqual(["Machine max agents"]);
    expect(labels("APPEARANCE")).toEqual(["Appearance"]);
  });

  it("finds an option by the words people use for it", () => {
    expect(labels("dark")).toEqual(["Appearance"]);
    expect(labels("disconnect")).toEqual(["Hub"]);
  });

  it("finds a prompt by its name, opening it in the editor", () => {
    const [reviewer] = searchSettings("reviewer");
    expect(reviewer?.prompt).toBe("review.reviewer");
    expect(reviewer?.tab).toBe("prompts");
  });

  it("needs every word, and finds nothing for nothing", () => {
    expect(labels("dark sound")).toEqual([]);
    expect(labels("   ")).toEqual([]);
  });

  it("still finds every page Settings and Administration had before D211, on the page that has it now", () => {
    const tabOf = (q: string, admin = false) => searchSettings(q, optionsFor(admin))[0]?.tab;
    expect([tabOf("hubs"), tabOf("claude"), tabOf("github")]).toEqual(["hubs", "accounts", "accounts"]);
    expect([tabOf("notifications"), tabOf("version"), tabOf("check for updates")]).toEqual(["general", "general", "general"]);
    expect([tabOf("max agents"), tabOf("mcp"), tabOf("skills")]).toEqual(["agents", "agents", "agents"]);
    // Task profiles are the hub's, on Every project › Profiles (W146).
    const tabs = (q: string, admin: boolean) => searchSettings(q, optionsFor(admin)).map((o) => o.tab);
    expect(tabs("task profiles", false)).not.toContain("hub.profiles");
    expect(tabs("task profiles", true)).toContain("hub.profiles");
    // Memory is yours on You › Your memory, a project's on its Instructions & memory, with its nightly refresh (D212).
    expect([tabOf("instructions"), tabOf("memory"), tabOf("project memory"), tabOf("nightly")]).toEqual(["instructions", "your-memory", "instructions", "instructions"]);
    expect([tabOf("setup commands"), tabOf("linked hubs"), tabOf("gmail")]).toEqual(["projects", "hubs", "accounts"]);
    expect(tabOf("shared memory", true)).toBe("hub.instructions");
    expect([tabOf("automations"), tabOf("environment variables"), tabOf("prompts")]).toEqual(["automations", "projects", "prompts"]);
    // Nothing hub-wide for a member: the global MCP servers and the instructions for every project are the Hub group's.
    expect(labels("global")).toEqual([]);
    expect([tabOf("people", true), tabOf("invite", true), tabOf("machine roles", true), tabOf("global mcp", true)]).toEqual(["hub.people", "hub.people", "hub.machines", "hub.tools"]);
    expect([tabOf("memory caps", true), tabOf("github app", true), tabOf("google client", true), tabOf("guided setup", true)]).toEqual([
      "hub.instructions",
      "hub.accounts",
      "hub.accounts",
      "hub.accounts",
    ]);
  });

  it("finds every option a page marks for search, and marks every option it finds", () => {
    const screens = join(__dirname, "..");
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const path = join(dir, f);
        return statSync(path).isDirectory() ? files(path) : /\.tsx?$/u.test(f) && !f.includes(".test.") ? [path] : [];
      });
    const marked = new Set<string>();
    for (const file of files(screens)) {
      const text = readFileSync(file, "utf8");
      for (const re of [/reveal="([^"]+)"/gu, /reveal=\{[^}]*?"([^"]+)"/gu, /useReveal<[^>]*>\("([^"]+)"\)/gu]) {
        for (const m of text.matchAll(re)) if (m[1] !== undefined) marked.add(m[1]);
      }
    }
    const keys = new Set(OPTIONS.map((o) => o.key));
    expect([...marked].filter((k) => !keys.has(k)), "marked on a page, missing from search").toEqual([]);
    const found = OPTIONS.filter((o) => o.key !== o.tab && o.prompt === undefined).map((o) => o.key);
    expect(found.filter((k) => !marked.has(k)), "in search, marked on no page").toEqual([]);
  });

  it("gives every option a unique key", () => {
    expect(new Set(OPTIONS.map((o) => o.key)).size).toBe(OPTIONS.length);
  });

  it("opens a prompt in the project Prompts was showing, so a save never lands hub-wide by surprise", () => {
    vi.stubGlobal("window", { location: { hash: "" }, history: { state: null, replaceState: () => undefined }, dispatchEvent: () => true });
    replaceRoute({ tab: "prompts", prompt: "lead.start", for: "devbox/storefront" });
    const [reviewer] = searchSettings("reviewer");
    if (reviewer === undefined) throw new Error("no reviewer");
    expect(parseRoute(optionHref(reviewer))).toMatchObject({ tab: "prompts", prompt: "review.reviewer", for: "devbox/storefront" });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
