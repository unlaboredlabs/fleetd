// A stand-in X server for the desktop tests: never a real one (no Xvfb, no window manager, no xdotool). It speaks just
// what the node's X11 client sends (x11.ts): setup with an MIT cookie, QueryExtension (XTEST, DAMAGE),
// Get/ChangeKeyboardMapping, GetImage, QueryPointer, GetInputFocus, XTEST FakeInput and DAMAGE's requests. It keeps
// the screen's pixels, the pointer and every input it was given, and sends DamageNotify when the screen is painted.
//
// Run as a script it is a fake Xvfb: `fake_x.ts :N -screen 0 WxHx24 … -auth <file>`, listening at
// `$FAKE_X11_DIR/XN` with its lock in `$FAKE_X_LOCK_DIR/.XN-lock`, until it is killed.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

const XTEST = 132;
const DAMAGE = 143;
const DAMAGE_EVENT = 91;

export type Input = { type: number; detail: number; x: number; y: number };

const pad4 = (n: number) => (4 - (n % 4)) % 4;

export class FakeX {
  readonly inputs: Input[] = [];
  pointer: [number, number] = [0, 0];
  pixels: Uint8Array;
  readonly minKeycode = 8;
  readonly maxKeycode = 255;
  readonly per = 2;
  /** Keysyms by keycode, `per` each. */
  readonly syms: number[];
  readonly clients = new Set<{ socket: Socket; damage?: number }>();
  /** How many connections came through setup. */
  connections = 0;
  private server: Server | undefined;

  constructor(
    readonly cookie: Uint8Array,
    readonly width = 64,
    readonly height = 40,
    readonly damage = true,
  ) {
    this.pixels = new Uint8Array(width * height * 4);
    this.syms = Array((this.maxKeycode - this.minKeycode + 1) * this.per).fill(0);
    // A small US keyboard: letters, digits, space, Return and Shift_L; everything else free.
    const bind = (code: number, a: number, b = a) => {
      this.syms[(code - this.minKeycode) * this.per] = a;
      this.syms[(code - this.minKeycode) * this.per + 1] = b;
    };
    [..."abcdefghijklmnopqrstuvwxyz"].forEach((c, i) => bind(24 + i, c.charCodeAt(0), c.toUpperCase().charCodeAt(0)));
    [..."1234567890"].forEach((c, i) => bind(10 + i, c.charCodeAt(0)));
    bind(65, 0x20);
    bind(36, 0xff0d);
    bind(50, 0xffe1);
    bind(37, 0xffe3);
  }

  /** The keycode bound to `sym` now. */
  codeOf(sym: number): number | undefined {
    const i = this.syms.indexOf(sym);
    return i < 0 ? undefined : this.minKeycode + Math.floor(i / this.per);
  }

  listen(path: string): Promise<void> {
    this.server = createServer((socket) => this.serve(socket));
    return new Promise((resolve) => this.server!.listen(path, () => resolve()));
  }

  close(): void {
    for (const c of this.clients) c.socket.destroy();
    this.server?.close();
  }

  /** Paints the whole screen one colour (BGRA), and tells each client that asked for DAMAGE. */
  paint(b: number, g: number, r: number): void {
    for (let i = 0; i < this.pixels.length; i += 4) {
      this.pixels[i] = b;
      this.pixels[i + 1] = g;
      this.pixels[i + 2] = r;
    }
    for (const c of this.clients) {
      if (c.damage === undefined) continue;
      const ev = Buffer.alloc(32);
      ev[0] = DAMAGE_EVENT;
      ev.writeUInt32LE(c.damage, 4);
      c.socket.write(ev);
    }
  }

