// Move to the cloud (src/hub/transfer/move.ts) against a stand-in for fleetd cloud's owner routes, in memory: the
// pause and its undo, the upload in pieces with a cut waited out and a dropped upload sent again, each way it stops
// (a cut too long, a team with data, too big, an older cloud, the sign-in gone, the cloud's import failing, a restart)
// leaving the hub as it was and its pause lifted, and the machines' hand-off: a code over each linked node's link, a
// machine offline handed over once it links, a node too old updated first. Never the real cloud.
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { leadWiring } from "../src/hub/leads/ports.ts";
import { start as startMove } from "../src/hub/transfer/loops.ts";
import { MOVE_FILE, mover, type MoveDeps } from "../src/hub/transfer/move.ts";
import { checkExport, exportKey } from "../src/hub/transfer/import.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { automations } from "../src/hub/automations/index.ts";
import { CAP_REJOIN } from "../src/shared/node_link.ts";
import type { HubMove, Machine } from "../src/shared/contracts.ts";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { open, place, stateOf, type Opened, type Place } from "./transfer-kit.ts";
import { PROJECT } from "./hub-helpers.ts";
import { tempHome } from "./helpers.ts";
import { loadOrCreateBoxKey } from "../src/shared/sealed_box.ts";

const TEAM = "https://acme.fleetd.test";
const KEY = "fld_ownerkeyofthetestteam0000";
const RUN = "11111111-2222-4333-8444-555555555555";

type Reply = { status: number; body?: unknown };

/** fleetd cloud's transfer routes for one empty team, and the knobs a test turns. */
function fakeCloud() {
  const dir = tempHome().dir;
  const c = {
    pieces: new Map<number, Uint8Array>(),
    runs: 0,
    runState: "none" as "none" | "uploading" | "queued" | "done" | "failed",
    passphrase: undefined as string | undefined,
    dropped: [] as string[],
    calls: [] as string[],
    /** Answers before the route's own: by "METHOD path" prefix, used once each. */
    once: [] as [string, Reply | "cut"][],
    /** Every call to a route starting so is cut (no answer) while this is set. */
    cut: undefined as string | undefined,
    begin: { pieceBytes: 4096 } as { pieceBytes: number; maxBytes?: number; migrations?: string[] },
    outcome: { state: "done", summary: { machines: [] as { machineId: string; name: string }[], skipped: [] as string[] } } as Record<string, unknown>,
    joined: new Set<string>(),
    minted: 0,
    auth: [] as string[],
    secretsOpened: false,
    /** The start lands, then its answer is cut off. */
    startLost: false,
  };
  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    const path = url.slice(TEAM.length);
    const route = `${method} ${path}`;
    c.calls.push(route);
    c.auth.push(String((init.headers as Record<string, string>).authorization));
    if (c.cut !== undefined && route.startsWith(c.cut)) throw new TypeError("fetch failed: connection reset");
    const at = c.once.findIndex(([p]) => route.startsWith(p));
    if (at >= 0) {
      const [, reply] = c.once.splice(at, 1)[0]!;
      if (reply === "cut") throw new TypeError("fetch failed: connection reset");
      return json(reply.status, reply.body);
    }
    if (route === "POST /transfer/v1/imports") {
      c.runs++;
      c.pieces.clear();
      c.runState = "uploading";
      return json(201, { runId: RUN, ...c.begin });
    }
    const piece = /^PUT \/transfer\/v1\/imports\/[^/]+\/(\d+)$/.exec(route);
    if (piece) {
      if (c.runState !== "uploading") return json(409, { code: "conflict", message: "This import takes no more pieces: it was started or it ended.", fix: "Read it." });
      c.pieces.set(Number(piece[1]), new Uint8Array(init.body as Uint8Array));
      return json(200, { runId: RUN, pieces: c.pieces.size });
    }
    if (route.endsWith("/start") && method === "POST") {
      c.passphrase = (init.headers as Record<string, string>)["fleetd-export-passphrase"];
      const parts = [...c.pieces.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
      const file = join(dir, "uploaded.tar");
      writeFileSync(file, Buffer.concat(parts));
      const checked = await checkExport(file);
      c.secretsOpened = c.passphrase !== undefined && exportKey(checked, c.passphrase) !== null;
      c.runState = c.outcome.state === "done" ? "done" : "failed";
      if (c.startLost) {
        c.startLost = false;
        throw new TypeError("fetch failed: connection reset");
      }
      return json(202, { runId: RUN, state: "queued", secrets: c.secretsOpened });
    }
    if (method === "DELETE") {
      c.dropped.push(path);
      c.runState = "failed";
      return json(204);
    }
    if (route.startsWith("GET /transfer/v1/runs/")) return json(200, c.runState === "uploading" ? { runId: RUN, state: "uploading" } : { runId: RUN, ...c.outcome });
    if (route.endsWith("/rejoin")) {
      const machines = ((c.outcome.summary as { machines?: { machineId: string; name: string }[] })?.machines ?? []).map((m) => ({
        ...m,
        joined: c.joined.has(m.machineId),
        ...(method === "POST" && !c.joined.has(m.machineId) ? { code: `fle_code${++c.minted}` } : {}),
      }));
      return json(200, { hubUrl: TEAM, machines });
    }
    return json(404, { code: "not_found", message: `no route ${route}` });
  };
  return { c, fetch };
}

