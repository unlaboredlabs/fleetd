// scripts/net-app/desktop.ts: the desktop app's own hub client (app/desktop/src/main/hub/client.ts with main's `ws`
// transport, compression and all) against the rig's hub through netem, per profile: connect (dial → live → first
// snapshot), a session's bytes (three lead replies streamed into the open chat, then a quiet minute), and a drop (the
// link cut for --cut s 1.5 s into a reply): from the link back to live again and to the reply's final message, and
// whether any event came twice or out of order, and the chat's streamed text matches the hub's. Needs hub.ts running;
// reads its JSON line from --rig. Run with bun from the repo root (the app's node_modules give `ws` and zod).
//
//   bun scripts/net-app/desktop.ts --rig $TMPDIR/hub.out [--profiles 3g,satellite] [--runs 3] [--cut 5] [--out f.json]
import { readFileSync, writeFileSync } from "node:fs";
import { HubClient } from "../../app/desktop/src/main/hub/client.ts";
import { webSocketTransport } from "../../app/desktop/src/main/hub/transport.ts";
import type { HubFrame } from "../../app/desktop/src/shared/hub.ts";
import { PROFILES, startNetem } from "../netem.ts";

const flag = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? d : process.argv[i + 1];
};
const rig = JSON.parse(readFileSync(flag("rig")!, "utf8")) as { hub: string; key: string; control: number; project: { machineId: string; projectId: string } };
const profiles = (flag("profiles") ?? "clean,3g,satellite,lossy-wifi,tiny-bandwidth,flapping").split(",");
const runs = Number(flag("runs") ?? 3);
const cutS = Number(flag("cut") ?? 5);
const hubPort = Number(new URL(rig.hub).port);
const control = (path: string) => fetch(`http://127.0.0.1:${rig.control}${path}`).then((r) => r.json());

/** One client and what it saw: frames with times, the events' seqs, the chat as its deltas built it. */
const open = (url: string) => {
  const seen: Array<{ at: number; frame: HubFrame }> = [];
  const seqs: number[] = [];
  const text = new Map<string, string>();
  let gaps = 0;
  const waiters: Array<{ match: (f: HubFrame) => boolean; resolve: (at: number) => void }> = [];
  /** When each message's final text was in hand. */
  const finalAt = new Map<string, number>();
  const finalWaiters = new Map<string, (at: number) => void>();
  const finals = (messageId: string, at: number) => {
    finalAt.set(messageId, at);
    finalWaiters.get(messageId)?.(at);
  };
  const final = (messageId: string, ms = 120_000) =>
    new Promise<number>((resolve) => {
      const had = finalAt.get(messageId);
      if (had !== undefined) return resolve(had);
      finalWaiters.set(messageId, resolve);
      setTimeout(() => resolve(Number.NaN), ms);
    });
  const client = new HubClient({
    hub: url,
    key: rig.key,
    transport: webSocketTransport,
    emit: (frame) => {
      const at = performance.now();
      seen.push({ at, frame });
      if (frame.t === "event") seqs.push(frame.event.seq);
      if (frame.t === "chat_delta") {
        // As the renderer applies them (contracts: offset == length appends, within skips, past is a gap).
        const d = frame.delta as { messageId: string; offset: number; append: string };
        const have = text.get(d.messageId) ?? "";
        if (d.offset === have.length) text.set(d.messageId, have + d.append);
        else if (d.offset > have.length) gaps++;
      }
      if (frame.t === "event" && frame.event.type === "chat.message") {
        // The final copy: what the screens show once it lands; one too big for its event is read, as the renderer does.
        const d = (frame.event as { data?: { messageId: string; seq: number; state: string; message?: { messageId: string; text: string } } }).data;
        if (d?.state === "final" && d.message !== undefined) {
          text.set(d.message.messageId, d.message.text);
          finals(d.messageId, at);
        } else if (d?.state === "final") {
          void client.call({ tool: "chat_history", input: { projectRef: rig.project, after: d.seq - 1, limit: 1 } }).then((r) => {
            const m = r.ok ? (r.output as { messages: Array<{ messageId: string; text: string }> }).messages[0] : undefined;
            if (m !== undefined) text.set(m.messageId, m.text);
            finals(d.messageId, performance.now());
          });
        }
      }
      for (const w of [...waiters]) if (w.match(frame)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(at));
    },
  });
  const next = (match: (f: HubFrame) => boolean, ms = 120_000) =>
    new Promise<number>((resolve) => {
      waiters.push({ match, resolve });
      setTimeout(() => resolve(Number.NaN), ms);
    });
  return { client, seen, seqs, text, gaps: () => gaps, next, final };
};

