// Navis' and projects' list, archive, sites and approvals (crates/fleetd/src/hub/navi/mod.rs, tools.rs, sites.rs).
import { expect, test } from "bun:test";
import { pasted, siteOf } from "../src/hub/navi/sites.ts";
import * as navis from "../src/hub/navi/store.ts";
import { events } from "../src/hub/store/events.ts";
import { key, kit, project } from "./work-kit.ts";

function setup() {
  const k = kit();
  k.hub.db.conn.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p-own', 'Own', 'owner', 0), ('p-ada', 'Ada', 'member', 1)");
  const mine = { machineId: "devbox", projectId: "ada-navi" };
  const shared = { machineId: "devbox", projectId: "app" };
  project(k.hub, mine, { title: "Ada's Navi" });
  project(k.hub, shared, { title: "App" });
  navis.put(k.hub.db.conn, mine, { keyId: "key_ada", name: "phone" }, "p-ada", 5);
  const ada = key("operate", { human: true, person: { personId: "p-ada", name: "Ada" } });
  return { ...k, mine, shared, ada };
}

test("a Navi is listed for its owner alone, and archives and comes back", async () => {
  const { ok, refused, mine, ada, hub } = setup();
  expect((await ok(ada, "navi_list", {})).navis.map((n: { projectId: string }) => n.projectId)).toEqual(["ada-navi"]);
  // The hub's owner (an agent key) sees none of Ada's.
  expect(await ok(key("read"), "navi_list", {})).toEqual({ navis: [], next: "No Only me projects yet: project_add with onlyMe makes one." });
  expect(await refused(key("operate"), "project_archive", mine)).toBe("forbidden");
  const archived = await ok(ada, "project_archive", mine);
  expect(archived.navi.archivedAt).toBe("2026-10-17T10:00:00.000Z");
  expect(archived.next).toBe("Its chat, memory and folder stay; navi_archive with archived false brings it back.");
  expect((await ok(ada, "navi_list", {})).navis).toEqual([]);
  expect((await ok(ada, "navi_list", { archived: true })).navis.length).toBe(1);
  // Archiving again changes nothing.
  expect((await ok(ada, "navi_archive", mine)).next).toBeUndefined();
  const back = await ok(ada, "navi_archive", { ...mine, archived: false });
  expect([back.navi.archivedAt, back.next]).toEqual([undefined, "Its lead starts with the next chat message."]);
  expect(events(hub).page(0).events.map((e) => e.summary)).toEqual(["Ada's Navi archived", "Ada's Navi back"]);
  expect(events(hub).page(0).events[0]?.data).toEqual({ kind: "assistant", title: "Ada's Navi", archivedAt: "2026-10-17T10:00:00.000Z" });
});

test("sites, their revoke, and approvals only a person sets", async () => {
  const { ok, refused, shared, hub } = setup();
  expect(await ok(key("read"), "project_sites", shared)).toEqual({
    sites: [],
    next: "None yet: its first fetch or visit to a site asks the person, and approving it adds the site.",
  });
  navis.allowSite(hub.db.conn, shared, "example.org", "human:desk", Date.parse("2026-10-17T10:00:00.000Z"));
  navis.allowSite(hub.db.conn, shared, "news.example.com", "human:desk", Date.parse("2026-10-17T10:00:00.000Z"));
  expect((await ok(key("read"), "navi_sites", shared)).sites).toEqual([
    { site: "example.org", allowedAt: "2026-10-17T10:00:00.000Z", allowedBy: "human:desk" },
    { site: "news.example.com", allowedAt: "2026-10-17T10:00:00.000Z", allowedBy: "human:desk" },
  ]);
  const revoked = await ok(key("operate"), "project_site_revoke", { ...shared, site: "https://www.Example.org/a?b" });
  expect(revoked.sites.map((s: { site: string }) => s.site)).toEqual(["news.example.com"]);
  expect(revoked.next).toBe("Its next fetch or visit to example.org asks again.");

  expect((await ok(key("read"), "project_approvals", shared)).approvals).toEqual({ mode: "checker", defaults: true, model: "claude-sonnet-5-5", effort: "medium" });
  expect(await refused(key("operate"), "project_approvals_set", { ...shared, mode: "yolo" })).toBe("forbidden");
  const set = await ok(key("operate", { human: true }), "navi_approvals_set", { ...shared, mode: "yolo" });
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