const machine = (machineId: string): Machine => ({ machineId, name: machineId, nodeVersion: "1", status: "online", lastSeenAt: "2026-10-17T10:00:00Z" });

type Kit = { p: Place; o: Opened; cloud: ReturnType<typeof fakeCloud>; sent: { machineId: string; frame: Record<string, unknown> }[]; linked: Set<string>; caps: Map<string, string[]>; nodeAnswer: (id: string) => Record<string, unknown> };
let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) {
    k.o.close();
    k.p.done();
  }
  kits = [];
});

async function kit(opts: { machines?: string[] } = {}): Promise<Kit> {
  const p = place();
  const o = await open(p);
  // A hub has its box key from its first start.
  loadOrCreateBoxKey(p.home);
  const cloud = fakeCloud();
  const sent: Kit["sent"] = [];
  const linked = new Set<string>(opts.machines ?? []);
  const caps = new Map<string, string[]>((opts.machines ?? []).map((m) => [m, [CAP_REJOIN]]));
  for (const m of opts.machines ?? []) store(o.hub).machineUpsert(machine(m));
  const k: Kit = { p, o, cloud, sent, linked, caps, nodeAnswer: () => ({ ok: true, message: "enrolled" }) };
  // The machines' links, as the link server answers for them.
  o.hub.area("node_port", () => ({
    linked: (m: string) => linked.has(m),
    onLink: (m: string) => linked.has(m),
    can: (m: string, cap: string) => linked.has(m) && (caps.get(m) ?? []).includes(cap),
    request: async (m: string, frame: Record<string, unknown>) => {
      sent.push({ machineId: m, frame });
      return k.nodeAnswer(m);
    },
    call: async () => ({}),
    pending: () => undefined,
  }));
  const deps: MoveDeps = {
    fetch: cloud.fetch,
    // A wait moves the test's clock: a cut "lasts" as long as the waits it took.
    sleep: async (ms) => {
      o.clock.ms += ms;
      await Bun.sleep(0);
    },
    passphrase: () => "a-passphrase-the-hub-made-itself-000000000",
    version: "1.2.3",
    cutMs: 60_000,
    pollMs: 1_000,
    kdfN: 1024,
  };
  o.hub.area("hub_move_deps", () => deps);
  kits.push(k);
  return k;
}

const start = (k: Kit) => mover(k.o.hub).start({ url: TEAM, key: KEY, team: "acme" });

