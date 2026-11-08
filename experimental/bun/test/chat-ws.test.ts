// The /app `chat` subscription and its `chat_delta` frames (crates/fleetd/src/hub/app_ws/mod.rs).
import { afterAll, expect, test } from "bun:test";
import { start } from "../src/hub/chat/loops.ts";
import { chat } from "../src/hub/chat/index.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { build } from "../src/hub/serve/index.ts";
import { FakeApp } from "./fake-app.ts";
import { insertKey, tempHome } from "./helpers.ts";

const home = tempHome();
const { hub, tools } = build(home.dir, { host: "127.0.0.1", port: 0 });
start(hub);
const server = serve(hub, tools, 0);
const url = `ws://127.0.0.1:${server.port}/app`;
afterAll(async () => {
  hub.shutdown.abort();
  await stop(server);
  hub.db.close();
  home.done();
});

const project = { machineId: "lab-a", projectId: "p1" };

test("a chat subscription streams that project's deltas, and a new one replaces it", async () => {
  const key = insertKey(hub.db, [{ role: "read", machines: "*" }], "phone");
  const app = new FakeApp(url);
  await app.send({ t: "auth", key });
  await app.tag("ready");
  await app.send({ t: "chat", project });
  await Bun.sleep(20);
  let m = chat(hub).add(project, { author: "lead", streaming: true, source: "s1" }).message;
  chat(hub).add({ machineId: "lab-a", projectId: "other" }, { author: "lead", streaming: true, source: "s2" });
  m = chat(hub).append(m, "Hello");
  expect(await app.tag("chat_delta")).toMatchObject({ projectRef: project, messageId: m.messageId, offset: 0, append: "Hello" });
  // No project stops it.
  await app.send({ t: "chat" });
  await Bun.sleep(20);
  chat(hub).append(m, " again");
  await app.send({ t: "chat", project: { machineId: "lab-b", projectId: "p1" } });
  await Bun.sleep(20);
  app.close();
});

test("a key without read on the machine is refused", async () => {
  const key = insertKey(hub.db, [{ role: "read", machines: ["lab-b"] }], "narrow");
  const app = new FakeApp(url);
  await app.send({ t: "auth", key });
  await app.tag("ready");
  await app.send({ t: "chat", project });
  expect(await app.tag("error")).toMatchObject({ code: "forbidden", message: "This key has no read grant on machine lab-a." });
  app.close();
});
