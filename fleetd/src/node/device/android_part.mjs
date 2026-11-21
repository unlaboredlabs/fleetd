// fleetd's Android part in a hosted box (../place/box_emulator.ts starts it): run by the box's own Bun beside the
// emulator, it starts scrcpy's server over the box's adb, decodes its H.264 with the box's ffmpeg into JPEGs, and
// serves them to whoever holds the session outside the box, one connection at a time on a port of the box's loopback
// (it writes which in its config's portFile; the box's
// guest dials it for the holder). A person's input comes back as scrcpy's control messages, encoded by the holder, and
// goes on the server's control socket as it is.
//
// A connection first sends the session's token and a newline; any other first line is closed. A new connection
// replaces the one before (the holder redialled, or another instance took the session over) and gets the newest frame
// at once. With none for `graceMs`, the part ends its stream and exits; the emulator stays for the session's end.
//
// Records, both ways: a u32 length (of what follows), a type byte, then the body. Part → holder: 1 a frame (u32 seq,
// then the JPEG), 2 a note (why the stream went, UTF-8). Holder → part: 3 control bytes, 4 stop.
//
// The config (argv[2], JSON): portFile, token, graceMs, adb, serial, env, jar, serverPath, scid, serverArgs, ffmpeg,
// decoderArgs. Everything is the holder's word: what it runs is pinned there (../device/pins.ts, scrcpy_wire.ts).
const { readFileSync, renameSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const net = require("node:net");
const { timingSafeEqual } = require("node:crypto");

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const env = { ...process.env, ...cfg.env };
/** Frames wait for a slow link no further than this: past it a frame is dropped, and the newest goes once it drains. */
const BACKLOG = 2 * 1024 * 1024;

let conn = null;
let newest = null;
let held = false;
let note = null;
let stopped = false;
let grace = null;
let server = null;
let decoder = null;
let video = null;
let control = null;
let forward = 0;

const log = (m) => process.stderr.write(`${new Date().toISOString()} ${m}\n`);
function record(type, body) {
  const out = Buffer.alloc(5 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out[4] = type;
  Buffer.from(body).copy(out, 5);
  return out;
}
function offer(rec, droppable) {
  if (!conn) return;
  if (droppable && conn.writableLength > BACKLOG) {
    held = true;
    return;
  }
  conn.write(rec);
}

function adb(args) {
  return new Promise((resolve) => {
    const c = spawn(cfg.adb, ["-s", cfg.serial, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("error", (e) => resolve({ code: -1, out, err: e.message }));
    c.on("close", (code) => resolve({ code, out, err }));
  });
}

function open(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => resolve(s));
    s.once("error", () => resolve(null));
  });
}
function first(s, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => done(null), ms);
    const done = (v) => {
      clearTimeout(t);
      s.pause();
      s.removeListener("data", onData);
      s.removeListener("close", onClose);
      resolve(v);
    };
    const onData = (d) => done(d);
    const onClose = () => done(null);
    s.on("data", onData);
    s.once("close", onClose);
  });
}

/** The video socket, then the control one, as scrcpy's server takes them (../device/scrcpy.ts `connect`). */
async function connect(port) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const v = await open(port);
    if (v) {
      const got = await first(v, 2_000);
      if (got && got.length >= 1) {
        const c = await open(port);
        if (!c) throw new Error("scrcpy's control socket did not connect");
        v.setNoDelay(true);
        c.setNoDelay(true);
        return { v, c, rest: got.subarray(1) };
      }
      v.destroy();
    }
    if (Date.now() > deadline) throw new Error("scrcpy's server did not answer in 10 s");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

