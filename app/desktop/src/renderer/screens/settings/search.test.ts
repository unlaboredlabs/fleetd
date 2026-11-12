import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pageOf } from "./route";
import { OPTIONS, optionsFor, pagePath, searchSettings } from "./search";

/** What a member finds; an admin finds the Hub group's too. */
const labels = (q: string, admin = false) => searchSettings(q, optionsFor(admin)).map((o) => o.label);

describe("settings search", () => {
  it("finds an option by its own name, name matches first", () => {
    expect(labels("max agents")[0]).toBe("Max agents");
    // The machine caps are the Hub group's: a member never finds them, an admin does. The fleet cap is the CLI's.
    expect(labels("max agents")).not.toContain("Machine max agents");
    expect(labels("machine cap")).toEqual([]);
    expect(labels("machine cap", true)).toEqual(["Machine max agents"]);
    expect(labels("fleet cap", true)).toEqual([]);
    expect(labels("APPEARANCE")).toEqual(["Appearance"]);
  });

  it("finds an option by the words people use for it", () => {
    expect(labels("dark")).toEqual(["Appearance"]);
    expect(labels("disconnect")).toEqual(["Hub"]);
  });

  it("finds the built-in prompts as one page, never one result per prompt", () => {
    const found = (q: string, admin = false) => searchSettings(q, optionsFor(admin)).filter((o) => o.tab === "prompts" || o.tab === "hub.prompts");
    for (const q of ["prompts", "built-in prompts", "reviewer", "voice", "system prompt"]) expect(found(q).map((o) => o.key), q).toEqual(["prompts"]);
    expect(found("prompts")[0]?.label).toBe("Built-in prompts");
    // An admin finds the same one page: the hub-wide ones open from Hub › Instructions.
    expect(found("prompts", true).map((o) => o.key)).toEqual(["prompts"]);
  });

  it("needs every word, and finds nothing for nothing", () => {
    expect(labels("dark sound")).toEqual([]);
    expect(labels("   ")).toEqual([]);
  });

  it("still finds every page Settings and Administration had before D211, on the page that has it now", () => {
    const tabOf = (q: string, admin = false) => searchSettings(q, optionsFor(admin))[0]?.tab;
    expect([tabOf("hubs"), tabOf("claude"), tabOf("github")]).toEqual(["hubs", "accounts", "accounts"]);
    expect([tabOf("notifications"), tabOf("version"), tabOf("check for updates")]).toEqual(["general", "general", "general"]);
    expect([tabOf("max agents"), tabOf("skills")]).toEqual(["agents", "agents"]);
    // A project's MCP servers are one list, on its Project page (W467).
    expect([tabOf("mcp"), tabOf("integrations")]).toEqual(["projects", "projects"]);
    // Task profiles are the hub's, on Every project › Agents (W146).
    const tabs = (q: string, admin: boolean) => searchSettings(q, optionsFor(admin)).map((o) => o.tab);
    expect(tabs("task profiles", false)).not.toContain("hub.profiles");
    expect(tabs("task profiles", true)).toContain("hub.profiles");
    // Memory is yours on You › Your memory, a project's on its Instructions & memory, with its nightly refresh (D212).
    expect([tabOf("instructions"), tabOf("memory"), tabOf("project memory"), tabOf("nightly")]).toEqual(["instructions", "your-memory", "instructions", "instructions"]);
    expect([tabOf("setup commands"), tabOf("linked hubs"), tabOf("subscription")]).toEqual(["projects", "projects", "accounts"]);
    expect([tabOf("automations"), tabOf("environment variables"), tabOf("prompts")]).toEqual(["automations", "projects", "prompts"]);
    // Nothing hub-wide for a member: the global MCP servers and the instructions for every project are the Hub group's.
    expect(labels("global")).toEqual([]);
    expect([tabOf("people", true), tabOf("invite", true), tabOf("machine roles", true), tabOf("global mcp", true)]).toEqual(["hub.people", "hub.people", "hub.machines", "hub.profiles"]);
    expect([tabOf("github app", true), tabOf("guided setup", true)]).toEqual(["hub.setup", "hub.setup"]);
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
    const found = OPTIONS.filter((o) => o.key !== o.tab).map((o) => o.key);
    expect(found.filter((k) => !marked.has(k)), "in search, marked on no page").toEqual([]);
  });

  it("finds one place once: one result each for MCP, hub links, Claude and the hub's API key (W467)", () => {
    const keys = (q: string, admin = false) => searchSettings(q, optionsFor(admin)).map((o) => o.key);
    expect(keys("mcp")).toEqual(["projects.mcp"]);
    expect(keys("hub links")).toEqual(["hubs.links"]);
    expect(keys("claude").filter((k) => k.startsWith("claude"))).toEqual(["claude"]);
    expect(keys("hub api key", true)[0]).toBe("admin.claude");
    expect(keys("api key", true)).not.toContain("admin.claude.key");
    expect(keys("global mcp", true)).toEqual(["hub.mcp"]);
    expect(keys("worktrees")).toEqual([]);
  });

  it("opens every option on a page of its own, never on one that became a part of another", () => {
    expect(OPTIONS.filter((o) => pageOf(o.tab) !== o.tab).map((o) => o.key)).toEqual([]);
  });

  it("still finds what was a page once by its old name and words, on the page that holds it now", () => {
    const first = (q: string) => {
      const o = searchSettings(q, optionsFor(true, true))[0];
      return o === undefined ? null : [o.key, o.tab, pagePath(o.tab)];
    };
    expect(first("your devices")).toEqual(["devices", "hubs", "Hubs & devices"]);
    expect(first("pair a phone")).toEqual(["devices.pair", "hubs", "Hubs & devices"]);
    expect(first("hubs")).toEqual(["hubs", "hubs", "Hubs & devices"]);
    expect(first("updates")).toEqual(["hub.updates", "hub.machines", "Hub › Machines"]);
    expect(first("update automatically")).toEqual(["hub.updates", "hub.machines", "Hub › Machines"]);
    expect(first("profiles")).toEqual(["hub.task-profiles", "hub.profiles", "Every project › Agents"]);
    expect(first("tools & skills")).toEqual(["hub.tools", "hub.profiles", "Every project › Agents"]);
    expect(first("hub-wide skills")).toEqual(["hub.skills", "hub.profiles", "Every project › Agents"]);
    expect(first("instructions for every project")).toEqual(["hub.instructions", "hub.instructions", "Every project › Instructions"]);
    // The hub's vault for every project is the team vault now (D492): its old name finds the Vault page.
    expect(first("vault for every project")).toEqual(["vault", "vault", "Vault"]);
    expect(first("team card")).toEqual(["vault", "vault", "Vault"]);
    expect(first("project variables")).toEqual(["project-vault", "project-vault", "Project › Vault"]);
    expect(first("recovery code")).toEqual(["vault.key", "hub.vault", "Every project › Vault"]);
    // Hub accounts is a part of Hub › Setup: its name finds the accounts there, and each of its options its account.
    expect(first("hub accounts")).toEqual(["hub.accounts", "hub.setup", "Hub › Setup"]);
    expect(first("connections")?.[1]).toBe("accounts");
    expect(first("hub claude api key")).toEqual(["admin.claude", "hub.setup", "Hub › Setup"]);
    expect(first("members may use the hub's key")).toEqual(["admin.claude.members", "hub.setup", "Hub › Setup"]);
    expect(first("github app")).toEqual(["admin.github", "hub.setup", "Hub › Setup"]);
    expect(first("installation")).toEqual(["admin.github", "hub.setup", "Hub › Setup"]);
    expect(searchSettings("setup", optionsFor(true, true)).map((o) => o.key)).toContain("hub.setup");
    expect(first("guided setup")).toEqual(["hub.setup", "hub.setup", "Hub › Setup"]);
    expect(first("fleetd init")).toEqual(["hub.setup", "hub.setup", "Hub › Setup"]);
  });

  it("gives every option a unique key", () => {
    expect(new Set(OPTIONS.map((o) => o.key)).size).toBe(OPTIONS.length);
  });
});
