// hub/work: claims and their ends, the in-flight view, and work_claim / work_list / work_done through the registry
// (crates/fleetd/src/hub/work/tests.rs and tools_tests.rs). The repo is on a host that isn't GitHub.
import { expect, test } from "bun:test";
import type { Hub } from "../src/hub/api/hub.ts";
import type { Caller } from "../src/hub/api/registry.ts";
import { events } from "../src/hub/store/events.ts";
import { parseMs } from "../src/hub/store/time.ts";
import { sweep } from "../src/hub/sweep/index.ts";
import { TaskRecords } from "../src/hub/tasks/records.ts";
import { changeRecords } from "../src/hub/train/index.ts";
import type { NodeGit } from "../src/hub/work/bind.ts";
import { CLAIM_TTL_MS, EXPIRED_SHOWN_MS, type NewClaim, work } from "../src/hub/work/index.ts";
import { landingStore } from "../src/hub/work/landings.ts";
import { start } from "../src/hub/work/loops.ts";
import { repoKeyOf } from "../src/hub/work/repo_key.ts";
import { getClaim, putClaim, type WorkScope } from "../src/hub/work/store.ts";
import { claimOn, listOn, settle } from "../src/hub/work/tools.ts";
import type { Change, HubEventType, ProjectRef, Task, WorkClaimInput } from "../src/shared/contracts.ts";
import { AT, key, kit, project as addProject } from "./work-kit.ts";

const REMOTE = "git@gitlab.example.com:acme/shop.git";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const shop: WorkScope = { repoKey: "gitlab.example.com/acme/shop", base: "main" };
const shopRef: ProjectRef = { machineId: "devbox", projectId: "shop" };

function rig() {
  const k = kit(1_792_922_400_000);
  start(k.hub);
  k.hub.shutdown.abort();
  return k;
}

const operate = (name: string, human = false): Caller => key("operate", { name, human });

function newClaim(scope: WorkScope, title: string): NewClaim {
  return {
    scope,
    owner: { kind: "human_session", keyId: "k7", label: "laptop" },
    title,
    keys: [{ issue: "SHOP-12" }],
    branch: "ada/dark-mode",
    paths: ["app/theme.ts"],
    authorEmail: "ada@example.com",
  };
}

async function eventsOf(hub: Hub, type: HubEventType) {
  return (await events(hub).wait({ cursor: 0, types: [type], timeoutSec: 0 })).events;
}

function task(hub: Hub, r: ProjectRef, title: string, extra: Partial<Task> = {}): Task {
  return TaskRecords.create(hub.db.conn, {
    taskId: "T1",
    projectRef: r,
    workstreamId: "W1",
    title,
    kind: "write",
    prompt: "do it",
    state: "running",
    attempt: 1,
    createdAt: AT,
    ...extra,
  } as Task);
}

function change(hub: Hub, r: ProjectRef, t: Task | undefined, pr: number, state: string, repo = "acme/shop"): Change {
  return changeRecords(hub).create({
    changeId: "X1",
    projectRef: r,
    repo,
    prNumber: pr,
    prUrl: `https://github.com/${repo}/pull/${pr}`,
    branch: t?.branch ?? `pr-${pr}`,
    ...(t ? { taskId: t.taskId } : {}),
    workstreamId: "W1",
    headSha: SHA,
    state,
    reviews: [],
    createdAt: AT,
    updatedAt: AT,
  } as unknown as Change);
}

test("repo keys come from any remote form", () => {
  expect(repoKeyOf("git@github.com:Acme/Shop.git")).toBe("github.com/acme/shop");
  expect(repoKeyOf("https://user@gitlab.example.com/Acme/shop/")).toBe("gitlab.example.com/acme/shop");
  expect(repoKeyOf("ssh://git@host:2222/acme/shop.git")).toBe("host:2222/acme/shop");
  expect(repoKeyOf("/srv/git/shop.git")).toBe("/srv/git/shop");
  expect(repoKeyOf(" ")).toBeUndefined();
});

