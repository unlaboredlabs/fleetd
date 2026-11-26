import { describe, expect, it } from "vitest";
import type { McpServer } from "../../../shared/contracts";
import {
  botsText,
  connectedOf,
  countText,
  customOf,
  draftOf,
  emptyDraft,
  initialOf,
  isTailnetHost,
  serverNameProblem,
  needsSignIn,
  onForBots,
  onlyText,
  pickedText,
  splitCommand,
  stateOf,
  suggestedName,
  testLine,
  toggleBot,
  toInput,
  usedBy,
  withBots,
  withEnabled,
  freeName,
  type Draft,
} from "./model";

const TEAM = { kind: "global" as const };
const server = (name: string, url: string, more: Partial<McpServer> = {}): McpServer => ({
  scope: TEAM,
  name,
  enabled: true,
  roles: { lead: true, writers: true, reviewers: true },
  transport: { type: "http", url },
  headers: [],
  updatedAt: "2026-11-22T10:00:00.000Z",
  ...more,
});
const signedIn = { status: "connected", issuer: "https://auth.example" } as const;
const ada = { machineId: "devbox", projectId: "ada", title: "ada" };
const billing = { machineId: "devbox", projectId: "billing", title: "billing" };
const shop = { machineId: "laptop", projectId: "shop", title: "storefront" };
const BOTS = [ada, billing, shop];

