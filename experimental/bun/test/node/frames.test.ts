// One hub frame the node can't read is refused alone on a live link (Rust's link_frames): the frames around it still
// reach their handlers, a request among them is answered with an error in its own reply kind so the hub's wait ends,
// and only a flood of them within a minute drops the link.
import { expect, test } from "bun:test";
import { BAD_FRAMES_PER_MINUTE, BadFrames, readHubFrame, refusal } from "../../src/node/link/frames.ts";
import { runNode, type LinkContext } from "../../src/node/link/index.ts";
import { loadOrCreateIdentity } from "../../src/node/identity.ts";
import { HUB_TO_NODE } from "../../src/gen/wire.ts";
import type { HubFrame } from "../../src/node/wire.ts";
import { tempHome } from "../helpers.ts";

const until = async (what: string, fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

test("a frame that doesn't decode is known by its tag, its id and why, never its payload", () => {
  const bad = readHubFrame(JSON.stringify({ t: "cmd_check_v9", id: "r1", secret: "s3cret" }), HUB_TO_NODE);
  expect(bad).toEqual({ bad: { tag: "cmd_check_v9", id: "r1", error: "unknown variant `cmd_check_v9`" } });
  expect(readHubFrame("not json", HUB_TO_NODE)).toMatchObject({ bad: { tag: "(none)" } });
  expect(readHubFrame("[1]", HUB_TO_NODE)).toEqual({ bad: { tag: "(none)", error: "not a JSON object" } });
  const long = readHubFrame(JSON.stringify({ t: "x".repeat(500), id: "i".repeat(500) }), HUB_TO_NODE);
  expect("bad" in long && [long.bad.tag.length, long.bad.id]).toEqual([64, undefined]);
  expect(readHubFrame(JSON.stringify({ t: "spans_ack", upto: 1 }), HUB_TO_NODE)).toEqual({ frame: { t: "spans_ack", upto: 1 } });
});

test("up to the limit a minute each is refused alone; one more ends the link, and a new minute starts again", () => {
  const bad = new BadFrames();
  for (let i = 0; i < BAD_FRAMES_PER_MINUTE; i++) expect(bad.take(1_000 + i)).toBe(true);
  expect(bad.take(30_000)).toBe(false);
  const again = new BadFrames();
  for (let minute = 0; minute < 5; minute++) for (let i = 0; i < BAD_FRAMES_PER_MINUTE; i++) expect(again.take(minute * 60_000)).toBe(true);
});

test("each hub request the node can't read is answered in its reply kind; a gated_resume and a frame with no id get none", () => {
  for (const [asked, reply] of [
    ["cmd_check", "cmd_result"],
    ["secret_deliver", "secret_result"],
    ["gated_run", "gated_result"],
    ["node_action", "node_action_result"],
    ["session_call", "session_reply"],
    ["mac_call", "mac_result"],
  ] as const) {
    expect(refusal({ tag: asked, id: "r1", error: "e" })).toMatchObject({ t: reply, id: "r1" });
  }
  expect(refusal({ tag: "cmd_check", id: "r1", error: "e" })).toEqual({
    t: "cmd_result",
    id: "r1",
    exitCode: null,
    outputTail: "the node could not read this cmd_check (it and the hub may run different fleetd versions): e",
    timedOut: false,
  });
  expect(refusal({ tag: "gated_resume", id: "r1", error: "e" })).toBeUndefined();
  expect(refusal({ tag: "cmd_check", error: "e" })).toBeUndefined();
  expect(refusal({ tag: "constructor", id: "r1", error: "e" })).toBeUndefined();
});

test("on a live link a bad frame is refused alone, a request whose handler throws is answered, and a flood drops the link", async () => {
  const home = tempHome();
  const conns: { frames: Record<string, any>[]; ws: Bun.ServerWebSocket<unknown> }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open(ws) {
        conns.push({ frames: [], ws });
        ws.send(JSON.stringify({ t: "challenge", nonce: "nonce-1" }));
      },
      message(ws, data) {
        const frame = JSON.parse(String(data));
        conns.find((c) => c.ws === ws)!.frames.push(frame);
        if (frame.t === "hello") ws.send(JSON.stringify({ t: "welcome", hubId: "fleetd-devbox", protocol: 1, capabilities: [] }));
      },
    },
  });
  const stop = new AbortController();
  const handled: HubFrame[] = [];
  const logged: string[] = [];
  let link: LinkContext | undefined;
  void runNode({
    settings: { hub: `http://127.0.0.1:${server.port}`, machineId: "devbox", name: "devbox", nodeVersion: "0.0.0" },
    identity: loadOrCreateIdentity(home.dir),
    capabilities: () => ["repos"],
    heartbeat: async () => ({}),
    attach: (l) => ((link = l), () => {}),
    handle: (f) => {
      if (f.t === "cmd_check") throw new Error("argv must hold at least one word");
      handled.push(f);
    },
    log: (_level, message) => logged.push(message),
    signal: stop.signal,
  });
  try {
    await until("the welcome", () => link !== undefined);
    const hub = conns[0]!.ws;
    hub.send(JSON.stringify({ t: "spans_ack", upto: 1 }));
    hub.send("{not json");
    hub.send(JSON.stringify({ t: "newer_request", id: "n1" }));
    hub.send(JSON.stringify({ t: "cmd_check", id: "c1", cwd: "/w", argv: [], timeoutSec: 5 }));
    hub.send(JSON.stringify({ t: "spans_ack", upto: 2 }));
    await until("the frames around the bad ones", () => handled.length === 2);
    expect(handled.map((f) => f.upto)).toEqual([1, 2]);
    await until("the cmd_check's answer", () => conns[0]!.frames.some((f) => f.t === "cmd_result"));
    expect(conns[0]!.frames.find((f) => f.t === "cmd_result")).toMatchObject({ id: "c1", exitCode: null, timedOut: false });
    expect(conns[0]!.frames.find((f) => f.t === "cmd_result")!.outputTail).toContain("argv must hold at least one word");
    expect(logged.filter((m) => m === "a hub frame does not decode; refused it alone")).toHaveLength(2);
    expect(conns).toHaveLength(1);
    // Past the minute's limit (two already taken), the link ends and the node dials again.
    for (let i = 0; i < BAD_FRAMES_PER_MINUTE - 1; i++) hub.send("garbage");
    await until("the link dropped and dialled again", () => conns.length === 2);
    expect(logged).toContain("too many hub frames that do not decode; dropping the link");
  } finally {
    stop.abort();
    server.stop(true);
    home.done();
  }
});
