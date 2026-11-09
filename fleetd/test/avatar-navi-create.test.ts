// A project's picture (its tests) and navi_create.
import { afterEach, expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { executors } from "../src/hub/executor/index.ts";
import { link } from "../src/hub/link/server.ts";
import * as navis from "../src/hub/navi/store.ts";
import { AVATAR_PX, render, square } from "../src/hub/projects/avatar.ts";
import { pngRows } from "../src/hub/projects/avatar-render.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { CAP_ASSISTANT, CAP_REPOS } from "../src/shared/node_link.ts";
import { FOLDER_TAKEN, type SessionCall } from "../src/shared/sessions.ts";
import { intakeHub, png } from "./intake-kit.ts";
import { AT, key, project } from "./work-kit.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0)) done();
});

function rig() {
  const r = intakeHub();
  cleanups.push(r.home.done);
  const tools = new Registry();
  registerAll(tools);
  const call = (caller: ReturnType<typeof key>, tool: string, input: unknown) => tools.call(r.hub, caller, tool, input);
  const ok = async (caller: ReturnType<typeof key>, tool: string, input: unknown) => {
    const res = await call(caller, tool, input);
    if ("error" in res) throw new Error(`${tool}: ${JSON.stringify(res.error)}`);
    return res.output as Record<string, any>;
  };
  return { ...r, call, ok };
}

const me = key("operate", { human: true, name: "k1", machines: ["devbox"] });
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

test("the square a crop names is moved, then shrunk, to fit; absent, the largest in the middle", () => {
  expect(square(400, 300, undefined)).toEqual([50, 0, 300]);
  expect(square(400, 300, { x: 350, y: 10, size: 100 })).toEqual([300, 10, 100]);
  expect(square(400, 300, { x: 0, y: 0, size: 999 })).toEqual([0, 0, 300]);
  expect(square(400, 300, { x: -5, y: 0, size: 0 })).toEqual([399, 0, 1]);
});

test("a picture is kept upright, cropped, at most AVATAR_PX a side, on white, as a JPEG", async () => {
  // Left half red, right half clear: cropped to its middle square, shrunk, the clear part white.
  const big = png(1200, 800, (x) => (x < 600 ? [255, 0, 0, 255] : [0, 0, 0, 0]), true);
  const jpeg = await render(big, undefined);
  expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
  const meta = await new Bun.Image(jpeg).metadata();
  expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", AVATAR_PX, AVATAR_PX]);
  const small = await render(png(40, 40, () => [0, 128, 255]), { x: 10, y: 10, size: 20 });
  expect((await new Bun.Image(small).metadata()).width).toBe(20);
  await expect(render(new TextEncoder().encode("GIF89a not really"), undefined)).rejects.toThrow("That picture can't be used");
});

test("a big picture is shrunk whole before its crop, and the crop still lands where it was named", async () => {
  // Red left of x = 1500, blue right of it: the crop's middle column sits on the seam, a quarter of the way down.
  const photo = await new Bun.Image(png(3000, 2000, (x) => (x < 1500 ? [255, 0, 0] : [0, 0, 255]))).jpeg({ quality: 95 }).bytes();
  const jpeg = await render(photo, { x: 1000, y: 500, size: 1000 });
  const kept = await new Bun.Image(jpeg).png().bytes();
  const seen: number[][] = [];
  const { width } = pngRows(kept, (y, row) => {
    if (y === 256) for (const x of [100, 400]) seen.push([...row.subarray(x * 3, x * 3 + 3)]);
    return y < 256;
  });
  expect(width).toBe(AVATAR_PX);
  const [left, right] = seen as [number[], number[]];
  expect(left[0]! > 200 && left[2]! < 60).toBe(true);
  expect(right[2]! > 200 && right[0]! < 60).toBe(true);
});

