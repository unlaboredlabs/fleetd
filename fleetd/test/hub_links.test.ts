import { afterAll, expect, test } from "bun:test";
import { publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { setAskBridge } from "../src/hub/hub_links/bridge.ts";
import { start as startLinks } from "../src/hub/hub_links/loops.ts";
import { found } from "../src/hub/project_lead/bridge.ts";
import { boxKey, checkUrl, linkGrants, reachableUrl, verify } from "../src/hub/hub_links/store.ts";
import { followOnce, retryDelayMs, failedReads } from "../src/hub/hub_links/client.ts";
import { leadWakes } from "../src/hub/api/leads.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { people } from "../src/hub/people/store.ts";
import type { Hub } from "../src/hub/api/hub.ts";
import { refusal, testHub } from "./people-kit.ts";
import { tempHome } from "./helpers.ts";

const homes = [tempHome(), tempHome()];
const done: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const d of done) await d();
  for (const h of homes) h.done();
});

const project = (hub: Hub, machineId: string, projectId: string, title: string) =>
  store(hub).projectsUpsertMany(machineId, [
    { machineId, projectId, title, workspaceRoot: `/w/${projectId}`, lastActivityAt: "2026-11-08T10:00:00.000Z" } as never,
  ]);

// The hub whose projects the link reaches, served over HTTP; its inbox bridge faked.
const there = testHub({ home: homes[0]?.dir });
project(there.hub, "lab-a", "p1", "Site");
let feedItems = [{ handle: "A7", title: "Site", what: "order opened" }];
setAskBridge(there.hub, {
  factoryStatus: () => ({ projects: [{ projectRef: { machineId: "lab-a", projectId: "p1" }, title: "Site", state: "idle", agentsRunning: 0, checklist: [], openOrders: [], asks: [] }] }),
  projectMessage: async () => ({ handle: "A7", projectRef: { machineId: "lab-a", projectId: "p1" }, title: "Site" }),
  feed: (_: string, after: number) => {
    const items = feedItems;
    feedItems = [];
    return { cursor: after + items.length, more: false, items };
  },
});
const server = serve(there.hub, there.tools, 0);
done.push(() => stop(server));
const THERE = `http://127.0.0.1:${server.port}`;

// The hub with the project.
const here = testHub({ home: homes[1]?.dir });
project(here.hub, "devbox", "inbox", "project");
const sent = new Map<string, string>();
setAskBridge(here.hub, {
  mayUse: () => {},
  recordSent: (_from: unknown, _link: string, s: { handle: string }) => (sent.set(s.handle, "H1"), "H1"),
  askSent: (_link: string, remote: string) => (sent.has(remote) ? { handle: sent.get(remote) as string, from: { machineId: "devbox", projectId: "inbox" } } : undefined),
});
const wakes: string[] = [];
leadWakes(here.hub).trigger = (_r, t) => {
  if (t.kind === "line") wakes.push(t.text);
};

const ownerOf = (k: typeof here) => k.device(undefined, people(k.hub).list(false)[0]?.personId, "desk");

test("a minted link acts as its person at no more than operate, through /link/v1 only", async () => {
  const minter = ownerOf(there);
  const minted = await there.call<{ key: string; link: { linkId: string; prefix: string } }>(minter, "hub_link_mint", { label: "work" });
  expect(minted.key).toStartWith("flk_");
  const link = verify(there.hub, `Bearer ${minted.key}`);
  expect(link.who).toBe(minter.person?.name as string);
  expect(link.grants).toEqual([{ role: "operate", machines: "*" }]);
  expect(linkGrants([{ role: "admin", machines: "*" }], "read")).toEqual([{ role: "read", machines: "*" }]);

  const hello = await fetch(`${THERE}/link/v1/hello`, { headers: { authorization: `Bearer ${minted.key}` } });
  expect(await hello.json()).toMatchObject({ label: "work", projects: [{ title: "Site" }], limited: false });
  const bogus = await fetch(`${THERE}/link/v1/hello`, { headers: { authorization: "Bearer flk_nope" } });
  expect(bogus.status).toBe(401);
  expect(await bogus.json()).toMatchObject({ code: "forbidden", message: "This hub knows no such link key.", dead: true });
  const nope = await fetch(`${THERE}/link/v1/frob`, { method: "POST", headers: { authorization: `Bearer ${minted.key}` } });
  expect(nope.status).toBe(404);

  // Revoking the device that minted it revokes the link.
  const phone = there.device(undefined, minter.person?.personId, "phone");
  const second = await there.call<{ key: string }>(phone, "hub_link_mint", { label: "phone" });
  await there.call(minter, "device_revoke", { keyId: phone.keyId });
  const gone = await fetch(`${THERE}/link/v1/hello`, { headers: { authorization: `Bearer ${second.key}` } });
  expect(((await gone.json()) as { message: string }).message).toEndWith("was revoked on this hub.");
});

