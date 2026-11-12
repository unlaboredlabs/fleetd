import { expect, test } from "bun:test";
import { allows, stripBearer } from "../src/hub/auth/allows.ts";
import { CallFailed, readAnswer } from "../src/hub/hub_links/answers.ts";
import { linkAllows, statusOf } from "../src/hub/hub_links/links.ts";
import { offersSignIn, type Net } from "../src/hub/mcp_oauth/flow.ts";
import { escape } from "../src/hub/mcp_oauth/page.ts";
import { due, recordText } from "../src/hub/mcp_oauth/record.ts";
import { newSince, oneSwitch } from "../src/hub/mcp_servers/model.ts";
import { checkScope, mayChange, sameTransport } from "../src/hub/mcp_servers/rules.ts";

const key = (kind: string, role: "read" | "operate" | "admin", machines: "*" | string[]) => ({ kind, grants: [{ role, machines }] }) as never;

test("an MCP server's role switch, a lead's new servers, its scope and who may change it", () => {
  expect(oneSwitch({ lead: false, writers: true, reviewers: false }, true)).toEqual({ roles: { lead: true, writers: true, reviewers: true }, enabled: true });
  expect(newSince({ userServers: true, servers: { a: "1", b: "2" } }, { userServers: true, servers: { a: "1", b: "0" } })).toEqual(["b"]);
  expect(checkScope({ kind: "project", machineId: "m", projectId: "p", extra: 1 })).toEqual({ kind: "project", machineId: "m", projectId: "p" });
  expect(() => checkScope({ kind: "team" })).toThrow("scope is");
  expect(() => mayChange(key("human", "operate", ["m"]), { kind: "project", machineId: "m", projectId: "p" })).not.toThrow();
  expect(() => mayChange(key("human", "operate", "*"), { kind: "global" })).toThrow("only the hub's owners and admins");
  expect(() => mayChange(key("agent", "admin", "*"), { kind: "global" })).toThrow("Only a person");
  expect(sameTransport({ type: "stdio", command: "x" }, { type: "stdio", command: "x", args: [] })).toBe(true);
  expect(sameTransport({ type: "http", url: "https://a" }, { type: "sse", url: "https://a" })).toBe(false);
});

test("a sign-in renews in the last half of its lifetime, and its record is written in serde's order", () => {
  expect(due({ expiresMs: 10_000, lifetimeMs: 4_000 }, 7_000)).toBe(false);
  expect(due({ expiresMs: 10_000, lifetimeMs: 4_000 }, 8_000)).toBe(true);
  expect(due({}, 0)).toBe(false);
  expect(Object.keys(JSON.parse(recordText({ told: true })))).toEqual(["client", "expiresMs", "lifetimeMs", "pushed", "failingSinceMs", "retryMs", "told", "pending"]);
  expect(escape(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

test("the OAuth flow reaches a server only through the Net it is given", async () => {
  const seen: string[] = [];
  const net = (answer: Response): Net => ({
    version: "1.2.3",
    http: async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url} ${String(init?.body ?? "")}`);
      return answer.clone() as Response;
    },
  });
  const challenge = new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.devbox/.well-known/oauth-protected-resource"' } });
  expect(await offersSignIn("https://mcp.devbox/mcp", false, net(challenge))).toBe(true);
  expect(seen[0]).toContain('"version":"1.2.3"');
  expect(await offersSignIn("https://mcp.devbox/mcp", false, net(new Response("{}", { status: 200 })))).toBe(false);
});

test("a link's call answer, its grants, and the status a refusal is sent with", () => {
  const ok = { status: 200, statusText: "OK", ok: true };
  expect(readAnswer(ok, new TextEncoder().encode('{"a":1}'))).toEqual({ a: 1 });
  const dead = () => readAnswer({ status: 401, statusText: "", ok: false }, new TextEncoder().encode('{"code":"forbidden","message":"gone","dead":true}'));
  expect(dead).toThrow(CallFailed);
  try {
    dead();
  } catch (e) {
    expect((e as CallFailed).failure.kind).toBe("dead");
  }
  expect(() => readAnswer({ status: 502, statusText: "Bad Gateway", ok: false }, new TextEncoder().encode("<html>"))).toThrow("without fleetd's own words");
  const link = { linkId: "l", label: "x", who: "w", grants: [{ role: "operate", machines: ["m"] }] } as never;
  expect([linkAllows(link, "read", "m"), linkAllows(link, "admin", "m"), linkAllows(link, "read", "n")]).toEqual([true, false, false]);
  expect([statusOf("not_found"), statusOf("unknown" as never)]).toEqual([404, 500]);
  expect(stripBearer("bearer   fld_x ")).toBe("fld_x");
  expect(allows({ grants: [{ role: "admin", machines: "*" }] } as never, "operate", "m")).toBe(true);
});
