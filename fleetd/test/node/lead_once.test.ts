// A lead call from a box that survives its link moving (src/shared/lead_once.ts): the guest (src/node/sandbox/guest.ts)
// holds a node.sock connection made while no link is up until the next one, the CLI (src/cli/agent_mcp/socket.ts) sends
// a call cut before its answer again under the same id, and the node's relay (src/node/lead/channel.ts) sends a repeat
// on only to a hub that answers it once. The node's side of each link here is the test's own Mux.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { sendToNode } from "../../src/cli/agent_mcp/socket.ts";
import { LeadRelay } from "../../src/node/lead/index.ts";
import { Guest } from "../../src/node/sandbox/guest.ts";
import { Mux } from "../../src/node/sandbox/mux.ts";
import { LEAD_CALL_ONCE } from "../../src/shared/lead_once.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-once-"));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CALL_ID = "cli-7-0b5e6a2c-3f1d-4e7a-9c2b-5d8e7f6a1b2c";
const FRAME = { t: "lead_call", id: CALL_ID, cwd: "/w", threadId: "s1", call: { op: "ask_lead", question: "which DB?" } };
const ANSWER = { t: "lead_result", id: CALL_ID, result: { op: "ask_lead", asked: true } };

let n = 0;
/** A guest beside the test, listening for its node at a socket of its own. */
async function guest(holdMs?: number) {
  const dir = join(root, `g${++n}`);
  mkdirSync(dir);
  const g = new Guest({ listen: join(dir, "link.sock"), dir: join(dir, "hosts"), loopback: "127.0.0.1", ...(holdMs ? { holdMs } : {}) });
  await g.serve();
  cleanups.push(() => g.stop());
  return { linkSock: join(dir, "link.sock"), nodeSock: join(dir, "node.sock") };
}

/** One node link to the guest: the lines each node.sock channel sent, answered with `answer` when it gives one. */
async function link(linkSock: string, answer?: (frame: Record<string, unknown>) => unknown) {
  const s = connect(linkSock);
  await new Promise<void>((r, j) => s.once("connect", () => r()).once("error", j));
  const lines: Record<string, unknown>[] = [];
  const answers = new Map<unknown, (m: Record<string, unknown>) => void>();
  const mux: Mux = new Mux(s, {
    control: (m) => answers.get(m.id)?.(m),
    open: (_channel, target) => {
      if (!("unix" in target)) return undefined;
      let buf = "";
      const end: Duplex = new Duplex({
        read() {},
        write(chunk: Buffer, _e, cb) {
          buf += chunk.toString();
          const nl = buf.indexOf("\n");
          if (nl >= 0) {
            const frame = JSON.parse(buf.slice(0, nl));
            lines.push(frame);
            const reply = answer?.(frame);
            if (reply) (end.push(`${JSON.stringify(reply)}\n`), end.push(null));
          }
          cb();
        },
      });
      return end;
    },
    closed: () => {},
  });
  cleanups.push(() => mux.close("the test ended"));
  const ask = (m: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      answers.set(m.id, resolve);
      mux.control(m);
    });
  return { mux, lines, ask };
}

test("a call in flight when the guest's link is replaced is answered once, on the new link", async () => {
  const { linkSock, nodeSock } = await guest();
  const old = await link(linkSock);
  expect(await old.ask({ id: 1, op: "listen", unix: nodeSock })).toEqual({ id: 1, ok: { unix: nodeSock } });
  const answered = sendToNode(nodeSock, FRAME, 5000);
  for (let i = 0; i < 500 && old.lines.length === 0; i++) await Bun.sleep(5);
  expect(old.lines).toEqual([FRAME]);
  // A new holder dials, as one does after the old one stops: the old link and its channels go.
  const next = await link(linkSock, () => ANSWER);
  expect(await answered).toEqual(ANSWER);
  expect(next.lines).toEqual([{ ...FRAME, resent: true }]);
  expect(old.lines).toHaveLength(1);
}, 10_000);

