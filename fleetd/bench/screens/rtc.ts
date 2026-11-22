// A Linux desktop screen watched from a real browser, over both transports: the hub's way, the node link's and the
// app socket's hops as fleetd's code does them (./wire.ts) on a WebSocket, and peer to peer, through the node's own
// peers (src/node/rtc) on WebRTC data channels. The node's side of it runs here: its real display, session, capture
// and x264 (as ./desktop.ts runs them). The viewer, ./rtc_viewer.ts, is headless Chrome running anywhere. It types
// into a terminal, timing each key from the moment it is sent to the frame that shows it, both as it arrives and
// once it is decoded. Then it starts the terminal scrolling flat out and counts what comes. This side prints one
// JSON line: the viewer's numbers per transport, and the node's CPU per frame while the screen scrolled.
//
//   bun bench/screens/rtc.ts --video <ffmpeg> [--listen 127.0.0.1:4799]   (viewer: rtc_viewer.ts --node http://…)
//   bun bench/screens/rtc.ts --video <ffmpeg> --issue owner/repo#n         (viewer signals through the issue)
//
// --issue: offers, answers and results go as comments on a private repo's issue (through `gh`), for a viewer that
// can't reach this machine. Its WebSocket phase goes through a Cloudflare quick tunnel to this process alone (a relay
// hop, as fleetd cloud's own tunnel is), at a path with a random token, for the run only.
//
// Both transports send through the same ack-paced FrameSender (src/hub/browser/flow.ts) the hub and the peers use.
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Display } from "../../src/node/desktop/display.ts";
import { onPath } from "../../src/node/desktop/paths.ts";
import { Session } from "../../src/node/desktop/session.ts";
import { liveEncoder } from "../../src/node/screen/x264.ts";
import { Peers } from "../../src/node/rtc/index.ts";
import type { BrowserFrame, BrowserInput } from "../../src/shared/contracts.ts";
import type { BrowserRtcReport } from "../../src/shared/screens_wire.ts";
import { FrameSender } from "../../src/hub/browser/flow.ts";
import { CpuSpan, round } from "./meter.ts";
import { Wire } from "./wire.ts";

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const ffmpeg = arg("--video");
const listen = arg("--listen") ?? "127.0.0.1:4799";
const issue = arg("--issue");
const xvfb = onPath("Xvfb");
if (!xvfb || !onPath("xterm")) throw new Error("needs Xvfb and xterm");
const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "screens-rtc-"));

const display = await Display.start({ backend: "xvfb", image: "", xvfb, root });
const x = await display.connect();
const pids = [Number(readFileSync(join(display.dir, "xvfb.pid"), "utf8").split(" ")[0])];
const session = new Session(display, x, {
  id: "Bbench0000000000000000000000000000",
  thread: "t1",
  cwd: root,
  purpose: "bench",
  secrets: [],
  kind: "linux_desktop",
  ...(ffmpeg ? { encoder: liveEncoder(async () => ffmpeg) } : {}),
});
session.open();
session.setControl("human", "bench");

// A terminal that echoes what's typed; a line "go" sets it scrolling as fast as it can.
let term: { pid: number } | undefined;
const terminal = async () => {
  if (term) {
    try {
      process.kill(-term.pid, "SIGTERM");
    } catch {}
  }
  term = await display.launch(`xterm -geometry 100x30+0+0 -e sh -c 'while read l; do [ "$l" = go ] && while :; do date +%s.%N; done; done'`, root);
  pids.push(term.pid);
};
await terminal();

// The node's CPU while the screen scrolls (from "go" to the viewer's Escape), and the frames it sent meanwhile.
type Span = { span: CpuSpan; from: number; frames: number };
const node: Record<string, { cpuPct: number | null; frames: number; cpuMsPerFrame: number | null; secs: number | null }> = {};
let active: Span | undefined;
let sent = 0;
let typed = "";
const onInput = (i: BrowserInput, via: string) => {
  if (i.kind === "key" && i.key === "Escape" && i.action === "down") {
    if (active) {
      const secs = (performance.now() - active.from) / 1000;
      const cpu = active.span.end().node;
      const frames = sent - active.frames;
      node[via] = { cpuPct: round(cpu, 1), frames, cpuMsPerFrame: round((cpu * 10 * secs) / Math.max(frames, 1), 2), secs: round(secs, 1) };
      active = undefined;
    }
    void terminal();
    return;
  }
  if (i.kind === "key" && i.action === "down" && i.key === "Enter") {
    if (typed.endsWith("go")) active = { span: new CpuSpan(() => pids), from: performance.now(), frames: sent };
    typed = "";
  } else if (i.kind === "key" && i.action === "down" && i.text) typed += i.text;
  session.queueInput(i);
};

// The peers, as the node wires them: watch frames to the session, input to it, reports here.
const reports: BrowserRtcReport[] = [];
const peers = new Peers({
  watch: (f) => {
    session.setBudget(f.kbps, f.video);
    if (f.key) session.key();
  },
  input: (_id, i) => onInput(i, "rtc"),
  report: (r) => reports.push(r),
});
peers.fromHub({ sessionId: "Bbench0000000000000000000000000000", on: true, video: ffmpeg !== undefined });