test("a claim is numbered, good for 12 hours and announced", async () => {
  const { hub } = rig();
  const w = work(hub);
  const claim = w.claim(newClaim(shop, "dark mode toggle in settings"));
  expect([claim.claimId, claim.state, claim.repoKey]).toEqual(["C1", "active", "gitlab.example.com/acme/shop"]);
  expect(parseMs(claim.expiresAt)! - parseMs(claim.createdAt)!).toBe(CLAIM_TTL_MS);
  expect(w.get("C1")).toEqual(claim);
  expect(w.claim(newClaim(shop, "search box")).claimId).toBe("C2");
  const claimed = await eventsOf(hub, "work.claimed");
  expect(claimed.map((e) => e.data)).toMatchObject([
    { claimId: "C1", repoKey: "gitlab.example.com/acme/shop", ownerKind: "human_session", state: "active" },
    { claimId: "C2" },
  ]);
});

test("a renewal extends a claim and keeps what its branch changed", () => {
  const { hub, clock } = rig();
  const w = work(hub);
  const claim = w.claim(newClaim(shop, "dark mode toggle"));
  clock.ms += 3_600_000;
  const observed = { paths: ["app/settings/page.tsx"], headSha: SHA, at: new Date(clock.ms).toISOString() };
  const renewed = w.renew(claim.claimId, observed)!;
  expect(parseMs(renewed.expiresAt)).toBe(clock.ms + CLAIM_TTL_MS);
  expect(renewed.observed).toEqual(observed);
  expect(w.renew(claim.claimId)!.observed).toEqual(observed);
});

test("the sweep expires a claim not renewed, and the view keeps it a day", async () => {
  const { hub, clock } = rig();
  const w = work(hub);
  const stale = w.claim(newClaim(shop, "dark mode toggle"));
  clock.ms += 6 * 3_600_000;
  const fresh = w.claim(newClaim(shop, "search box"));
  clock.ms += 6 * 3_600_000;
  await sweep(hub).runOnce();
  expect([w.get(stale.claimId)!.state, w.get(fresh.claimId)!.state]).toEqual(["expired", "active"]);
  const ended = await eventsOf(hub, "work.ended");
  expect(ended.map((e) => e.data)).toMatchObject([{ claimId: "C1", state: "expired", reason: "not renewed for 12 h" }]);
  await sweep(hub).runOnce();
  expect((await eventsOf(hub, "work.ended")).length).toBe(1);
  expect((await w.inFlight(shop)).map((i) => [i.id, i.state])).toEqual([
    ["C2", "active"],
    ["C1", "expired"],
  ]);
  clock.ms += EXPIRED_SHOWN_MS;
  await sweep(hub).runOnce();
  expect((await w.inFlight(shop)).map((i) => [i.id, i.state])).toEqual([["C2", "expired"]]);
});

test("an ended claim stays ended; revoking an owner releases only its active claims; an expired one renews", async () => {
  const { hub, clock } = rig();
  const w = work(hub);
  const landed = w.claim(newClaim(shop, "dark mode toggle"));
  expect(w.end(landed.claimId, "landed", "landed by hand", SHA)!.end).toEqual({ at: new Date(clock.ms).toISOString(), reason: "landed by hand", landing: SHA });
  expect(w.end(landed.claimId, "released", "again")).toBeUndefined();
  w.claim(newClaim(shop, "search box"));
  expect(w.releaseOwner("k7", "key revoked").map((c) => c.claimId)).toEqual(["C2"]);
  const third = w.claim(newClaim(shop, "theme"));
  clock.ms += CLAIM_TTL_MS;
  expect(w.expireDue()).toBe(1);
  const revived = w.renew(third.claimId)!;
  expect([revived.state, revived.end]).toEqual(["active", undefined]);
  expect((await eventsOf(hub, "work.claimed")).at(-1)?.summary).toBe("C3 is active again: theme");
});