  private serve(socket: Socket): void {
    let buf = Buffer.alloc(0);
    let setUp = false;
    let seq = 0;
    const client: { socket: Socket; damage?: number } = { socket };
    socket.on("error", () => {});
    socket.on("close", () => this.clients.delete(client));
    const reply = (data: number, extra: Buffer = Buffer.alloc(0), head?: (b: Buffer) => void) => {
      const out = Buffer.alloc(32 + extra.length + pad4(extra.length));
      out[0] = 1;
      out[1] = data;
      out.writeUInt16LE(seq & 0xffff, 2);
      out.writeUInt32LE((extra.length + pad4(extra.length)) / 4, 4);
      head?.(out);
      extra.copy(out, 32);
      socket.write(out);
    };
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!setUp) {
        if (buf.length < 12) return;
        const nameLen = buf.readUInt16LE(6);
        const dataLen = buf.readUInt16LE(8);
        const size = 12 + nameLen + pad4(nameLen) + dataLen + pad4(dataLen);
        if (buf.length < size) return;
        const at = 12 + nameLen + pad4(nameLen);
        const given = buf.subarray(at, at + dataLen);
        buf = buf.subarray(size);
        if (!Buffer.from(this.cookie).equals(given)) {
          const why = Buffer.from("Invalid MIT-MAGIC-COOKIE-1 key");
          const out = Buffer.alloc(8 + why.length + pad4(why.length));
          out[1] = why.length;
          out.writeUInt16LE(11, 2);
          out.writeUInt16LE((why.length + pad4(why.length)) / 4, 6);
          why.copy(out, 8);
          socket.end(out);
          return;
        }
        setUp = true;
        this.connections++;
        this.clients.add(client);
        socket.write(this.setup());
      }
      while (buf.length >= 4) {
        const size = buf.readUInt16LE(2) * 4;
        if (size === 0 || buf.length < size) return;
        const req = buf.subarray(0, size);
        buf = buf.subarray(size);
        seq++;
        this.request(req, reply, client);
      }
    });
  }

  private setup(): Buffer {
    const vendor = Buffer.from("fleetd fake");
    const screen = Buffer.alloc(40);
    screen.writeUInt32LE(0x100, 0);
    screen.writeUInt16LE(this.width, 20);
    screen.writeUInt16LE(this.height, 22);
    screen[38] = 24;
    const body = Buffer.alloc(32 + vendor.length + pad4(vendor.length) + 8 + 40);
    body.writeUInt32LE(0x400000, 4); // resource id base
    body.writeUInt32LE(0x1fffff, 8); // mask
    body.writeUInt16LE(vendor.length, 16);
    body[20] = 1; // screens
    body[21] = 1; // formats
    body[22] = 0; // LSBFirst
    body[26] = this.minKeycode;
    body[27] = this.maxKeycode;
    vendor.copy(body, 32);
    body.set([24, 32, 32], 32 + vendor.length + pad4(vendor.length));
    screen.copy(body, 32 + vendor.length + pad4(vendor.length) + 8);
    const head = Buffer.alloc(8);
    head[0] = 1;
    head.writeUInt16LE(11, 2);
    head.writeUInt16LE(body.length / 4, 6);
    return Buffer.concat([head, body]);
  }

  private request(req: Buffer, reply: (data: number, extra?: Buffer, head?: (b: Buffer) => void) => void, client: { damage?: number }): void {
    switch (req[0]) {
      case 98: {
        const name = req.subarray(8, 8 + req.readUInt16LE(4)).toString("latin1");
        const found = name === "XTEST" ? XTEST : name === "DAMAGE" && this.damage ? DAMAGE : 0;
        return reply(0, undefined, (b) => {
          b[8] = found ? 1 : 0;
          b[9] = found;
          b[10] = found === DAMAGE ? DAMAGE_EVENT : 0;
        });
      }
      case XTEST:
        if (req[1] === 2) {
          const input = { type: req[4]!, detail: req[5]!, x: req.readInt16LE(24), y: req.readInt16LE(26) };
          if (input.type === 6) this.pointer = [input.x, input.y];
          this.inputs.push(input);
        }
        return;
      case DAMAGE:
        if (req[1] === 0) return reply(0, Buffer.alloc(0), (b) => (b.writeUInt32LE(1, 8), b.writeUInt32LE(1, 12)));
        if (req[1] === 1) client.damage = req.readUInt32LE(4);
        return;
      case 101: {
        const first = req[4]!;
        const count = req[5]!;
        const syms = this.syms.slice((first - this.minKeycode) * this.per, (first - this.minKeycode + count) * this.per);
        const extra = Buffer.alloc(syms.length * 4);
        syms.forEach((s, i) => extra.writeUInt32LE(s, i * 4));
        return reply(this.per, extra);
      }
      case 100: {
        const count = req[1]!;
        const first = req[4]!;
        const per = req[5]!;
        for (let i = 0; i < count * per; i++) this.syms[(first - this.minKeycode) * this.per + i] = req.readUInt32LE(8 + 4 * i);
        return;
      }
      case 73:
        return reply(24, Buffer.from(this.pixels));
      case 38:
        return reply(1, Buffer.alloc(0), (b) => {
          b.writeUInt32LE(0x100, 8);
          b.writeInt16LE(this.pointer[0], 16);
          b.writeInt16LE(this.pointer[1], 18);
        });
      case 43:
        return reply(0);
      default:
        return;
    }
  }
}

/** The cookie an X authority file names (its last field), as display.ts `xauth` writes it. */
export function cookieOf(file: Uint8Array): Uint8Array {
  let at = 2;
  let last: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < 4; i++) {
    const len = (file[at]! << 8) | file[at + 1]!;
    last = file.subarray(at + 2, at + 2 + len);
    at += 2 + len;
  }
  return last;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const number = Number(args.find((a) => a.startsWith(":"))!.slice(1));
  const auth = args[args.indexOf("-auth") + 1]!;
  const dir = process.env.FAKE_X11_DIR!;
  const lock = join(process.env.FAKE_X_LOCK_DIR!, `.X${number}-lock`);
  const socket = join(dir, `X${number}`);
  writeFileSync(lock, `${String(process.pid).padStart(10)}\n`);
  const [w, h] = (args[args.indexOf("-screen") + 2] ?? "64x40").split("x").map(Number);
  const x = new FakeX(cookieOf(readFileSync(auth)), w, h);
  x.paint(0, 0, 200);
  await x.listen(socket);
  console.log(`fake Xvfb on :${number}`);
  process.on("SIGTERM", () => {
    rmSync(socket, { force: true });
    rmSync(lock, { force: true });
    process.exit(0);
  });
}