const live = (f: HubFrame) => f.t === "state" && f.state.phase === "live";
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const out: Record<string, unknown> = {};
for (const profile of profiles) {
  const rows: Array<Record<string, number>> = [];
  for (let i = 0; i < runs; i++) {
    // Flapping's own timer would drop the link at its own moments: the drop here is the measured one.
    const link = { ...PROFILES[profile]!, flap: undefined };
    const n = await startNetem({ target: hubPort, profile: link, seed: i + 1 });
    const c = open(n.url);
    const t0 = performance.now();
    const isLive = c.next(live);
    const snap = c.next((f) => f.t === "snapshot");
    c.client.start();
    const liveMs = (await isLive) - t0;
    const snapshotMs = (await snap) - t0;
    c.client.chat(rig.project);
    // The chat's first page, as the renderer reads it when the chat opens.
    const h0 = performance.now();
    await c.client.call({ tool: "chat_history", input: { projectRef: rig.project, limit: 50 } });
    const firstPageMs = performance.now() - t0;
    void h0;
    const connectDown = n.stats().down;
    n.reset();
    // A session: three replies of 2000 characters, 40 every 50 ms, then a quiet minute.
    for (let r = 0; r < 3; r++) await control(`/lead?chars=2000&every=50&chunk=40`);
    await Bun.sleep(60_000);
    const session = n.stats();
    // The drop.
    n.reset();
    const reply = control(`/lead?chars=3000&every=80&chunk=40`) as Promise<{ messageId: string; text: string; seq: number }>;
    await Bun.sleep(1500);
    const cutAt = performance.now();
    const awayP = c.next((f) => f.t === "state" && f.state.phase !== "live");
    const backLive = c.next((f) => live(f) && performance.now() > cutAt + cutS * 1000);
    n.cut(cutS);
    const backAt = cutAt + cutS * 1000;
    const final = await reply;
    const awayMs = (await awayP) - cutAt;
    const liveAgainMs = (await backLive) - backAt;
    const finalMs = Math.max(0, (await c.final(final.messageId)) - backAt);
    await Bun.sleep(2000);
    const drop = n.stats();
    const twice = c.seqs.length - new Set(c.seqs).size;
    const outOfOrder = c.seqs.filter((s, k) => k > 0 && s < c.seqs[k - 1]!).length;
    const truth = (await control("/truth")) as Array<{ messageId: string; text: string; state: string }>;
    const streamed = truth.filter((m) => c.text.has(m.messageId));
    const wrong = streamed.filter((m) => c.text.get(m.messageId) !== m.text).length;
    const resumed = c.seen.filter((s) => s.frame.t === "snapshot" && (s.frame as { resumed?: boolean }).resumed === true).length;
    rows.push({
      liveMs: Math.round(liveMs),
      snapshotMs: Math.round(snapshotMs),
      firstPageMs: Math.round(firstPageMs),
      connectDown,
      sessionDown: session.down,
      sessionUp: session.up,
      awayAfterCutMs: Math.round(awayMs),
      liveAfterBackMs: Math.round(liveAgainMs),
      finalAfterBackMs: Math.round(finalMs),
      dropDown: drop.down,
      dropConns: drop.conns,
      resumed,
      eventsTwice: twice,
      eventsOutOfOrder: outOfOrder,
      messagesWrong: wrong,
      messagesChecked: streamed.length,
      deltaGaps: c.gaps(),
    });
    process.stderr.write(`${profile} run ${i + 1}: ${JSON.stringify(rows.at(-1))}\n`);
    c.client.stop();
    await n.close();
  }
  out[profile] = { median: Object.fromEntries(Object.keys(rows[0]!).map((k) => [k, median(rows.map((r) => r[k]!))])), rows };
}
const file = flag("out");
if (file !== undefined) writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