test("an expired claim out of the view is not renewed over work taken since", () => {
  const { hub, clock } = rig();
  const w = work(hub);
  const app = { machineId: "devbox", projectId: "app" };
  w.bindProject(app, shop);
  const taken = w.claim(newClaim(shop, "dark mode toggle"));
  const free = w.claim(newClaim(shop, "search box"));
  const c = getClaim(hub.db.conn, free.claimId)!;
  const { branch: _, ...noBranch } = c;
  putClaim(hub.db.conn, { ...noBranch, keys: [{ issue: "SHOP-99" }] });
  clock.ms += CLAIM_TTL_MS;
  expect(w.expireDue()).toBe(2);
  clock.ms += EXPIRED_SHOWN_MS + 1;
  task(hub, app, "SHOP-12: dark mode, done properly", { createdAt: new Date(clock.ms).toISOString() });
  expect(w.renew(taken.claimId)).toBeUndefined();
  const released = w.get(taken.claimId)!;
  expect([released.state, released.end?.reason]).toEqual(["released", "T1 took the same work after this claim expired"]);
  expect(w.renew(free.claimId)?.state).toBe("active");
});

test("the view reads every project on the repo's base; a writer appears once, its Change taking over until it merges", async () => {
  const { hub } = rig();
  const w = work(hub);
  const github: WorkScope = { repoKey: "github.com/acme/shop", base: "main" };
  const a = { machineId: "devbox", projectId: "shop" };
  const b = { machineId: "laptop", projectId: "shop" };
  const other = { machineId: "devbox", projectId: "docs" };
  w.bindProject(a, github);
  w.bindProject(b, github);
  w.bindProject(other, { repoKey: "github.com/acme/docs", base: "main" });
  const t = task(hub, a, "dark mode toggle", { branch: "fleetd/T1-dark" });
  task(hub, other, "docs page");
  task(hub, b, "reader task", { kind: "read" } as Partial<Task>);
  expect((await w.inFlight(github)).map((i) => [i.id, i.kind])).toEqual([["T1", "task"]]);
  change(hub, a, t, 57, "queued");
  const items = await w.inFlight(github);
  expect(items.map((i) => [i.id, i.kind, i.title, i.taskId])).toEqual([["X1", "change", "dark mode toggle", "T1"]]);
  expect(items[0]?.keys).toEqual([{ pr: "https://github.com/acme/shop/pull/57" }, { branch: "fleetd/T1-dark" }]);
  const done = changeRecords(hub).get("X1")!;
  changeRecords(hub).put({ ...done, state: "merged" });
  expect((await w.inFlight(github)).map((i) => i.id)).toEqual(["T1"]);
});

test("each writer carries the paths it has changed; a node past the timeout leaves it unknown", async () => {
  const { hub } = rig();
  const w = work(hub);
  w.bindProject(shopRef, shop);
  task(hub, shopRef, "dark mode", { threadRef: { machineId: "devbox", threadId: "t1" }, paths: ["app/theme.ts"] } as Partial<Task>);
  w.setPorts({ changedPaths: async () => ["app/header.tsx", "app/theme.ts"] });
  expect((await w.inFlight(shop))[0]?.paths).toEqual(["app/theme.ts", "app/header.tsx"]);
  expect((w.inFlightStored(shop))[0]?.paths).toEqual(["app/theme.ts"]);
  w.setPorts({ changedPaths: () => new Promise(() => {}) });
  const observed = await w.observe(shop, 20);
  expect([...observed.unknown]).toEqual(["T1"]);
  const other = w.matcher.intent({ machineId: "laptop", projectId: "shop" }, shop, "dark mode toggle", "", undefined, ["app/theme.ts"]);
  expect(w.checkObserved(shop, other, observed.paths).map((m) => [m.item.id, m.strength])).toEqual([["T1", "strong"]]);
  expect(w.watches(shop)).toBe(false);
  w.watchAt(shop, SHA);
  expect(w.watches(shop)).toBe(true);
});

