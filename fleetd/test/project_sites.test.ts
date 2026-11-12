// Projects' list, archive, sites and approvals (tools.rs, sites.rs).
import { expect, test } from "bun:test";
import { pasted, siteOf } from "../src/hub/navi/sites.ts";
import * as kept from "../src/hub/navi/store.ts";
import { events } from "../src/hub/store/events.ts";
import mcpTools from "../../app/desktop/src/shared/contracts/schema/McpTools.json";
import { key, kit, project } from "./work-kit.ts";

function setup() {
  const k = kit();
  k.hub.db.conn.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p-own', 'Own', 'owner', 0), ('p-ada', 'Ada', 'member', 1)");
  const mine = { machineId: "devbox", projectId: "ada-inbox" };
  const shared = { machineId: "devbox", projectId: "app" };
  project(k.hub, mine, { title: "Ada's project" });
  project(k.hub, shared, { title: "App" });
  kept.put(k.hub.db.conn, mine, { keyId: "key_ada", name: "phone" }, 5);
  const ada = key("operate", { human: true, person: { personId: "p-ada", name: "Ada" } });
  return { ...k, mine, shared, ada };
}

test("project_get lists every project; any key that operates archives one and brings it back", async () => {
  const { ok, mine, ada, hub } = setup();
  // Ada's former Only me project is everyone's (D491).
  hub.db.conn.run("UPDATE project_settings SET only_me = 1, owner_person = 'p-ada' WHERE project_id = 'ada-inbox'");
  const ids = (out: { projects: { projectId: string }[] }) => out.projects.map((n) => n.projectId).sort();
  expect(ids(await ok(ada, "project_get", {}))).toEqual(["ada-inbox", "app"]);
  expect(ids(await ok(key("read"), "project_get", {}))).toEqual(["ada-inbox", "app"]);
  const archived = await ok(key("operate"), "project_archive", mine);
  expect(archived.project.archivedAt).toBe("2026-10-17T10:00:00.000Z");
  expect(archived.next).toBe("Its chat, memory and folder stay; project_archive with archived false brings it back.");
  // Archiving again changes nothing.
  expect((await ok(ada, "project_archive", mine)).next).toBeUndefined();
  const back = await ok(ada, "project_archive", { ...mine, archived: false });
  expect([back.project.archivedAt, back.next]).toEqual([undefined, "Its lead starts with the next chat message."]);
  expect(events(hub).page(0).events.map((e) => e.summary)).toEqual(["Ada's project archived", "Ada's project back"]);
  expect(events(hub).page(0).events[0]?.data).toEqual({ title: "Ada's project", archivedAt: "2026-10-17T10:00:00.000Z" });
});

test("sites, their revoke, and approvals only a person sets", async () => {
  const { ok, refused, shared, hub } = setup();
  expect(await ok(key("read"), "project_sites", shared)).toEqual({
    sites: [],
    next: "None yet: its first fetch or visit to a site asks the person, and approving it adds the site.",
  });
  kept.allowSite(hub.db.conn, shared, "example.org", "human:desk", Date.parse("2026-10-17T10:00:00.000Z"));
  kept.allowSite(hub.db.conn, shared, "news.example.com", "human:desk", Date.parse("2026-10-17T10:00:00.000Z"));
  expect((await ok(key("read"), "project_sites", shared)).sites).toEqual([
    { site: "example.org", allowedAt: "2026-10-17T10:00:00.000Z", allowedBy: "human:desk" },
    { site: "news.example.com", allowedAt: "2026-10-17T10:00:00.000Z", allowedBy: "human:desk" },
  ]);
  const revoked = await ok(key("operate"), "project_site_revoke", { ...shared, site: "https://www.Example.org/a?b" });
  expect(revoked.sites.map((s: { site: string }) => s.site)).toEqual(["news.example.com"]);
  expect(revoked.next).toBe("Its next fetch or visit to example.org asks again.");

  expect((await ok(key("read"), "project_approvals", shared)).approvals).toEqual({ mode: "checker", defaults: true, model: "claude-sonnet-5-5", effort: "medium" });
  expect(await refused(key("operate"), "project_approvals_set", { ...shared, mode: "yolo" })).toBe("forbidden");
  const set = await ok(key("operate", { human: true }), "project_approvals_set", { ...shared, mode: "yolo" });
  expect(set.approvals.mode).toBe("yolo");
  expect(await refused(key("operate"), "project_signins_forget", shared)).toBe("machine_offline");
});

test("the site a URL is on, and the sites a message links to", () => {
  expect(siteOf("https://www.Example.org/path?q=1")).toBe("example.org");
  expect(siteOf("example.org.")).toBe("example.org");
  expect(siteOf("localhost:3000/x")).toBe("localhost:3000");
  expect(siteOf("http://127.0.0.1/")).toBe("127.0.0.1:80");
  expect(siteOf("file:///etc/passwd")).toBeUndefined();
  expect(siteOf("https://user@example.org")).toBeUndefined();
  expect(siteOf("javascript:alert(1)")).toBeUndefined();
  expect(pasted("see (https://example.org/a) and HTTPS://example.org. or http://docs.example.com:8080")).toEqual(["example.org", "docs.example.com"]);
});

test("the hub answers no tool name the contract doesn't list, and project_asks needs its project", async () => {
  // So an older app's call by a name that left the contract (the aliases kept for one release, D317) gets an
  // unknown-tool error, and its asks read by the argument's old name is refused rather than read for no project.
  const { tools, call, refused, shared } = setup();
  const contract = new Set(Object.keys(mcpTools.$defs.McpTools.properties).map((k) => k.replace(/\.(input|output)$/u, "")));
  expect(tools.names().filter((name) => !contract.has(name))).toEqual([]);
  const old = await call(key("operate", { human: true }), "project_archive_old", shared);
  expect("error" in old && old.error.kind).toBe("unknown");
  expect(await refused(key("read"), "project_asks", { ...shared })).toBe("invalid");
});
