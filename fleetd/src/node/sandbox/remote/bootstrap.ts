// How the node's own fleetd reaches a hosted box. A provider's template holds the base recipe and Claude Code only,
// so it doesn't change with every fleetd build; each box starts this small script under the template's Bun instead
// (`bootArgv`), on the guest's port, taking a WebSocket only with the box's secret, as the guest does. Over that one
// link the node hands it its fleetd (`deliver`): the URL of this very build's release asset, which the box fetches
// itself, or, where there is none (a build of one's own), the binary's bytes. The script checks the SHA-256, then
// runs `fleetd sandbox-guest` on the same port and waits on it: the node dials again and finds the guest.
//
// The script's text holds no value: the secret is its environment's, given at start, never at create.
import type { Duplex as WebDuplex } from "../../../sandbox/providers/index.ts";
import { GUEST_PORT, SECRET_HEADER } from "../../../sandbox/providers/index.ts";

/** Where the box keeps fleetd and the guest's files: the box user's own, outside any path the node mirrors. */
export const BOX_DIR = "/tmp/.fleetd-box";

const SCRIPT = `
const { mkdirSync, writeFileSync, renameSync, appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { timingSafeEqual } = require("node:crypto");
const secret = Buffer.from(process.env.FLEETD_BOX_SECRET || "");
const port = Number(process.env.FLEETD_BOOT_PORT);
const dir = process.env.FLEETD_BOOT_DIR;
mkdirSync(dir, { recursive: true, mode: 0o700 });
const bin = dir + "/fleetd";
const log = (m) => appendFileSync(dir + "/boot.log", new Date().toISOString() + " " + m + "\\n");
let want = null, parts = [], got = 0, done = false;
function finish(ws, bytes) {
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (sha !== want.sha256) throw new Error("fleetd's SHA-256 is " + sha + ", not " + want.sha256);
  writeFileSync(bin + ".part", bytes, { mode: 0o755 });
  renameSync(bin + ".part", bin);
  done = true;
  ws.send(JSON.stringify({ ok: true }));
  setTimeout(() => {
    server.stop(true);
    log("starting the guest");
    const loop = process.env.FLEETD_BOOT_LOOPBACK ? ["--loopback", process.env.FLEETD_BOOT_LOOPBACK] : [];
    const g = spawn(bin, ["sandbox-guest", "--port", String(port), "--dir", dir + "/guest", ...loop], { stdio: ["ignore", "inherit", "inherit"] });
    g.on("exit", (code) => process.exit(code ?? 1));
  }, 200);
}
const server = Bun.serve({
  port, hostname: "0.0.0.0",
  fetch(req, s) {
    const h = Buffer.from(req.headers.get("${SECRET_HEADER}") || "");
    if (secret.length < 16 || h.length !== secret.length || !timingSafeEqual(h, secret)) return new Response("no", { status: 403 });
    return s.upgrade(req) ? undefined : new Response("a WebSocket only", { status: 426 });
  },
  websocket: {
    maxPayloadLength: 8 << 20, idleTimeout: 0,
    open(ws) { ws.send(JSON.stringify({ bootstrap: 1 })); },
    async message(ws, m) {
      if (done) return;
      try {
        if (typeof m === "string") {
          want = JSON.parse(m); parts = []; got = 0;
          if (want.url) {
            log("fetching fleetd");
            const r = await fetch(want.url);
            if (!r.ok) throw new Error("fetching fleetd answered HTTP " + r.status);
            finish(ws, new Uint8Array(await r.arrayBuffer()));
          }
          return;
        }
        parts.push(new Uint8Array(m)); got += m.length;
        if (got < want.size) return;
        const all = Buffer.concat(parts); parts = [];
        finish(ws, want.gzip ? Bun.gunzipSync(all) : all);
      } catch (e) {
        log(String(e && e.message || e));
        ws.send(JSON.stringify({ error: String(e && e.message || e) }));
      }
    },
  },
});
log("listening");
`;

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The box's first command and its environment besides the secret. It first makes `dirs` (outermost first) the box
 * user's, with sudo where the user can't: the machine's paths the session's files take, the node.sock's among them,
 * which the guest listens at as soon as the node dials. */
export function bootArgv(dirs: string[] = []): { argv: string[]; env: Record<string, string> } {
  const make = [...new Set(dirs.filter((d) => d.startsWith("/") && d !== "/"))]
    .sort((a, b) => a.length - b.length)
    .map((d) => `d=${shq(d)}; [ -d "$d" ] || mkdir -p "$d" 2>/dev/null || sudo -n mkdir -p "$d"; [ -w "$d" ] || sudo -n chown "$(id -u):$(id -g)" "$d"`);
  return {
    argv: ["sh", "-c", [...make, `exec bun -e ${shq(SCRIPT)}`].join("; ")],
    env: { FLEETD_BOOT_PORT: String(GUEST_PORT), FLEETD_BOOT_DIR: BOX_DIR },
  };
}

/** Where the node's fleetd comes from: its release asset's URL when it has one, and its bytes otherwise. */
export type Source = { sha256: string; url?: string; bytes: () => Promise<Uint8Array> };

/** The most bytes sent in one WebSocket message. */
const PIECE = 1 << 20;

/** What the box's first message on a fresh link says it is: the bootstrap, or the guest itself (its mux frames);
 * undefined when the link closed first (a provider's proxy takes a link before anything in the box listens). */
export async function firstWord(link: WebDuplex): Promise<"bootstrap" | "guest" | undefined> {
  const reader = link.readable.getReader();
  try {
    const { value } = await Promise.race([reader.read(), Bun.sleep(10_000).then(() => ({ value: undefined }))]);
    if (!value) return undefined;
    return value[0] === 0x7b && new TextDecoder().decode(value).includes('"bootstrap"') ? "bootstrap" : "guest";
  } finally {
    reader.releaseLock();
  }
}

/** Hands the bootstrap on `link` this node's fleetd; resolves once the box checked it and starts the guest. */
export async function deliver(link: WebDuplex, source: Source): Promise<void> {
  const reader = link.readable.getReader();
  const writer = link.writable.getWriter();
  const answer = async (): Promise<{ ok?: boolean; error?: string }> => {
    const { value, done } = await Promise.race([reader.read(), Bun.sleep(180_000).then(() => ({ value: undefined, done: true }))]);
    if (done || !value) throw new Error("the box didn't say whether it took fleetd");
    return JSON.parse(new TextDecoder().decode(value)) as { ok?: boolean; error?: string };
  };
  try {
    if (source.url) {
      await sendText(link, writer, { url: source.url, sha256: source.sha256 });
      const a = await answer();
      if (a.ok) return;
    }
    const plain = await source.bytes();
    const packed = Bun.gzipSync(plain as Uint8Array<ArrayBuffer>, { level: 1 });
    await sendText(link, writer, { size: packed.length, sha256: source.sha256, gzip: true });
    for (let at = 0; at < packed.length; at += PIECE) await writer.write(packed.subarray(at, at + PIECE));
    const a = await answer();
    if (!a.ok) throw new Error(`the box didn't take fleetd: ${a.error ?? "no reason given"}`);
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

/** A WebSocket text message (the stream's writes go as binary ones, which the script takes as fleetd's bytes). */
async function sendText(link: WebDuplex, writer: WritableStreamDefaultWriter<Uint8Array>, o: unknown): Promise<void> {
  await writer.ready;
  link.sendText(JSON.stringify(o));
}