test("a claim is made from any remote form, and the same branch again renews it", async () => {
  const k = rig();
  const laptop = operate("laptop");
  const first = await k.ok(laptop, "work_claim", { repo: REMOTE, title: "dark mode toggle in settings", branch: "ada/dark-mode", changed: ["app/theme.ts"], authorEmail: "ada@example.com" });
  expect([first.status, first.message, first.claim.repoKey, first.claim.base, first.claim.owner.kind, first.claim.owner.label]).toEqual([
    "claimed",
    "claimed C1",
    "gitlab.example.com/acme/shop",
    "main",
    "agent_key",
    "laptop",
  ]);
  expect(first.claim.observed.paths).toEqual(["app/theme.ts"]);
  const again = await k.ok(laptop, "work_claim", { repo: REMOTE, title: "dark mode toggle, settings and header", branch: "ada/dark-mode", changed: ["app/theme.ts", "app/header.tsx"] });
  expect([again.status, again.claim.claimId, again.claim.title, again.claim.authorEmail, again.matches]).toEqual([
    "renewed",
    "C1",
    "dark mode toggle, settings and header",
    "ada@example.com",
    [],
  ]);
  expect(again.claim.observed.paths).toEqual(["app/theme.ts", "app/header.tsx"]);
  const list = await k.ok(laptop, "work_list", { repo: "https://gitlab.example.com/Acme/shop" });
  expect(list.scope.repoKey).toBe("gitlab.example.com/acme/shop");
  expect(list.items.map((i: any) => [i.id, i.keys])).toEqual([["C1", [{ branch: "ada/dark-mode" }]]]);
});

const ids = (answer: any) => answer.matches.map((m: any) => [m.item.id, m.strength]);

test("an exact match is taken, and only a human key claims it anyway", async () => {
  const k = rig();
  const [laptop, desktop, robot] = [operate("laptop"), operate("desktop", true), operate("robot")];
  work(k.hub).bindProject(shopRef, shop);
  task(k.hub, shopRef, "search box on the header", { branch: "fleetd/T1-search" });
  const claim = (who: Caller, input: object) => k.ok(who, "work_claim", { repo: REMOTE, ...input });
  await claim(laptop, { title: "dark mode toggle", keys: [{ issue: "SHOP-12" }] });
  const t = await claim(desktop, { title: "header search", branch: "fleetd/T1-search" });
  expect([t.status, t.claim, t.message]).toEqual([
    "taken",
    undefined,
    "taken by T1 (an agent of devbox/shop): search box on the header (same branch fleetd/T1-search; 2 shared words: header, search)",
  ]);
  expect(t.next).toContain("Tell the user");
  const written = await claim(desktop, { title: "SHOP-12: theme switch" });
  expect([written.status, ids(written)[0]]).toEqual(["possible_duplicate", ["C1", "strong"]]);
  const person = await claim(desktop, { title: "theme switch", keys: [{ issue: "SHOP-12" }] });
  expect([person.status, ids(person)[0]]).toEqual(["taken", ["C1", "exact"]]);
  const agent = await claim(robot, { title: "theme switch", keys: [{ issue: "SHOP-12" }], anyway: true });
  expect(agent.status).toBe("taken");
  expect(agent.next).toContain("Only a person can claim taken work, with a human key");
  const own = await claim(robot, { title: "header search", branch: "fleetd/T1-search" });
  expect([own.status, own.message, own.claim, ids(own).some(([id]: string[]) => id === "T1")]).toEqual(["yours", "yours (task T1)", undefined, false]);
  const anyway = await claim(desktop, { title: "theme switch", keys: [{ issue: "SHOP-12" }], anyway: true });
  expect([anyway.status, anyway.claim.claimId, anyway.claim.owner.kind]).toEqual(["claimed", "C2", "human_session"]);
  expect((await eventsOf(k.hub, "work.claimed"))[1]?.summary).toContain("anyway, though C1 holds it");
});

test("a strong match refuses once until notDuplicateOf says why, and weak ones are listed", async () => {
  const k = rig();
  const [laptop, desktop] = [operate("laptop"), operate("desktop")];
  await k.ok(laptop, "work_claim", { repo: REMOTE, title: "dark mode toggle in settings" });
  const strong = await k.ok(desktop, "work_claim", { repo: REMOTE, title: "add a dark mode toggle to the settings page" });
  expect([strong.status, ids(strong)]).toEqual(["possible_duplicate", [["C1", "strong"]]]);
  expect(strong.next).toContain('notDuplicateOf: ["C1"]');
  expect(await k.refused(desktop, "work_claim", { repo: REMOTE, title: "x", notDuplicateOf: ["C1"] })).toBe("invalid");
  const through = await k.ok(desktop, "work_claim", {
    repo: REMOTE,
    title: "add a dark mode toggle to the settings page",
    notDuplicateOf: ["C1"],
    notDuplicateWhy: "C1 is the mobile app's settings",
  });
  expect([through.status, through.message]).toEqual(["claimed", "claimed C2 (not a duplicate of C1: C1 is the mobile app's settings)"]);
  const weak = await k.ok(desktop, "work_claim", { repo: REMOTE, title: "dark sidebar mode" });
  expect(weak.status).toBe("claimed");
  expect(ids(weak)).toContainEqual(["C1", "weak"]);
});