test("a call made while no link is up waits for the next link", async () => {
  const { linkSock, nodeSock } = await guest();
  const first = await link(linkSock);
  await first.ask({ id: 1, op: "listen", unix: nodeSock });
  first.mux.close("the node stopped");
  await Bun.sleep(20);
  const answered = sendToNode(nodeSock, FRAME, 5000);
  await Bun.sleep(50);
  const next = await link(linkSock, () => ANSWER);
  expect(await answered).toEqual(ANSWER);
  expect(next.lines.map((l) => l.id)).toEqual([CALL_ID]);
}, 10_000);

test("a connection held past the guest's wait is closed, and never opened on a later link", async () => {
  const { linkSock, nodeSock } = await guest(100);
  const first = await link(linkSock);
  await first.ask({ id: 1, op: "listen", unix: nodeSock });
  first.mux.close("the node stopped");
  await Bun.sleep(20);
  const c = connect(nodeSock);
  c.write(`${JSON.stringify(FRAME)}\n`);
  const started = performance.now();
  await new Promise<void>((r) => c.once("close", () => r()).on("error", () => {}).resume());
  expect(performance.now() - started).toBeGreaterThanOrEqual(90);
  const next = await link(linkSock, () => ANSWER);
  await next.ask({ id: 2, op: "ping" });
  expect(next.lines).toEqual([]);
});

test("the CLI never sends again a call without its own id, a browser call or a mac step", async () => {
  const sock = join(root, "cuts.sock");
  let got = 0;
  let now = 0;
  // Each send takes 25 s of the test's clock.
  const srv = createServer((s) => s.once("data", () => (got++, (now += 25_000), s.destroy())));
  await new Promise<void>((r) => srv.listen(sock, () => r()));
  cleanups.push(() => void srv.close());
  const cut = "the fleetd node closed the connection without answering — try again shortly";
  for (const frame of [
    { ...FRAME, id: "cli-7" },
    { ...FRAME, t: "browser_call" },
    { ...FRAME, call: { op: "mac", step: "run" } },
  ]) {
    got = 0;
    expect(await sendToNode(sock, frame, 5000).catch((why: string) => why)).toBe(cut);
    expect(got).toBe(1);
  }
  // A call with its own id is sent again, until RESEND_MS after its first send.
  got = 0;
  now = 0;
  expect(await sendToNode(sock, FRAME, 5000, 20_000, () => now).catch((why: string) => why)).toBe(cut);
  expect(got).toBe(3);
});

test("the relay forwards the caller's own id, and a repeat only to a hub that answers it once", async () => {
  const sent: Record<string, unknown>[] = [];
  const relay = new LeadRelay();
  const call = (frame: Record<string, unknown>) => relay.call(frame as never, 50);
  let detach = relay.attach((f) => void sent.push(f as never), []);
  await call({ ...FRAME, id: "cli-7" });
  await call(FRAME);
  expect(sent.map((f) => [f.id, f.callId])).toEqual([
    ["lc-1", undefined],
    ["lc-2", CALL_ID],
  ]);
  // A hub that doesn't list lead_call_once might act on the repeat again: the node answers it, sending nothing.
  const refused = await call({ ...FRAME, resent: true });
  expect(refused).toEqual({
    id: CALL_ID,
    error: {
      code: "machine_offline",
      message: "the connection was cut before the answer came, and this hub can't take the call again safely; the call may or may not have gone through",
      fix: "try again shortly",
    },
  });
  expect(sent).toHaveLength(2);
  detach();
  detach = relay.attach((f) => void sent.push(f as never), [LEAD_CALL_ONCE]);
  await call({ ...FRAME, resent: true });
  expect(sent[2]).toMatchObject({ t: "lead_call", id: "lc-3", callId: CALL_ID, resent: true });
  // One without an id of its own is never sent again, whatever the hub.
  expect("error" in (await call({ ...FRAME, id: "cli-7", resent: true }))).toBe(true);
  expect(sent).toHaveLength(3);
  detach();
});