// The hub's way: every hop's code, then the app socket.
const wire = new Wire();
const sockets = new Map<{ send(text: string): void }, FrameSender<string>>();
let carrying = Promise.resolve();
session.setWatcher({
  kbps: undefined,
  video: ffmpeg !== undefined,
  send: (f: BrowserFrame) => {
    sent++;
    peers.frame(f);
    if (sockets.size === 0) return;
    carrying = carrying.then(async () => {
      const { frame } = await wire.carry(f);
      const text = JSON.stringify({ ...frame, t: "browser_frame" });
      const bytes = Math.floor((frame.jpegB64 ?? frame.h264B64 ?? "").length / 4) * 3;
      for (const sender of sockets.values()) sender.offer({ seq: frame.seq, bytes, h264: frame.h264B64 !== undefined, key: frame.key === true, data: text });
    });
  },
});

async function answer(peer: string, offer: string): Promise<string> {
  await peers.rtc({ sessionId: "Bbench0000000000000000000000000000", peer, offer, input: true });
  const r = reports.find((x) => x.peer === peer && (x.answer !== undefined || x.error !== undefined));
  if (!r?.answer) throw new Error(r?.error ?? "no answer");
  return r.answer;
}

const done = Promise.withResolvers<unknown>();
const cleanup: (() => void)[] = [];
const token = crypto.randomUUID();
const [hostname, port] = listen.split(":") as [string, string];
const server = Bun.serve<{ id: number }>({
  hostname,
  port: Number(port),
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === `/${token}/ws`) return srv.upgrade(req, { data: { id: 0 } }) ? undefined : new Response("no", { status: 400 });
    if (issue) return new Response("not found", { status: 404 });
    if (url.pathname === "/offer") {
      const { peer, sdp } = (await req.json()) as { peer: string; sdp: string };
      return new Response(await answer(peer, sdp));
    }
    if (url.pathname === "/result") {
      done.resolve(await req.json());
      return new Response("ok");
    }
    if (url.pathname === "/ws-path") return new Response(`/${token}/ws`);
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open: (ws) => {
      sockets.set(
        ws,
        new FrameSender<string>({ send: (f) => void ws.send(f.data), key: () => session.key(), budget: (k) => session.setBudget(k, ffmpeg !== undefined) }),
      );
      session.key();
    },
    message: (ws, m) => {
      const f = JSON.parse(String(m)) as { t: string; input?: BrowserInput; seq?: number };
      if (f.t === "browser_input" && f.input) onInput(f.input, "ws");
      if (f.t === "browser_frame_ack" && f.seq !== undefined) sockets.get(ws)?.ack(f.seq);
    },
    close: (ws) => {
      sockets.get(ws)?.end();
      sockets.delete(ws);
    },
  },
});
if (issue) {
  const [repo, n] = issue.split("#") as [string, string];
  const gh = async (args: string[], input?: string) => {
    const p = Bun.spawn(["gh", ...args], { stdin: input === undefined ? "ignore" : new Response(input), stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) throw new Error(`gh ${args[1] ?? ""} failed`);
    return out;
  };
  const seen = new Set<number>();
  const since = new Date().toISOString();
  // The tunnel: a public address for this process's WebSocket alone, for this run.
  const tunnel = Bun.spawn(["cloudflared", "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${server.port}`], { stdout: "ignore", stderr: "pipe" });
  cleanup.push(() => tunnel.kill());
  let at = "";
  const reader = tunnel.stderr.getReader();
  for (let text = ""; !at; ) {
    const { value, done: end } = await reader.read();
    if (end) throw new Error("cloudflared ended");
    text += new TextDecoder().decode(value);
    at = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u.exec(text)?.[0] ?? "";
  }
  void (async () => {
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true }));
      if (r.done) return;
    }
  })();
  await gh(["api", `repos/${repo}/issues/${n}/comments`, "--input", "-"], JSON.stringify({ body: `ws:${Buffer.from(`${at.replace(/^https/u, "wss")}/${token}/ws`).toString("base64")}` }));
  void (async () => {
    for (;;) {
      const comments = JSON.parse(await gh(["api", `repos/${repo}/issues/${n}/comments?since=${since}&per_page=100`])) as { id: number; body: string }[];
      for (const c of comments) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        const [kind, peer, b64] = c.body.trim().split(":");
        if (kind === "offer" && peer && b64) {
          const sdp = await answer(peer, Buffer.from(b64, "base64").toString());
          await gh(["api", `repos/${repo}/issues/${n}/comments`, "--input", "-"], JSON.stringify({ body: `answer:${peer}:${Buffer.from(sdp).toString("base64")}` }));
        } else if (kind === "result" && peer) done.resolve(JSON.parse(Buffer.from(peer, "base64").toString()));
      }
      await Bun.sleep(1_000);
    }
  })();
  console.error(`waiting for a viewer on ${repo}#${n}`);
} else {
  console.error(`viewer: bun bench/screens/rtc_viewer.ts --node http://${hostname}:${server.port}`);
}

const viewer = await done.promise;
for (const fn of cleanup) fn();
console.log(JSON.stringify({ kind: "linux_desktop", codec: ffmpeg ? "h264" : "jpeg", viewer, node }));
peers.closeAll();
wire.close();
await session.close().catch(() => {});
for (const pid of pids) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}
process.exit(0);