test("a renewal that adds someone else's issue is taken; a human key's may take it anyway", async () => {
  const k = rig();
  const [laptop, desktop, phone] = [operate("laptop"), operate("desktop"), operate("phone", true)];
  const claim = (who: Caller, input: object) => k.ok(who, "work_claim", { repo: REMOTE, ...input });
  await claim(desktop, { title: "checkout totals", keys: [{ issue: "SHOP-9" }] });
  const mine = { title: "dark mode toggle", branch: "ada/dark-mode", keys: [{ issue: "SHOP-12" }] };
  expect((await claim(laptop, mine)).status).toBe("claimed");
  expect((await claim(laptop, mine)).status).toBe("renewed");
  const adds = await claim(laptop, { ...mine, keys: [{ issue: "SHOP-12" }, { issue: "SHOP-9" }], anyway: true });
  expect([adds.status, ids(adds)[0], work(k.hub).get("C2")!.keys.length]).toEqual(["taken", ["C1", "exact"], 1]);
  expect((await claim(phone, { title: "theme switch", branch: "ada/theme" })).status).toBe("claimed");
  const taken = { title: "theme switch", branch: "ada/theme", keys: [{ issue: "SHOP-9" }] };
  expect((await claim(phone, taken)).status).toBe("taken");
  const renewed = await claim(phone, { ...taken, anyway: true });
  expect([renewed.status, renewed.claim.keys]).toEqual(["renewed", [{ issue: "SHOP-9" }]]);
});

test("an expired claim matches as weak only; work_list reads only and takes a project's base", async () => {
  const k = rig();
  const [laptop, desktop] = [operate("laptop"), operate("desktop")];
  await k.ok(laptop, "work_claim", { repo: REMOTE, title: "dark mode toggle", branch: "ada/dark-mode" });
  k.clock.ms += 13 * 3_600_000;
  expect(work(k.hub).expireDue()).toBe(1);
  const after = await k.ok(desktop, "work_claim", { repo: REMOTE, title: "dark mode toggle", branch: "ada/dark-mode" });
  expect([after.status, ids(after)]).toEqual(["claimed", [["C1", "weak"]]]);

  const j = rig();
  work(j.hub).bindProject(shopRef, { ...shop, base: "develop" });
  const made = await j.ok(laptop, "work_claim", { repo: REMOTE, title: "dark mode toggle" });
  expect(made.claim.base).toBe("develop");
  j.clock.ms += 3_600_000;
  const list = await j.ok(laptop, "work_list", { repo: REMOTE });
  expect(list.scope.base).toBe("develop");
  expect(work(j.hub).get("C1")!.expiresAt).toBe(made.claim.expiresAt);
  expect((await j.ok(laptop, "work_claim", { repo: REMOTE, title: "dark mode toggle" })).status).toBe("renewed");
  expect(work(j.hub).get("C1")!.expiresAt).not.toBe(made.claim.expiresAt);
  expect((await j.ok(laptop, "work_list", { repo: REMOTE, base: "main" })).items).toEqual([]);
});

test("work_list shows what landed outside the train in the last day", async () => {
  const k = rig();
  const laptop = operate("laptop");
  expect((await k.ok(laptop, "work_list", { repo: REMOTE })).recentLandings).toEqual([]);
  const now = 1_792_922_400_000;
  const w = work(k.hub);
  (w as any).landingSource = {
    outside: (_s: WorkScope, since: number, limit: number) =>
      [
        { sha: "a".repeat(40), atMs: now - 60_000, route: "direct_push", subject: "feat: dark mode toggle", authorEmail: "ada@example.com", covers: ["P5"] },
        { sha: "b".repeat(40), atMs: now - 25 * 3_600_000, route: "pr_outside", pr: "#57", subject: "fix: older than a day", covers: [] },
      ]
        .filter((l) => l.atMs >= since)
        .slice(0, limit),
  };
  expect((await k.ok(laptop, "work_list", { repo: REMOTE, paths: false })).recentLandings).toEqual([
    { sha: "a".repeat(40), at: "2026-10-25T09:59:00.000Z", route: "direct_push", subject: "feat: dark mode toggle", authorEmail: "ada@example.com", covers: ["P5"] },
  ]);
});

