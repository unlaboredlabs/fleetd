const { mkdirSync, writeFileSync, renameSync, appendFileSync, readFileSync, rmSync, symlinkSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { timingSafeEqual } = require("node:crypto");
const secret = Buffer.from(process.env.FLEETD_BOX_SECRET || "");
const port = Number(process.env.FLEETD_BOOT_PORT);
const dir = process.env.FLEETD_BOOT_DIR;
mkdirSync(dir, { recursive: true, mode: 0o700 });
const bin = dir + "/fleetd";
const log = (m) => appendFileSync(dir + "/boot.log", new Date().toISOString() + " " + m + "\n");
let want = null, parts = [], got = 0, done = false;
const sha256 = (bytes) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
// A log line or error leaves out any URL's query: a signed link's signature is in it.
const noQuery = (t) => String(t).replace(/(https?:\/\/[^\s?#]*)[?#]\S*/g, "$1?…");
function finish(ws, bytes, way) {
  const sha = sha256(bytes);
  if (sha !== want.sha256) throw new Error("fleetd's SHA-256 is " + sha + ", not " + want.sha256);
  writeFileSync(bin + ".part", bytes, { mode: 0o755 });
  renameSync(bin + ".part", bin);
  run(ws, way);
}
// The template's own fleetd, when it is the very build the node asks for: started where it is, with nothing fetched.
function baked(ws) {
  const at = process.env.FLEETD_BOOT_BAKED;
  if (!at) return false;
  let bytes;
  try { bytes = readFileSync(at); } catch { return false; }
  if (sha256(bytes) !== want.sha256) { log("the template's fleetd is another build"); return false; }
  rmSync(bin, { force: true });
  symlinkSync(at, bin);
  log("the template's fleetd is the node's");
  run(ws, "template");
  return true;
}
function run(ws, way) {
  done = true;
  ws.send(JSON.stringify({ ok: true, way }));
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
    const h = Buffer.from(req.headers.get("{{SECRET_HEADER}}") || "");
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
          if (baked(ws)) return;
          if (want.url) {
            let host = "an address that isn't a URL";
            try { host = new URL(want.url).host; } catch {}
            log("fetching fleetd from " + host);
            let r;
            try { r = await fetch(want.url); } catch (e) { throw new Error("fetching fleetd from " + host + " failed: " + noQuery(e && e.message || e)); }
            if (!r.ok) throw new Error("fetching fleetd from " + host + " answered HTTP " + r.status);
            finish(ws, new Uint8Array(await r.arrayBuffer()), "address");
          }
          return;
        }
        parts.push(new Uint8Array(m)); got += m.length;
        if (got < want.size) return;
        const all = Buffer.concat(parts); parts = [];
        finish(ws, want.gzip ? Bun.gunzipSync(all) : all, "link");
      } catch (e) {
        log(noQuery(e && e.message || e));
        ws.send(JSON.stringify({ error: noQuery(e && e.message || e) }));
      }
    },
  },
});
log("listening");