describe("Connections", () => {
  it("imports no package, so the phone reads it as it is", async () => {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(new URL("./model.ts", import.meta.url), "utf8");
    expect([...text.matchAll(/from "([^"]+)"/gu)].map((m) => m[1])).toEqual(["../../../shared/contracts", "../../../shared/claudeEndpoint", "../settings/namedServers"]);
  });

  it("knows a tailnet host by its MagicDNS name or Tailscale address, and nothing else", () => {
    expect(isTailnetHost("http://devbox.tail1234.ts.net:8080/mcp")).toBe(true);
    expect(isTailnetHost("http://100.104.1.2:4790/mcp")).toBe(true);
    expect(isTailnetHost("http://100.64.0.1/")).toBe(true);
    expect(isTailnetHost("http://100.127.255.255/")).toBe(true);
    expect(isTailnetHost("http://[fd7a:115c:a1e0::1]:80/mcp")).toBe(true);
    expect(isTailnetHost("http://100.128.0.1/")).toBe(false);
    expect(isTailnetHost("http://100.63.0.1/")).toBe(false);
    expect(isTailnetHost("https://mcp.notion.com/mcp")).toBe(false);
    expect(isTailnetHost("not a url")).toBe(false);
  });

  it("strips named services from the custom list, the team's first, then each bot's own", () => {
    const own = server("notes", "https://notes.example/mcp", { scope: { kind: "project", ...ada } });
    const list = customOf([server("zeta", "https://z.example"), server("paper", "https://mcp.paper.design"), server("alpha", "https://a.example")], [own]);
    expect(list.map((s) => s.name)).toEqual(["alpha", "zeta", "notes"]);
  });

  it("counts what is connected: named ones signed in, Tailscale connected, custom ones usable", () => {
    const team = [
      server("paper", "https://mcp.paper.design", { oauth: signedIn }),
      server("notion", "https://mcp.notion.com/mcp", { oauth: { status: "signed_out", issuer: "https://mcp.notion.com" } }),
      server("linear", "https://mcp.linear.app/mcp", { oauth: signedIn }),
      server("old", "https://old.example", { enabled: false }),
    ];
    const strip = connectedOf(team, [], { status: "connected", tailnet: "example.com" });
    expect(strip.map((i) => i.label)).toEqual(["Paper", "Tailscale", "linear"]);
    expect(countText(strip.length)).toBe("3 connected");
    expect(countText(0)).toBeNull();
    expect(connectedOf([], [], { status: "login" })).toEqual([]);
  });

  it("counts each account of a service, each by its own name, and lists none of them as custom", () => {
    const team = [
      server("notion", "https://mcp.notion.com/mcp", { oauth: signedIn }),
      server("notion-work", "https://mcp.notion.com/mcp", { oauth: signedIn }),
      server("notion-3", "https://mcp.notion.com/mcp", { oauth: { status: "signed_out", issuer: "https://mcp.notion.com" } }),
    ];
    const strip = connectedOf(team, [], undefined);
    expect(strip.map((i) => [i.key, i.label, i.named?.id])).toEqual([
      ["notion:notion", "notion", "notion"],
      ["notion:notion-work", "notion-work", "notion"],
    ]);
    expect(countText(strip.length)).toBe("2 connected");
    expect(customOf(team, [])).toEqual([]);
    // Disconnect one, and the other is the service again, by the service's name, or by its own when it has one.
    expect(connectedOf(team.slice(0, 1), [], undefined).map((i) => i.label)).toEqual(["Notion"]);
    expect(connectedOf(team.slice(1, 2), [], undefined).map((i) => i.label)).toEqual(["notion-work"]);
  });

  it("checks a name as the form does", () => {
    expect(serverNameProblem("notion-work", ["notion"])).toBeNull();
    expect(serverNameProblem("Notion", ["notion"])).toBe("Notion is already there.");
    expect(serverNameProblem("", [])).toBe("Name it.");
    expect(serverNameProblem("my notion", [])).toBe("A name is letters, digits, _ and - only.");
    expect(serverNameProblem("fleetd", [])).toBe("fleetd is fleetd's own tools: pick another name.");
  });

  it("says which bots use a server", () => {
    expect(botsText(server("a", "https://a.example"), BOTS)).toBe("Every bot");
    expect(botsText(server("a", "https://a.example", { projects: [] }), BOTS)).toBe("No bot");
    expect(botsText(server("a", "https://a.example", { projects: [ada] }), BOTS)).toBe("ada");
    expect(botsText(server("a", "https://a.example", { projects: [ada, shop] }), BOTS)).toBe("ada, storefront");
    expect(pickedText([ada, billing, shop], [...BOTS, { machineId: "x", projectId: "y", title: "y" }])).toBe("3 bots");
    expect(botsText(server("a", "https://a.example", { scope: { kind: "project", ...shop } }), BOTS)).toBe("storefront");
    // On its row a bot's name never stands alone (W817).
    expect(onlyText(server("a", "https://a.example"), BOTS)).toBeNull();
    expect(onlyText(server("a", "https://a.example", { projects: [] }), BOTS)).toBe("No bot");
    expect(onlyText(server("a", "https://a.example", { projects: [ada] }), BOTS)).toBe("Only ada");
    expect(onlyText(server("a", "https://a.example", { scope: { kind: "project", ...shop } }), BOTS)).toBe("Only storefront");
    expect(usedBy(server("a", "https://a.example", { projects: [ada] }), billing)).toBe(false);
    expect(usedBy(server("a", "https://a.example"), billing)).toBe(true);
    expect(usedBy(server("a", "https://a.example", { scope: { kind: "project", ...shop } }), shop)).toBe(true);
  });

  it("ticks bots in a pick, every bot ticked being every bot", () => {
    const one = toggleBot(undefined, ada, BOTS);
    expect(one).toEqual([billing, shop].map(({ machineId, projectId }) => ({ machineId, projectId })));
    expect(toggleBot(one, ada, BOTS)).toBeUndefined();
    expect(toggleBot([{ machineId: "devbox", projectId: "ada" }], ada, BOTS)).toEqual([]);
  });

  it("says a Test in one plain line", () => {
    expect(testLine({ machineId: "devbox", result: { tools: [{ name: "a" }, { name: "b" }] } }, "devbox")).toEqual({ text: "Works on devbox: 2 tools.", tone: "success" });
    expect(testLine({ machineId: "devbox", result: { tools: [{ name: "a" }], via: "tailnet" } }, "devbox").text).toBe("Works on devbox through Tailscale: 1 tool.");
    expect(testLine({ machineId: "devbox", result: { error: "connect ECONNREFUSED 100.104.1.2:8080" } }, "devbox")).toEqual({
      text: "Failed on devbox: connect ECONNREFUSED 100.104.1.2:8080.",
      tone: "danger",
    });
    expect(testLine({ machineId: "devbox", result: { signIn: true } }, "devbox").tone).toBe("warning");
    expect(testLine({ machineId: "devbox", result: { signIn: true } }, "devbox").text).toBe("Asks you to sign in.");
    // A URL with no key and no sign-in that answered needs none; one with a header says nothing of it.
    const open: McpServer = { scope: { kind: "global" }, name: "tiny", enabled: true, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "http", url: "http://100.104.1.2:8765/mcp" }, env: [], headers: [], updatedAt: "2026-11-22T00:00:00.000Z" };
    expect(testLine({ machineId: "devbox", result: { tools: [{ name: "a" }], via: "tailnet" } }, "devbox", open).text).toBe("Works on devbox through Tailscale: 1 tool, no sign-in needed.");
    expect(testLine({ machineId: "devbox", result: { tools: [{ name: "a" }] } }, "devbox", { ...open, headers: [{ name: "X-Key", kind: "vault", itemId: "V0" }] }).text).toBe("Works on devbox: 1 tool.");
    expect(testLine({ error: "The hub is offline." }, "devbox").text).toBe("Test failed: The hub is offline.");
  });

  it("says where a custom MCP stands only when it needs someone", () => {
    expect(stateOf(server("a", "https://a.example"))).toBeNull();
    expect(stateOf(server("a", "https://a.example", { oauth: signedIn }))).toBeNull();
    expect(stateOf(server("a", "https://a.example", { oauth: { status: "signed_out", issuer: "x" } }))?.text).toBe("Sign in needed");
    expect(stateOf(server("a", "https://a.example", { oauth: { status: "signed_out", issuer: "x", signingIn: true } }))?.text).toBe("Signing in…");
    expect(stateOf(server("a", "https://a.example", { headers: [{ kind: "vault", name: "Authorization", itemId: "V1", problem: "The item was deleted." }] }))?.text).toBe(
      "Authorization missing",
    );
    expect(needsSignIn(server("a", "https://a.example"), { machineId: "devbox", result: { signIn: true } })).toBe(true);
    expect(needsSignIn(server("a", "https://a.example", { oauth: { status: "signed_out", issuer: "x", signingIn: true } }))).toBe(false);
  });

  it("shows a custom MCP's switch off for bots while it waits on a sign-in (F1868)", () => {
    const linear = server("linear", "https://mcp.linear.app/sse", { oauth: { status: "signed_out", issuer: "https://linear.app" } });
    expect(onForBots(linear)).toBe(false);
    expect(onForBots({ ...linear, oauth: signedIn })).toBe(true);
    // A Test that found a sign-in counts too, and a switch turned off stays off once signed in.
    expect(onForBots(server("a", "https://a.example"), { machineId: "devbox", result: { signIn: true } })).toBe(false);
    expect(onForBots({ ...linear, enabled: false, oauth: signedIn })).toBe(false);
  });

  it("splits a command as a shell does and names it after what it runs", () => {
    expect(splitCommand(`npx -y @acme/mcp-server --root "/srv/my docs" 'a b'`)).toEqual(["npx", "-y", "@acme/mcp-server", "--root", "/srv/my docs", "a b"]);
    expect(splitCommand(`run ""`)).toEqual(["run", ""]);
    expect(suggestedName({ kind: "command", url: "", command: "npx -y @modelcontextprotocol/server-github" })).toBe("github");
    expect(suggestedName({ kind: "command", url: "", command: "uvx mcp-server-fetch@1.2" })).toBe("fetch");
    expect(suggestedName({ kind: "url", url: "https://mcp.linear.app/sse", command: "" })).toBe("linear");
    expect(suggestedName({ kind: "url", url: "http://devbox.tail1234.ts.net:8080/mcp", command: "" })).toBe("devbox");
    // An address is named whole, not by its first number.
    expect(suggestedName({ kind: "url", url: "http://100.101.102.103:8765/mcp", command: "" })).toBe("100-101-102-103");
    expect(suggestedName({ kind: "url", url: "http://[fd7a:115c:a1e0::1]:8765/mcp", command: "" })).toBe("fd7a-115c-a1e0-1");
    expect(initialOf("linear")).toBe("L");
    expect(initialOf("_x")).toBe("X");
  });

  it("makes the team's server from the form, with headers from the vault and the bots picked", () => {
    const draft: Draft = {
      ...emptyDraft(),
      url: "http://devbox.tail1234.ts.net:8080/mcp",
      values: [{ name: "Authorization", itemId: "V9", prefix: "Bearer " }],
      bots: [{ machineId: "devbox", projectId: "ada" }],
    };
    const built = toInput(draft, null, ["paper"]);
    expect(built).toEqual({
      ok: true,
      input: {
        scope: TEAM,
        name: "devbox",
        enabled: true,
        roles: { lead: true, writers: true, reviewers: true },
        transport: { type: "http", url: "http://devbox.tail1234.ts.net:8080/mcp" },
        env: [],
        headers: [{ kind: "vault", name: "Authorization", itemId: "V9", prefix: "Bearer " }],
        projects: [{ machineId: "devbox", projectId: "ada" }],
      },
    });
    expect(toInput({ ...emptyDraft(), kind: "command", command: "npx -y @acme/files-mcp", values: [{ name: "TOKEN", itemId: "", prefix: "" }] }, null, [])).toEqual({
      ok: false,
      problem: "Pick TOKEN's value from the vault.",
    });
    expect(toInput({ ...emptyDraft(), url: "ftp://x" }, null, [])).toEqual({ ok: false, problem: "Give its http or https URL." });
    expect(toInput({ ...emptyDraft(), url: "nope" }, null, [])).toEqual({ ok: false, problem: "Name it." });
    expect(toInput({ ...emptyDraft(), url: "https://mcp.paper.design", named: true, name: "Paper" }, null, ["paper"])).toEqual({ ok: false, problem: "Paper is already there." });
  });

  it("edits a saved server as it is: its scope, a sealed secret kept, its bots", () => {
    const saved = server("files", "", {
      scope: { kind: "project", machineId: "devbox", projectId: "ada" },
      transport: { type: "stdio", command: "npx", args: ["-y", "@acme/files", "--root", "/srv/my docs"] },
      env: [{ kind: "secret", name: "TOKEN", sealedOn: [] }],
    });
    const draft = draftOf(saved);
    expect(draft).toMatchObject({ kind: "command", command: `npx -y @acme/files --root "/srv/my docs"`, values: [{ name: "TOKEN", keep: true }] });
    const built = toInput(draft, saved, ["files"]);
    expect(built.ok && built.input).toMatchObject({
      scope: saved.scope,
      transport: { type: "stdio", command: "npx", args: ["-y", "@acme/files", "--root", "/srv/my docs"] },
      env: [{ kind: "keep", name: "TOKEN" }],
    });
    expect(built.ok && "projects" in built.input).toBe(false);
  });

  it("saves a new server again under its own name once its first save went through (a failed Test, then a fixed URL)", () => {
    const draft: Draft = { ...emptyDraft(), url: "http://devbox.tail1234.ts.net:8080/mcp" };
    expect(toInput(draft, null, ["devbox"])).toEqual({ ok: false, problem: "devbox is already there." });
    const first = toInput(draft, null, []);
    if (!first.ok) throw new Error(first.problem);
    const saved = server("devbox", "http://devbox.tail1234.ts.net:8080/mcp");
    const again = toInput({ ...draft, url: "http://devbox.tail1234.ts.net:9090/mcp" }, saved, ["devbox"]);
    expect(again.ok && again.input).toMatchObject({ name: "devbox", transport: { type: "http", url: "http://devbox.tail1234.ts.net:9090/mcp" } });
  });

  it("keeps a plain value as it was, and takes a new one typed in the form", () => {
    const saved = server("files", "", {
      transport: { type: "stdio", command: "files-mcp", args: [] },
      env: [{ kind: "plain", name: "LOG_LEVEL", value: "1" }],
    });
    const draft = draftOf(saved);
    expect(draft.values).toEqual([{ name: "LOG_LEVEL", itemId: "", prefix: "", plain: "1" }]);
    const built = toInput({ ...draft, values: [...draft.values, { name: "REGION", itemId: "", prefix: "", plain: "eu" }] }, saved, ["files"]);
    expect(built.ok && built.input.env).toEqual([
      { kind: "plain", name: "LOG_LEVEL", value: "1" },
      { kind: "plain", name: "REGION", value: "eu" },
    ]);
    expect(toInput({ ...emptyDraft(), url: "https://a.example/mcp", values: [{ name: "X-A", itemId: "", prefix: "", plain: "a\nb" }] }, null, [])).toEqual({
      ok: false,
      problem: "X-A's value can't hold a line break or NUL.",
    });
  });

  it("takes an Authorization key from the vault only, never typed as plain text, keeping one saved plain before", () => {
    const typed = { ...emptyDraft(), url: "https://a.example/mcp", values: [{ name: "Authorization", itemId: "", prefix: "Bearer ", plain: "tok" }] };
    expect(toInput(typed, null, [])).toEqual({ ok: false, problem: "Authorization is a key: pick it from the vault." });
    const old = server("a", "https://a.example/mcp", { headers: [{ kind: "plain", name: "Authorization", value: "Bearer tok" }] });
    const kept = toInput(draftOf(old), old, ["a"]);
    expect(kept.ok && kept.input.headers).toEqual([{ kind: "plain", name: "Authorization", value: "Bearer tok" }]);
    expect(toInput({ ...draftOf(old), values: [{ name: "Authorization", itemId: "", prefix: "", plain: "other" }] }, old, ["a"]).ok).toBe(false);
    const vault = toInput({ ...typed, values: [{ name: "Authorization", itemId: "V1", prefix: "Bearer " }] }, null, []);
    expect(vault.ok && vault.input.headers).toEqual([{ kind: "vault", name: "Authorization", itemId: "V1", prefix: "Bearer " }]);
  });

  it("keeps an edited server's on or off and who gets it: a lead-only one stays the lead's", () => {
    const lead = { lead: true, writers: false, reviewers: false };
    const saved = server("mail", "https://mail.example/mcp", { enabled: false, roles: lead, integration: { readTools: ["list"] } });
    const built = toInput({ ...draftOf(saved), url: "https://mail.example/v2/mcp" }, saved, ["mail"]);
    expect(built.ok && built.input).toMatchObject({ enabled: false, roles: lead, integration: { readTools: ["list"] } });
    const fresh = toInput({ ...emptyDraft(), url: "https://mail.example/mcp" }, null, []);
    expect(fresh.ok && fresh.input).toMatchObject({ enabled: true, roles: { lead: true, writers: true, reviewers: true } });
  });

  it("turns a saved server on or off, keeping its bots, roles and values", () => {
    const lead = { lead: true, writers: false, reviewers: false };
    const saved = server("linear", "https://mcp.linear.app/mcp", { roles: lead, projects: [ada], headers: [{ kind: "vault", name: "Authorization", itemId: "V2", prefix: "Bearer " }] });
    expect(withEnabled(saved, false)).toMatchObject({ enabled: false, roles: lead, projects: [{ machineId: "devbox", projectId: "ada" }], headers: [{ kind: "vault", name: "Authorization", itemId: "V2", prefix: "Bearer " }] });
    expect("projects" in withEnabled(server("x", "https://x.example"), true)).toBe(false);
  });

  it("finds a free name: the suggested one, else the first -n no server has", () => {
    expect(freeName("linear", [])).toBe("linear");
    expect(freeName("linear", ["Linear"])).toBe("linear-2");
    expect(freeName("linear", ["linear", "linear-2"])).toBe("linear-3");
  });

  it("changes only the bots of a saved server", () => {
    const saved = server("linear", "https://mcp.linear.app/mcp", { headers: [{ kind: "vault", name: "Authorization", itemId: "V2", prefix: "Bearer " }], projects: [ada] });
    expect(withBots(saved, undefined)).toEqual({
      scope: TEAM,
      name: "linear",
      enabled: true,
      roles: saved.roles,
      transport: saved.transport,
      env: [],
      headers: [{ kind: "vault", name: "Authorization", itemId: "V2", prefix: "Bearer " }],
    });
    expect(withBots(saved, []).projects).toEqual([]);
  });
});