test("a link added to a project here, sealed to this hub, follows the feed there and wakes the lead", async () => {
  const minter = ownerOf(there);
  const { key } = await there.call<{ key: string }>(minter, "hub_link_mint", { label: "work" });
  const me = ownerOf(here);
  const got = await here.call<{ boxPubKey: string }>(me, "hub_links_get", {});
  expect(Buffer.from(got.boxPubKey, "base64")).toEqual(Buffer.from(publicKeyOf(boxKey(here.hub))));
  const sealed = Buffer.from(seal(Buffer.from(got.boxPubKey, "base64"), new TextEncoder().encode(`${key}\n`))).toString("base64");
  expect((await refusal(here.call(me, "hub_link_add", { project: { machineId: "devbox", projectId: "inbox" }, label: "Work", url: "http://203.0.113.9:4790", sealed }))).message).toBe(
    "http://203.0.113.9:4790 is plain HTTP off a tailnet: the link key would cross the network in the clear.",
  );
  const added = await here.call<{ link: { linkId: string; state: string; who?: string }; projects: unknown[] }>(me, "hub_link_add", {
    project: { machineId: "devbox", projectId: "inbox" },
    label: "Work",
    url: `${THERE}/`,
    sealed,
  });
  expect(added.link.state).toBe("ok");
  expect(added.link.who).toBe(minter.person?.name as string);
  expect(added.projects).toEqual([{ projectRef: { machineId: "lab-a", projectId: "p1" }, title: "Site" }]);
  expect((await refusal(here.call(me, "hub_link_add", { project: { machineId: "devbox", projectId: "inbox" }, label: "work", url: THERE, sealed }))).message).toBe(
    "This project has a linked hub called work already.",
  );

  // What the inbox bridge lists as the project's linked hubs, through the hooks this area's start sets.
  startLinks(here.hub);
  expect(found.linked?.(here.hub, { machineId: "devbox", projectId: "inbox" })).toEqual([{ label: "Work", state: "ok" }]);
  expect(typeof found.ask).toBe("function");

  sent.set("A7", "H1");
  feedItems = [{ handle: "A7", title: "Site", what: "order opened" }];
  const read = await followOnce(here.hub, added.link.linkId, 0);
  expect(read).not.toBe("stop");
  expect(wakes).toContain("- H1 to Site on Work: order opened");

  const removed = await here.call<{ revokedThere: boolean }>(me, "hub_link_remove", { linkId: added.link.linkId });
  expect(removed.revokedThere).toBe(true);
  expect(await followOnce(here.hub, added.link.linkId, 0)).toBe("stop");
});

test("only https, or http to loopback or a tailnet, carries a link key; retries back off to 30 s", () => {
  expect(checkUrl("https://hub.example.com").href).toBe("https://hub.example.com/");
  expect(checkUrl("http://100.100.1.2:4790").hostname).toBe("100.100.1.2");
  expect(checkUrl("http://devbox.tail1234.ts.net:4790").protocol).toBe("http:");
  expect(() => checkUrl("http://192.168.1.2:4790")).toThrow();
  expect(reachableUrl("http://127.0.0.1:4790")).toBeUndefined();
  expect(reachableUrl("https://hub.example.com/")).toBe("https://hub.example.com");
  expect([0, 1, 4, 5, 20].map((a) => retryDelayMs(a, 1))).toEqual([1000, 2000, 16_000, 30_000, 30_000]);
  expect(failedReads(3, 11_000)).toBe(1);
  expect(failedReads(3, 100)).toBe(4);
});