test("a call names a repo or a known project; work_done ends the owner's claim and a human key may end anyone's", async () => {
  const k = rig();
  const [laptop, robot, phone] = [operate("laptop"), operate("robot"), operate("phone", true)];
  expect(await k.refused(laptop, "work_list", {})).toBe("invalid");
  expect(await k.refused(laptop, "work_claim", { projectRef: shopRef, title: "x" })).toBe("not_found");
  const bad = await k.call(laptop, "work_list", { repo: " " });
  expect("error" in bad && bad.error.kind === "tool" && bad.error.error.message).toContain("is not a git remote");
  await k.ok(laptop, "work_claim", { repo: REMOTE, title: "dark mode toggle" });
  await k.ok(laptop, "work_claim", { repo: REMOTE, title: "search box" });
  expect(await k.refused(robot, "work_done", { claimId: "C1", outcome: "landed" })).toBe("forbidden");
  const landed = await k.ok(laptop, "work_done", { claimId: "C1", outcome: "landed", landing: SHA });
  expect([landed.claim.state, landed.claim.end.landing]).toEqual(["landed", SHA]);
  const twice = await k.call(laptop, "work_done", { claimId: "C1", outcome: "dropped" });
  expect("error" in twice && twice.error.kind === "tool" && twice.error.error.message).toContain("already ended: landed");
  const dropped = await k.ok(phone, "work_done", { claimId: "C2", outcome: "dropped", reason: "done in another PR" });
  expect([dropped.claim.state, dropped.claim.end.reason]).toEqual(["released", "done in another PR"]);
  expect(await k.refused(laptop, "work_done", { claimId: "C9", outcome: "dropped" })).toBe("not_found");
  expect((await eventsOf(k.hub, "work.ended")).length).toBe(2);
});

test("a claim saved while another was checked refuses it", async () => {
  const k = rig();
  const [laptop, desktop] = [operate("laptop"), operate("desktop")];
  const before = await work(k.hub).inFlight(shop);
  expect((await k.ok(laptop, "work_claim", { repo: REMOTE, title: "theme switch", branch: "ada/dark-mode" })).status).toBe("claimed");
  const input = { repo: REMOTE, title: "dark mode toggle", branch: "ada/dark-mode" } as WorkClaimInput;
  const second = settle(k.hub, desktop, input, shop, before);
  expect([second.status, second.claim, second.matches[0]?.item.id, work(k.hub).get("C2")]).toEqual(["taken", undefined, "C1", undefined]);
  expect(settle(k.hub, desktop, { repo: REMOTE, title: "search box", branch: "ada/search" } as WorkClaimInput, shop, before).status).toBe("claimed");
});

/** A node's git in a checkout of `remote` whose origin/HEAD is main; undefined stands for a node that is away. */
const fakeGit = (remote: string | undefined): NodeGit => ({
  async git(_m, _cwd, args) {
    if (remote === undefined) return undefined;
    if (args.includes("remote.origin.url")) return { code: 0, out: `${remote}\n` };
    if (args.includes("refs/remotes/origin/HEAD")) return { code: 0, out: "origin/main\n" };
    return { code: 1, out: "" };
  },
});

