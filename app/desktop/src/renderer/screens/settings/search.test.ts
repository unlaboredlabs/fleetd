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
    // MCP servers, Integrations and Tailscale are Connections' now (D653): their old names open that sheet.
    const opensOf = (q: string, admin = false) => searchSettings(q, optionsFor(admin))[0]?.opens;
    expect([opensOf("mcp"), opensOf("integrations"), opensOf("paper"), opensOf("notion"), opensOf("tailscale", true), opensOf("mcp servers for every bot", true)]).toEqual([
      "connections",
      "connections",
      "connections",
      "connections",
      "connections",
      "connections",
    ]);
    // Task profiles are the hub's, under each provider on Providers (W146, W849).
    const tabs = (q: string, admin: boolean) => searchSettings(q, optionsFor(admin)).map((o) => o.tab);
    expect(tabs("task profiles", false)).not.toContain("hub.providers");
    expect(tabs("task profiles", true)).toContain("hub.providers");
    for (const q of ["profile", "model", "effort"]) expect(searchSettings(q, optionsFor(true)).find((o) => o.key === "hub.profiles")?.tab, q).toBe("hub.providers");
    // Memory is yours on You › Your memory, a project's on its Instructions & memory, with its nightly refresh (D212).
    expect([tabOf("instructions"), tabOf("memory"), tabOf("bot memory"), tabOf("nightly")]).toEqual(["instructions", "your-memory", "instructions", "instructions"]);
    expect([tabOf("setup commands"), tabOf("subscription")]).toEqual(["projects", "accounts"]);
    expect([tabOf("automations"), tabOf("environment variables"), tabOf("prompts")]).toEqual(["automations", "projects", "prompts"]);
    // Nothing hub-wide for a member past Connections, which everyone opens (the hub says what each may change).
    expect(labels("global")).toEqual(["Connections"]);
    expect([tabOf("people", true), tabOf("invite", true), tabOf("machine roles", true)]).toEqual(["hub.people", "hub.people", "hub.machines"]);
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
    const found = OPTIONS.filter((o) => o.key !== o.tab && o.opens === undefined).map((o) => o.key);
    expect(found.filter((k) => !marked.has(k)), "in search, marked on no page").toEqual([]);
  });

  it("finds fleetd's computers on a cloud team that has them, and the providers a team keys itself everywhere else", () => {
    const keys = (q: string, billing: boolean) => searchSettings(q, optionsFor(true, true, billing)).map((o) => o.key);
    // A cloud team with fleetd's computers on: no Providers, which its Machines page doesn't show.
    for (const q of ["hosted", "boat", "at once", "cloud", "providers"]) expect(keys(q, true), q).not.toContain("hub.sandboxes");
    expect(keys("computer time", true)).toEqual(["hub.billing.usage", "hub.provided"]);
    expect(keys("fleetd's computers", true)[0]).toBe("hub.provided");
    expect(keys("size", true)).toContain("hub.provided");
    // A self-hosted hub, or a team before them: the providers, never fleetd's computers.
    expect(keys("hosted", false)).toContain("hub.sandboxes");
    expect(keys("fleetd's computers", false)).not.toContain("hub.provided");
  });

  it("finds one place once: one result each for MCP, Claude and the hub's API key (W467)", () => {
    const keys = (q: string, admin = false) => searchSettings(q, optionsFor(admin)).map((o) => o.key);
    expect(keys("mcp")).toEqual(["connections"]);
    expect(keys("claude").filter((k) => k.startsWith("claude"))).toEqual(["claude"]);
    expect(keys("hub api key", true)[0]).toBe("admin.claude");
    expect(keys("api key", true)).not.toContain("admin.claude.key");
    expect(keys("global mcp", true)).toEqual(["connections"]);
    expect(keys("tailscale", true)).toEqual(["connections.tailscale"]);
    expect(keys("integrations")).toEqual(["connections"]);
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
    // The task profiles, Every project › Agents' once, are under each provider now; the default and the lead's stay.
    expect(first("profiles")).toEqual(["hub.profiles", "hub.providers", "Hub › Providers"]);
    expect(first("add profile")).toEqual(["hub.profiles", "hub.providers", "Hub › Providers"]);
    expect(first("default profile")).toEqual(["hub.default-profile", "hub.agents", "Bot defaults › Agents"]);
    expect(first("lead runs on")).toEqual(["hub.lead", "hub.agents", "Bot defaults › Agents"]);
    // The page by its name in the sidebar.
    expect(first("bot defaults")).toEqual(["hub.agents", "hub.agents", "Bot defaults › Agents"]);
    expect(first("tools & skills")).toEqual(["hub.tools", "hub.agents", "Bot defaults › Agents"]);
    expect(first("hub-wide skills")).toEqual(["hub.skills", "hub.agents", "Bot defaults › Agents"]);
    expect(first("instructions for every bot")).toEqual(["hub.instructions", "hub.instructions", "Bot defaults › Instructions"]);
    // The hub's vault for every project is the team vault now (D492): its old name finds the Vault page.
    expect(first("vault for every bot")).toEqual(["vault", "vault", "Vault"]);
    expect(first("team card")).toEqual(["vault", "vault", "Vault"]);
    expect(first("bot variables")).toEqual(["project-vault", "project-vault", "Bot › Vault"]);
    expect(first("recovery code")).toEqual(["vault.key", "hub.vault", "Bot defaults › Vault"]);
    // Hub accounts is a part of Hub › Setup: its name finds the accounts there, and each of its options its account.
    expect(first("hub accounts")).toEqual(["hub.accounts", "hub.setup", "Hub › Setup"]);
    expect(first("connections")?.[0]).toBe("connections");
    expect(first("hub claude api key")).toEqual(["admin.claude", "hub.setup", "Hub › Setup"]);
    expect(first("members may use the hub's key")).toEqual(["admin.claude.members", "hub.setup", "Hub › Setup"]);
    expect(first("github app")).toEqual(["admin.github", "hub.setup", "Hub › Setup"]);
    expect(first("installation")).toEqual(["admin.github", "hub.setup", "Hub › Setup"]);
    expect(searchSettings("setup", optionsFor(true, true)).map((o) => o.key)).toContain("hub.setup");
    expect(first("guided setup")).toEqual(["hub.setup", "hub.setup", "Hub › Setup"]);
    expect(first("fleetd init")).toEqual(["hub.setup", "hub.setup", "Hub › Setup"]);
  });

  it("finds Version only where General shows it: not in the web app on fleetd cloud, which updates itself", () => {
    expect(searchSettings("version", optionsFor(false)).map((o) => o.key)).toContain("general.updates");
    expect(searchSettings("version", optionsFor(true, true, true, false)).map((o) => o.key)).not.toContain("general.updates");
    expect(searchSettings("check for updates", optionsFor(false, true, false, false))).toEqual([]);
  });

  it("gives every option a unique key", () => {
    expect(new Set(OPTIONS.map((o) => o.key)).size).toBe(OPTIONS.length);
  });
});
