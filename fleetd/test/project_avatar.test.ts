// A project's picture (its tests).
import { afterEach, expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { executors } from "../src/hub/executor/index.ts";
import { link } from "../src/hub/link/server.ts";
import * as kept from "../src/hub/navi/store.ts";
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
