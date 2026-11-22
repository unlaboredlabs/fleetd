// The viewer of ./rtc.ts: headless Chrome watching the bench's Linux desktop, the way the desktop and web apps do
// (renderer/screens/sessions/rtc.ts and video.ts): first over a WebSocket of the hub's frames, each acked, then over
// WebRTC data channels with the frames chunked on `frames` and acked on `input`; WebCodecs H.264 with the app's
// settings. For each transport it times each typed key from its send to the frame that shows it, both on arrival
// and once decoded, then counts frames and bytes while the terminal scrolls. Self-contained (Bun and Chrome only), so
// it runs on a machine that has no checkout.
//
//   bun rtc_viewer.ts --node http://<bench>:4799 [--chrome <path>]
//   bun rtc_viewer.ts --issue owner/repo#n [--chrome <path>]       (GITHUB_TOKEN set; the socket through a tunnel)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const nodeUrl = arg("--node");
const issue = arg("--issue");
const chromePath = arg("--chrome") ?? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
if (!chromePath || (!nodeUrl && !issue)) throw new Error("usage: rtc_viewer.ts --node <url> | --issue owner/repo#n [--chrome <path>]");

const api = async (path: string, body?: unknown) => {
  const r = await fetch(`https://api.github.com/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ""}`, accept: "application/vnd.github+json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
};

/** The bench's answer to an offer: straight from it, or through the issue's comments. */
async function signal(peer: string, sdp: string): Promise<string> {
  if (nodeUrl) return (await fetch(`${nodeUrl}/offer`, { method: "POST", body: JSON.stringify({ peer, sdp }) })).text();
  const [repo, n] = issue!.split("#");
  await api(`repos/${repo}/issues/${n}/comments`, { body: `offer:${peer}:${Buffer.from(sdp).toString("base64")}` });
  for (let i = 0; i < 120; i++) {
    await Bun.sleep(1_000);
    const comments = (await api(`repos/${repo}/issues/${n}/comments?per_page=100`)) as { body: string }[];
    const a = comments.map((c) => c.body.trim().split(":")).find(([k, p]) => k === "answer" && p === peer);
    if (a?.[2]) return Buffer.from(a[2], "base64").toString();
  }
  throw new Error("no answer");
}

/** The bench's WebSocket through its tunnel, as its comment on the issue says. */
async function tunnelUrl(): Promise<string> {
  const [repo, n] = issue!.split("#");
  for (let i = 0; i < 60; i++) {
    const comments = (await api(`repos/${repo}/issues/${n}/comments?per_page=100`)) as { body: string }[];
    const ws = comments.map((c) => c.body.trim().split(":")).filter(([k]) => k === "ws").at(-1);
    if (ws?.[1]) return Buffer.from(ws[1], "base64").toString();
    await Bun.sleep(1_000);
  }
  throw new Error("no tunnel");
}

async function report(result: unknown): Promise<void> {
  if (nodeUrl) {
    await fetch(`${nodeUrl}/result`, { method: "POST", body: JSON.stringify(result) });
    return;
  }
  const [repo, n] = issue!.split("#");
  await api(`repos/${repo}/issues/${n}/comments`, { body: `result:${Buffer.from(JSON.stringify(result)).toString("base64")}` });
}

// The page: both transports, one program.
const PAGE = String.raw`<!doctype html><script>
const STUN = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
function b64bytes(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

// What came: each frame's arrival, its bytes, and when it was decoded.
function sink() {
  const s = { frames: [], decoded: new Map(), keyed: false, decoder: null };
  s.decoder = new VideoDecoder({ output: (p) => { s.decoded.set(p.timestamp / 1000, now()); p.close(); }, error: () => {} });
  s.decoder.configure({ codec: "avc1.640028", optimizeForLatency: true });
  s.take = (f) => {
    const at = now();
    s.frames.push({ seq: f.seq, at, bytes: f.data.length, kind: f.kind });
    if (f.kind === "jpeg") { s.decoded.set(f.seq, at); return; }
    if (!f.key && !s.keyed) return;
    if (f.key) s.keyed = true;
    s.decoder.decode(new EncodedVideoChunk({ type: f.key ? "key" : "delta", timestamp: f.seq * 1000, data: f.data }));
  };
  return s;
}

async function overWs(url) {
  const s = sink();
  const t0 = now();
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const f = JSON.parse(m.data);
    // Acked as it lands, as the desktop app's main acks (hub's frame_acks).
    ws.send(JSON.stringify({ t: "browser_frame_ack", seq: f.seq }));
    const b64 = f.h264B64 ?? f.jpegB64;
    s.take({ seq: f.seq, key: f.key === true, kind: f.h264B64 ? "h264" : "jpeg", data: b64bytes(b64) });
  };
  return { s, t0, input: (i) => ws.send(JSON.stringify({ t: "browser_input", input: i })), close: () => ws.close() };
}

async function overRtc(signal) {
  const s = sink();
  const t0 = now();
  const pc = new RTCPeerConnection({ iceServers: STUN.map((urls) => ({ urls })) });
  const frames = pc.createDataChannel("frames", { ordered: true });
  const input = pc.createDataChannel("input", { ordered: true });
  frames.binaryType = "arraybuffer";
  let head = null, parts = [], got = 0;
  frames.onmessage = (e) => {
    if (typeof e.data === "string") {
      const m = JSON.parse(e.data);
      if (m.t !== "frame") return;
      head = m; parts = []; got = 0;
      if (m.bytes > 0) return;
    } else { parts.push(new Uint8Array(e.data)); got += e.data.byteLength; if (!head || got < head.bytes) return; }
    const data = new Uint8Array(got); let at = 0; for (const p of parts) { data.set(p, at); at += p.length; }
    input.send(JSON.stringify({ t: "ack", seq: head.seq }));
    s.take({ seq: head.seq, key: head.key === true, kind: head.kind, data });
    head = null;
  };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => { if (pc.iceGatheringState === "complete") r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r(); setTimeout(r, 2000); });
  const tOffer = now();
  const answer = await signal(pc.localDescription.sdp);
  const tAnswer = now();
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
  await new Promise((r) => { const t = setInterval(() => { if (input.readyState === "open" && frames.readyState === "open") { clearInterval(t); r(); } }, 5); });
  const tOpen = now();
  // What ICE chose: the kinds of the two ends, never their addresses.
  let pair = null;
  for (const st of (await pc.getStats()).values()) if (st.type === "candidate-pair" && st.nominated && st.state === "succeeded") pair = st;
  let path = null;
  if (pair) {
    const stats = await pc.getStats();
    path = { local: stats.get(pair.localCandidateId)?.candidateType, remote: stats.get(pair.remoteCandidateId)?.candidateType, rttMs: pair.currentRoundTripTime * 1000 };
  }
  return { s, t0, timing: { gatherMs: tOffer - t0, signalMs: tAnswer - tOffer, iceMs: tOpen - tAnswer }, path, input: (i) => input.send(JSON.stringify({ t: "input", input: i })), close: () => pc.close() };
}

function spread(xs) { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); const q = (p) => s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null; return { p50: q(0.5), p95: q(0.95), n: s.length }; }
async function until(fn, ms) { const end = now() + ms; while (!fn()) { if (now() > end) return false; await sleep(1); } return true; }

async function program(t) {
  const { s } = t;
  await until(() => s.frames.length > 0, 15000);
  const first = s.frames[0] ? s.frames[0].at - t.t0 : null;
  await sleep(1500);
  const key = (k, text) => { t.input({ kind: "key", action: "down", key: k, ...(text ? { text } : {}), ...(k === "Enter" ? { code: "Enter" } : {}), modifiers: 0 }); t.input({ kind: "key", action: "up", key: k, modifiers: 0 }); };
  t.input({ kind: "mouse", action: "pressed", x: 200, y: 100, button: "left", clickCount: 1 });
  t.input({ kind: "mouse", action: "released", x: 200, y: 100, button: "left", clickCount: 1 });
  await sleep(500);
  const arrive = [], pixel = [];
  for (const ch of "fleetd screens over webrtc") {
    const n = s.frames.length;
    const at = now();
    key(ch, ch);
    if (!(await until(() => s.frames.length > n, 2000))) continue;
    const f = s.frames[n];
    arrive.push(f.at - at);
    if (await until(() => s.decoded.has(f.seq), 1000)) pixel.push(s.decoded.get(f.seq) - at);
    await sleep(120);
  }
  key("Enter");
  for (const ch of "go") key(ch, ch);
  key("Enter");
  await sleep(500);
  const n0 = s.frames.length, from = now();
  await sleep(5000);
  const inside = s.frames.slice(n0), secs = (now() - from) / 1000;
  const gaps = inside.slice(1).map((f, i) => f.at - inside[i].at);
  t.input({ kind: "key", action: "down", key: "Escape", modifiers: 0 });
  t.input({ kind: "key", action: "up", key: "Escape", modifiers: 0 });
  await sleep(1500);
  t.close();
  return {
    firstFrameMs: first === null ? null : Math.round(first),
    ...(t.timing ? { connect: Object.fromEntries(Object.entries(t.timing).map(([k, v]) => [k, Math.round(v)])) } : {}),
    ...(t.path ? { path: { local: t.path.local, remote: t.path.remote, rttMs: Math.round(t.path.rttMs * 10) / 10 } } : {}),
    keyToArrival: spread(arrive),
    keyToPixel: spread(pixel),
    scrolling: { fps: Math.round((inside.length / secs) * 10) / 10, kbPerSec: Math.round(inside.reduce((n, f) => n + f.bytes, 0) / secs / 1024), gapP95Ms: spread(gaps).p95, decoded: inside.filter((f) => s.decoded.has(f.seq)).length, frames: inside.length },
  };
}

window.run = async (wsUrl) => {
  const out = {};
  if (wsUrl) out.ws = await program(await overWs(wsUrl));
  out.rtc = await program(await overRtc(async (sdp) => (await fetch("/signal", { method: "POST", body: sdp })).text()));
  return out;
};
</script>`;

const page = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/signal") return new Response(await signal(`v${Date.now().toString(36)}`, await req.text()));
    return new Response(PAGE, { headers: { "content-type": "text/html" } });
  },
});