test("project_avatar_set keeps the rendered picture, forgets the upload, and says so; none removes it", async () => {
  const { hub, ok, call } = rig();
  const r = { machineId: "devbox", projectId: "app" };
  project(hub, r, { title: "App" });
  const put = await ok(me, "attachment_put", { name: "me.png", mime: "image/png", dataB64: b64(png(600, 600, (x, y) => [x % 256, y % 256, 90])) });
  const set = await ok(me, "project_avatar_set", { ...r, attachmentId: put.attachmentId, crop: { x: 0, y: 0, size: 300 } });
  expect(set.project.avatar).toMatch(/^[0-9a-f]{16}$/);
  const got = await ok(key("read"), "project_avatar_get", r);
  expect([got.avatar, got.mime]).toEqual([set.project.avatar, "image/jpeg"]);
  // The upload went with it.
  expect("error" in (await call(me, "attachment_get", { attachmentId: put.attachmentId }))).toBe(true);
  const removed = await ok(me, "project_avatar_set", r);
  expect(removed.project.avatar).toBeUndefined();
  expect(events(hub).page(0).events.filter((e) => e.type === "project.settings").map((e) => [e.summary, e.data])).toEqual([
    ["App has a new picture", { avatar: set.project.avatar }],
    ["App's picture removed", { avatar: null }],
  ]);
  expect("error" in (await call(key("read"), "project_avatar_set", r))).toBe(true);
});

test("navi_create makes an Only me project in a free folder under its node's home, its owner the caller", async () => {
  const { hub, ok, call } = rig();
  hub.db.conn.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p-ada', 'Ada', 'member', 0)");
  const ada = key("operate", { human: true, name: "phone", machines: ["devbox"], person: { personId: "p-ada", name: "Ada" } });
  store(hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT });
  // A project already in navi/home, so the new one goes to navi/home-2 (the node then says home-2 is taken too).
  project(hub, { machineId: "devbox", projectId: "old" }, { workspaceRoot: "/home/me/.fleetd/node/navi/home" });
  const calls: SessionCall[] = [];
  let allTaken = false;
  const ex = executors(hub);
  ex.attach("devbox", {
    linkId: 1,
    send(frame) {
      if (frame.call.op !== "subscribe") calls.push(frame.call);
      const c = frame.call;
      const result =
        c.op === "project_upsert" && (allTaken || c.workspaceRoot === "navi/home-2")
          ? { err: { code: "invalid" as const, message: `${FOLDER_TAKEN}navi/home-2` } }
          : c.op === "project_upsert"
            ? { ok: { kind: "folder" as const, path: `/home/me/.fleetd/node/${c.workspaceRoot}` } }
            : { ok: { kind: "done" as const } };
      queueMicrotask(() => ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result }));
    },
  });
  await ex.awaitLive("devbox");
  const caps = (list: string[]) => (link(hub) as unknown as { capabilities: Map<string, Set<string>> }).capabilities.set("devbox", new Set(list));
  caps([CAP_REPOS]);
  const old = await call(ada, "navi_create", { name: "Home", machineId: "devbox" });
  expect("error" in old && old.error.kind === "tool" && old.error.error.message).toBe("devbox's node is too old to hold a project");
  caps([CAP_REPOS, CAP_ASSISTANT]);
  const made = await ok(ada, "navi_create", { name: "Home", machineId: "devbox" });
  expect(made.navi).toMatchObject({ title: "Home", workspaceRoot: "/home/me/.fleetd/node/navi/home-3", onlyMe: true, owner: "p-ada" });
  expect(made.next).toBe("Write to it with chat_send; its lead starts with the first message.");
  expect(calls.map((c) => c.op === "project_upsert" && c.workspaceRoot)).toEqual(["navi/home-2", "navi/home-3"]);
  const r = { machineId: "devbox", projectId: made.navi.projectId };
  expect(navis.of(hub.db.conn, r)).toMatchObject({ createdBy: { keyId: "key_phone", name: "phone" }, owner: "p-ada" });
  const added = events(hub).page(0).events.find((e) => e.type === "project.added");
  expect(added).toMatchObject({ summary: "Home made on devbox", projectId: r.projectId, data: { title: "Home", created: true } });
  // Every free folder taken: the mark goes, and nothing is left behind.
  allTaken = true;
  const full = await call(ada, "navi_create", { name: "Work", machineId: "devbox" });
  expect("error" in full && full.error.kind === "tool" && full.error.error.message).toBe("every free folder name for Work on devbox is taken");
  expect(navis.all(hub.db.conn).length).toBe(1);
});