/** Waits until the move's status passes `ok`. */
async function until(k: Kit, ok: (m: HubMove) => boolean, what = "the move"): Promise<HubMove> {
  for (let i = 0; i < 2000; i++) {
    const m = mover(k.o.hub).status();
    if (ok(m)) return m;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(mover(k.o.hub).status())}`);
}

const ended = (m: HubMove) => m.phase === "done" || m.phase === "failed";

test("a move pauses the workspace at once, uploads its export in pieces under a passphrase it made, and stays paused once done", async () => {
  const k = await kit();
  await k.o.call(k.o.device().caller, "vault_item_create", { kind: "login", label: "Shop", sites: ["shop.example"], fields: { username: "a", password: "b" } }).catch(() => undefined);
  const first = start(k);
  expect(first.phase).toBe("packing");
  expect(first.paused?.team).toBe("acme");
  expect(mover(k.o.hub).hold()).toBe("this workspace is moving to fleetd cloud (acme)");
  const done = await until(k, ended);
  expect(done.phase).toBe("done");
  expect(done.paused).toBeDefined();
  expect(mover(k.o.hub).hold()).toBe("this workspace moved to fleetd cloud (acme)");
  // Every call carried the owner's key; the passphrase went in the start's header only, and opens the export's secrets.
  expect(k.cloud.c.auth.every((a) => a === `Bearer ${KEY}`)).toBe(true);
  expect(k.cloud.c.secretsOpened).toBe(true);
  expect(k.cloud.c.calls.some((c) => c.includes("passphrase"))).toBe(false);
  expect(k.cloud.c.pieces.size).toBeGreaterThan(1);
  // The pause is kept across a restart, the key in it sealed.
  const kept = await Bun.file(join(k.p.home, MOVE_FILE)).text();
  expect(kept).not.toContain(KEY);
  expect(kept).toContain('"done": true');
});

test("Undo lifts the pause: leads, agents and automations run here again", async () => {
  const k = await kit();
  startMove(k.o.hub);
  start(k);
  await until(k, ended);
  const hooks = leadWiring(k.o.hub).hooks;
  expect(hooks.moved?.()).toBe("this workspace moved to fleetd cloud (acme)");
  expect(hooks.usageHold?.({ machineId: "devbox", threadId: "t" })).toBe("this workspace moved to fleetd cloud (acme)");
  let cleared = false;
  void hooks.whenClear?.({ machineId: "devbox", threadId: "t" }).then(() => (cleared = true));
  await Bun.sleep(5);
  expect(cleared).toBe(false);
  const after = await k.o.call(k.o.device().caller, "hub_move_resume");
  expect(after.move.phase).toBe("idle");
  expect(after.move.paused).toBeUndefined();
  await Bun.sleep(5);
  expect(cleared).toBe(true);
  expect(hooks.moved?.()).toBeUndefined();
});

test("a moved workspace's automations skip their runs, saying why", async () => {
  const k = await kit();
  store(k.o.hub).projectsUpsertMany(PROJECT.machineId, [{ projectId: PROJECT.projectId, title: "Shop", workspaceRoot: "/w/shop", lastActivityAt: "2026-10-17T10:00:00Z", repos: [] } as never]);
  const [a] = automations(k.o.hub).create({ projectRef: PROJECT, name: "nightly", prompt: "check", webhook: true, by: "human" } as never);
  start(k);
  await until(k, ended);
  const run = await automations(k.o.hub).run(a.automationId, { kind: "webhook", payload: "x" });
  expect(run.state).toBe("skipped");
  expect(run.why).toBe("this workspace moved to fleetd cloud (acme)");
});

test("a cut mid-upload is waited out and the same piece is sent again", async () => {
  const k = await kit();
  k.cloud.c.once.push(["PUT /transfer/v1/imports/", "cut"], ["PUT /transfer/v1/imports/", "cut"]);
  start(k);
  const done = await until(k, ended);
  expect(done.phase).toBe("done");
  expect(k.cloud.c.runs).toBe(1);
  const puts = k.cloud.c.calls.filter((c) => c.startsWith("PUT"));
  expect(puts[0]).toBe(puts[1]);
  expect(puts[1]).toBe(puts[2]);
});

test("an upload the cloud dropped goes up again from its first piece", async () => {
  const k = await kit();
  k.cloud.c.once.push(["PUT /transfer/v1/imports/11111111-2222-4333-8444-555555555555/2", { status: 404, body: { code: "not_found", message: "No such run of this team.", fix: "Start the import again." } }]);
  start(k);
  expect((await until(k, ended)).phase).toBe("done");
  expect(k.cloud.c.runs).toBe(2);
});

/** A move that stops: the line and way forward it says, and the hub as it was with its pause lifted. */
async function stops(setup: (k: Kit) => void, reason: string) {
  const k = await kit();
  setup(k);
  const before = stateOf(k.p);
  start(k);
  const m = await until(k, ended);
  expect(m.phase).toBe("failed");
  expect(m.failure?.reason).toBe(reason);
  expect(m.failure?.message.length).toBeGreaterThan(10);
  expect(m.failure?.fix.length).toBeGreaterThan(5);
  expect(m.paused).toBeUndefined();
  expect(mover(k.o.hub).hold()).toBeUndefined();
  expect(stateOf(k.p)).toEqual(before);
  return { k, m };
}

test("a cut longer than the move waits out stops it, the upload given up and the workspace as it was", async () => {
  const { k, m } = await stops((k) => (k.cloud.c.cut = "PUT"), "offline");
  expect(m.failure?.fix).toContain("internet connection");
  k.cloud.c.cut = undefined;
  await Bun.sleep(5);
  expect(k.cloud.c.dropped).toEqual([`/transfer/v1/imports/${RUN}`]);
});

test("a team that already has data refuses the move: it says to move into a new team", async () => {
  const { k, m } = await stops(
    (k) => k.cloud.c.once.push(["POST /transfer/v1/imports", { status: 409, body: { code: "conflict", reason: "not_empty", message: "This team already has data.", fix: "Import into a new team." } }]),
    "not_empty",
  );
  expect(m.failure?.message).toBe("acme already has bots or data, and a workspace moves only into an empty team.");
  expect(k.cloud.c.pieces.size).toBe(0);
});

test("a workspace too big for the team is refused before a piece goes up", async () => {
  const { k } = await stops((k) => (k.cloud.c.begin = { pieceBytes: 4096, maxBytes: 1000 }), "too_large");
  expect(k.cloud.c.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  expect(k.cloud.c.dropped.length).toBe(1);
});

test("a cloud on an older fleetd than the workspace is said before the upload", async () => {
  const { m, k } = await stops((k) => (k.cloud.c.begin = { pieceBytes: 4096, migrations: MIGRATIONS.slice(0, 3).map((x) => x.name) }), "newer");
  expect(m.failure?.fix).toContain("Try again later");
  expect(k.cloud.c.calls.some((c) => c.startsWith("PUT"))).toBe(false);
});

test("a sign-in that lapses mid-way stops the move and says to sign in again", async () => {
  const { m } = await stops((k) => k.cloud.c.once.push(["PUT /transfer/v1/imports/", { status: 401, body: { code: "unauthorized", message: "This key isn't valid any more." } }]), "signed_out");
  expect(m.failure?.message).toBe("Your sign-in to fleetd cloud ended during the move.");
  expect(m.failure?.fix).toBe("Sign in again, then press Move.");
});

test("an import the cloud couldn't load lifts the pause and says why", async () => {
  const { m } = await stops(
    (k) => (k.cloud.c.outcome = { state: "failed", error: { code: "invalid", reason: "newer", message: "That export is at a migration this fleetd doesn't know.", fix: "Export it again." } }),
    "newer",
  );
  expect(m.failure?.message).toContain("older fleetd");
});

test("a cloud that refuses for its own reason is said in its words with its way forward", async () => {
  const { m } = await stops((k) => k.cloud.c.once.push(["POST /transfer/v1/imports", { status: 409, body: { code: "conflict", reason: "busy", message: "Another export or import of this team is running.", fix: "Wait." } }]), "refused");
  expect(m.failure?.message).toBe("Another move into acme is running.");
});

test("a restart mid-upload ends the move plainly at the next start, its upload given up, the pause lifted", async () => {
  const k = await kit();
  // As a restart finds it: the pause kept, the upload begun, the cloud not yet started.
  mover(k.o.hub).start({ url: TEAM, key: KEY, team: "acme" });
  mover(k.o.hub).cancel();
  await until(k, ended);
  const m = mover(k.o.hub);
  (m as unknown as { kept: unknown }).kept = { team: "acme", url: TEAM, since: "2026-10-17T10:00:00.000Z", key: (await sealedKeyOf(k)) ?? "", runId: RUN };
  (m as unknown as { phase: string }).phase = "idle";
  // The cloud still holds the upload the restart cut off.
  k.cloud.c.runState = "uploading";
  k.cloud.c.dropped = [];
  m.recover();
  await until(k, (x) => x.phase === "failed", "the restart's end");
  const s = m.status();
  expect(s.phase).toBe("failed");
  expect(s.failure?.reason).toBe("restarted");
  expect(s.paused).toBeUndefined();
  expect(k.cloud.c.dropped).toContain(`/transfer/v1/imports/${RUN}`);
});

async function sealedKeyOf(k: Kit): Promise<string | undefined> {
  const m = mover(k.o.hub) as unknown as { sealKey(key: string): string };
  return m.sealKey(KEY);
}

test("Stop before the cloud loads it ends the upload: nothing changed on either side", async () => {
  const k = await kit();
  k.cloud.c.cut = "PUT";
  start(k);
  await Bun.sleep(2);
  const stopped = await k.o.call(k.o.device().caller, "hub_move_cancel");
  expect(["packing", "uploading", "failed"]).toContain(stopped.move.phase);
  const m = await until(k, ended);
  expect(m.failure?.reason).toBe("cancelled");
  expect(m.paused).toBeUndefined();
});

test("only a person with Admin everywhere moves the workspace", async () => {
  const k = await kit();
  const member = k.o.device(k.o.owner.personId, "phone", [{ role: "operate", machines: "*" }]);
  await expect(k.o.call(member.caller, "hub_move_start", { url: TEAM, key: KEY, team: "acme" })).rejects.toThrow("forbidden");
  expect((await k.o.call(member.caller, "hub_move_status")).move.phase).toBe("idle");
});

test("once moved, each linked machine gets the team's address and its own code over its link, and ticks over as it joins", async () => {
  const k = await kit({ machines: ["devbox", "laptop"] });
  k.cloud.c.outcome = { state: "done", summary: { machines: [{ machineId: "devbox", name: "devbox" }, { machineId: "laptop", name: "laptop" }] } };
  start(k);
  await until(k, (m) => m.machines.length === 2 && m.machines.every((x) => x.state === "rejoining"), "both handed over");
  expect(k.sent.map((s) => s.machineId).sort()).toEqual(["devbox", "laptop"]);
  for (const s of k.sent) {
    expect(s.frame).toMatchObject({ t: "node_action", action: "rejoin", rejoin: { hub: TEAM } });
    expect(String((s.frame.rejoin as { code: string }).code)).toStartWith("fle_code");
  }
  // They enrol there and leave this hub's links.
  k.cloud.c.joined.add("devbox").add("laptop");
  k.linked.clear();
  await until(k, (m) => m.machines.every((x) => x.state === "joined"), "both joined");
  // Every machine joined: the key goes.
  await Bun.sleep(5);
  expect(JSON.parse(await Bun.file(join(k.p.home, MOVE_FILE)).text()).key).toBeUndefined();
});

test("a machine offline during the move rejoins once it links again", async () => {
  const k = await kit({ machines: ["devbox"] });
  k.linked.clear();
  k.cloud.c.outcome = { state: "done", summary: { machines: [{ machineId: "devbox", name: "devbox" }] } };
  start(k);
  const m = await until(k, (m) => m.machines[0]?.state === "offline", "offline");
  expect(m.machines[0]?.why).toBeUndefined();
  expect(k.sent).toEqual([]);
  k.linked.add("devbox");
  await until(k, (m) => m.machines[0]?.state === "rejoining", "handed over");
  expect(k.sent.length).toBe(1);
});

test("a node too old to rejoin by itself is updated first, and says so plainly", async () => {
  const k = await kit({ machines: ["devbox"] });
  k.caps.set("devbox", []);
  k.cloud.c.outcome = { state: "done", summary: { machines: [{ machineId: "devbox", name: "devbox" }] } };
  start(k);
  const m = await until(k, (m) => m.machines[0]?.state === "updating", "updating");
  expect(m.machines[0]?.why).toContain("older fleetd");
  expect(k.sent).toEqual([]);
  // Updated, it links again listing the capability, and is handed over.
  k.caps.set("devbox", [CAP_REJOIN]);
  await until(k, (m) => m.machines[0]?.state === "rejoining", "handed over");
});

test("a hand-off the node refuses is said and tried again with a fresh code", async () => {
  const k = await kit({ machines: ["devbox"] });
  let n = 0;
  k.nodeAnswer = () => (++n === 1 ? { ok: false, message: "the new workspace refused it: that code ran out" } : { ok: true, message: "enrolled" });
  k.cloud.c.outcome = { state: "done", summary: { machines: [{ machineId: "devbox", name: "devbox" }] } };
  start(k);
  await until(k, (m) => m.machines[0]?.state === "rejoining" && k.sent.length === 2, "the second hand-off");
  const codes = k.sent.map((s) => (s.frame.rejoin as { code: string }).code);
  expect(codes[0]).not.toBe(codes[1]);
});

test("a start the cloud refuses never started: the upload goes and the pause lifts, saying why", async () => {
  const { k, m } = await stops(
    (k) => k.cloud.c.once.push(["POST /transfer/v1/imports/11111111-2222-4333-8444-555555555555/start", { status: 403, body: { code: "invalid", reason: "passphrase", message: "That passphrase doesn't open the export's secrets.", fix: "Start again." } }]),
    "refused",
  );
  expect(m.failure?.message).toContain("That passphrase doesn't open the export's secrets.");
  expect(k.cloud.c.dropped).toEqual([`/transfer/v1/imports/${RUN}`]);
});

test("a start cut off before it landed is found never started: the upload goes and the pause lifts", async () => {
  const { k, m } = await stops((k) => (k.cloud.c.cut = "POST /transfer/v1/imports/11111111-2222-4333-8444-555555555555/start"), "offline");
  expect(m.failure?.message).toBe("fleetd cloud never got the start of the move. Nothing changed on either side.");
  expect(k.cloud.c.dropped).toEqual([`/transfer/v1/imports/${RUN}`]);
});

test("a start that landed but whose answer was cut off is followed to its end", async () => {
  const k = await kit();
  k.cloud.c.startLost = true;
  start(k);
  const m = await until(k, ended);
  expect(m.phase).toBe("done");
  expect(m.paused).toBeDefined();
  expect(k.cloud.c.dropped).toEqual([]);
});

test("a restart after the start finds the cloud took it, and follows the move to its end", async () => {
  const k = await kit();
  start(k);
  await until(k, ended);
  const m = mover(k.o.hub) as unknown as { kept: Record<string, unknown>; phase: string; recover(): void; status(): HubMove };
  // As a restart finds it: the start sent, its answer never kept, the cloud loading.
  m.kept = { team: "acme", url: TEAM, since: "2026-10-17T10:00:00.000Z", key: (await sealedKeyOf(k)) ?? "", runId: RUN };
  m.phase = "idle";
  m.recover();
  const s = await until(k, (x) => x.phase === "done", "done again");
  expect(s.paused).toBeDefined();
});