const dir = mkdtempSync(join(process.env.TMPDIR ?? process.env.RUNNER_TEMP ?? tmpdir(), "rtc-viewer-"));
const chrome = spawn(chromePath, ["--headless=new", `--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore", detached: true });
let port = "";
for (let i = 0; i < 200 && !port; i++) {
  await Bun.sleep(100);
  if (existsSync(join(dir, "DevToolsActivePort"))) port = readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0] ?? "";
}
const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
const cdp = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
await new Promise((r) => (cdp.onopen = r));
let ids = 0;
const call = (method: string, params: object) =>
  new Promise<{ result?: { value?: unknown }; exceptionDetails?: unknown }>((resolve) => {
    const id = ++ids;
    const on = (e: MessageEvent) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: never };
      if (m.id !== id) return;
      cdp.removeEventListener("message", on);
      resolve(m.result ?? {});
    };
    cdp.addEventListener("message", on);
    cdp.send(JSON.stringify({ id, method, params }));
  });
await call("Page.navigate", { url: `http://127.0.0.1:${page.port}/` });
await Bun.sleep(800);
const wsUrl = nodeUrl ? `${nodeUrl.replace(/^http/u, "ws")}${await (await fetch(`${nodeUrl}/ws-path`)).text()}` : await tunnelUrl();
const r = await call("Runtime.evaluate", { expression: `run(${JSON.stringify(wsUrl)})`, awaitPromise: true, returnByValue: true });
const result = r.result?.value ?? { error: JSON.stringify(r.exceptionDetails ?? r).slice(0, 500) };
console.log(JSON.stringify(result));
await report(result);
try {
  process.kill(-chrome.pid!, "SIGTERM");
} catch {}
page.stop(true);
rmSync(dir, { recursive: true, force: true });
process.exit(0);