async function start() {
  const pushed = await adb(["push", cfg.jar, cfg.serverPath]);
  if (pushed.code !== 0) throw new Error(`adb could not push scrcpy's server: ${pushed.err.trim()}`);
  const fwd = await adb(["forward", "tcp:0", `localabstract:scrcpy_${cfg.scid}`]);
  forward = Number(fwd.out.trim());
  if (!Number.isInteger(forward) || forward <= 0) throw new Error(`adb did not forward a port: ${fwd.err.trim()}`);
  server = spawn(cfg.adb, ["-s", cfg.serial, "shell", ...cfg.serverArgs], { env, stdio: "ignore" });
  server.on("error", () => {});
  const { v, c, rest } = await connect(forward);
  video = v;
  control = c;
  control.on("error", () => {});
  control.on("data", () => {});
  decoder = spawn(cfg.ffmpeg, cfg.decoderArgs, { stdio: ["pipe", "pipe", "ignore"] });
  decoder.on("error", (e) => fail(`cannot start ffmpeg: ${e.message}`));
  decoder.stdin.on("error", () => {});
  if (rest.length) decoder.stdin.write(rest);
  video.pipe(decoder.stdin);
  video.resume();
  video.on("error", () => {});
  video.once("close", () => fail("the screen's stream ended"));
  decoder.once("close", () => fail("the screen's decoder stopped"));
  let buf = Buffer.alloc(0);
  let seq = 0;
  decoder.stdout.on("data", (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (;;) {
      const s = buf.indexOf(SOI);
      if (s < 0) return void (buf = Buffer.alloc(0));
      const e = buf.indexOf(EOI, s + 2);
      if (e < 0) return void (buf = buf.subarray(s));
      const jpeg = buf.subarray(s, e + 2);
      buf = buf.subarray(e + 2);
      const body = Buffer.alloc(4 + jpeg.length);
      body.writeUInt32BE(++seq >>> 0, 0);
      jpeg.copy(body, 4);
      newest = record(1, body);
      offer(newest, true);
    }
  });
}

function end() {
  for (const c of [server, decoder]) {
    try {
      c?.kill("SIGKILL");
    } catch {}
  }
  video?.destroy();
  control?.destroy();
}

function fail(why) {
  if (stopped || note) return;
  note = why;
  log(why);
  end();
  offer(record(2, Buffer.from(why)), false);
}

async function stop() {
  if (stopped) return;
  stopped = true;
  end();
  if (forward) await adb(["forward", "--remove", `tcp:${forward}`]);
  conn?.end();
  listener.close();
  setTimeout(() => process.exit(0), 100);
}

const arm = () => {
  clearTimeout(grace);
  grace = setTimeout(() => void stop(), cfg.graceMs);
};

const token = Buffer.from(String(cfg.token));
const listener = net.createServer((sock) => {
  sock.on("error", () => {});
  let buf = Buffer.alloc(0);
  let mine = false;
  sock.on("data", (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    if (!mine) {
      const nl = buf.indexOf(10);
      if (nl < 0) return void (buf.length > 256 && sock.destroy());
      const said = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      if (said.length !== token.length || !timingSafeEqual(said, token)) return void sock.destroy();
      mine = true;
      if (conn && conn !== sock) conn.destroy();
      conn = sock;
      clearTimeout(grace);
      sock.on("drain", () => {
        if (held && newest && conn === sock) {
          held = false;
          sock.write(newest);
        }
      });
      if (note) sock.write(record(2, Buffer.from(note)));
      else if (newest) sock.write(newest);
    }
    while (buf.length >= 5) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      const type = buf[4];
      const body = buf.subarray(5, 4 + len);
      buf = buf.subarray(4 + len);
      if (type === 3) control?.write(body);
      else if (type === 4) void stop();
    }
  });
  sock.once("close", () => {
    if (conn !== sock) return;
    conn = null;
    arm();
  });
});
listener.once("error", (e) => {
  log(`cannot listen: ${e.message}`);
  process.exit(1);
});
// A port of its own choosing, said in `portFile` once it listens: the holder reads it there.
listener.listen(0, "127.0.0.1", () => {
  writeFileSync(`${cfg.portFile}.part`, String(listener.address().port));
  renameSync(`${cfg.portFile}.part`, cfg.portFile);
});
arm();
start().catch((e) => fail(e.message));