test("a repo no project is bound to reads the caller's unbound projects first", async () => {
  const k = rig();
  const [desktop, laptop] = [operate("desktop", true), operate("laptop", true)];
  addProject(k.hub, shopRef, { workspaceRoot: "/work/shop" });
  task(k.hub, shopRef, "search box on the header", { branch: "fleetd/T1-search" });
  expect(work(k.hub).scopeOf(shopRef)).toBeUndefined();
  const input = { repo: "https://gitlab.example.com/acme/shop", title: "header search", branch: "fleetd/T1-search" } as WorkClaimInput;
  const away = await claimOn(k.hub, desktop, input, fakeGit(undefined));
  expect([away.status, away.warning]).toEqual(["claimed", "no project bound to gitlab.example.com/acme/shop yet; agents' work may be missing"]);
  const back = await claimOn(k.hub, laptop, input, fakeGit(REMOTE));
  expect(work(k.hub).scopeOf(shopRef)).toEqual(shop);
  expect([back.status, back.matches.some((m) => m.item.id === "T1"), back.warning]).toEqual(["taken", true, undefined]);
  const listed = await listOn(k.hub, laptop, { repo: REMOTE }, fakeGit(undefined));
  expect([listed.warning, listed.items.some((i) => i.id === "T1")]).toEqual([undefined, true]);
});

test("the digest shows work elsewhere on its repo and base, and none of its own", () => {
  const { hub, clock } = rig();
  const w = work(hub);
  const ref = (projectId: string) => ({ machineId: "devbox", projectId });
  const [app, api, docs] = [ref("app"), ref("api"), ref("docs")];
  w.setLandings(landingStore(hub.db.conn));
  expect(w.elsewhere(app)).toBeUndefined();
  w.bindProject(app, shop);
  expect(w.elsewhere(app)).toEqual([]);
  w.bindProject(api, shop);
  w.bindProject(docs, { ...shop, base: "release" });
  const later = { createdAt: new Date(clock.ms + 3_600_000).toISOString() };
  task(hub, app, "own writer: settings page", later);
  const theirs = task(hub, api, "rate limits on the search API", later);
  task(hub, docs, "release notes", later);
  const lead = (r: ProjectRef) => ({ kind: "lead" as const, keyId: `${r.machineId}/${r.projectId}` });
  const claim = (owner: NewClaim["owner"], title: string, keys: NewClaim["keys"] = []) => w.claim({ scope: shop, owner, title, keys, paths: [] }).claimId;
  claim(lead(app), "held back by this lead");
  claim(lead(api), "checkout retries");
  const gone = claim({ kind: "agent_key", keyId: "k9" }, "an old experiment");
  putClaim(hub.db.conn, { ...getClaim(hub.db.conn, gone)!, expiresAt: "2026-10-24T00:00:00.000Z" });
  w.expireDue();
  clock.ms += 60_000;
  const human = claim({ kind: "human_session", keyId: "k7", label: "laptop" }, "dark mode toggle in settings", [{ issue: "SHOP-12" }]);
  const landing = (sha: string, atMs: number, route: "train" | "pr_outside" | "direct_push", subject: string, extra = {}) =>
    w.recordLanding(
      { repoKey: shop.repoKey, base: "main", sha: sha.padEnd(40, "0"), at: new Date(atMs).toISOString(), seenAt: AT, route, subject, paths: [], claimIds: [], ...extra },
      sha,
      app,
    );
  landing("0ld0000", clock.ms - 25 * 3_600_000, "direct_push", "too old");
  landing("fed9876", clock.ms - 120_000, "pr_outside", "Search box on the catalog", { prNumber: 57, authorEmail: "ada@example.com" });
  landing("7a1b000", clock.ms - 90_000, "train", "by the train");
  landing("abc1234", clock.ms - 60_000, "direct_push", "feat: dark mode toggle", { authorEmail: "ada@example.com", taskId: "P9" });
  expect(w.elsewhere(app)).toEqual([
    `- ${human} claimed by a person (laptop): dark mode toggle in settings · on SHOP-12`,
    `- ${theirs.taskId} writer of devbox/api, running: rate limits on the search API`,
    "- C2 claimed by the lead of devbox/api: checkout retries",
    "- abc1234 pushed straight to main, outside fleetd by ada@example.com: feat: dark mode toggle · covers P9",
    "- fed9876 PR #57 merged outside fleetd by ada@example.com: Search box on the catalog",
    `- ${gone} expired claim by an agent key: an old experiment`,
  ]);
  const apiView = w.elsewhere(api)!.join("\n");
  expect(apiView).toContain("writer of devbox/app, running: own writer: settings page");
  expect(apiView).toContain("C1 claimed by the lead of devbox/app");
  expect(apiView).not.toContain("C2 ");
});
