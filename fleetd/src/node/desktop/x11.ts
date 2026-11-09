// The node's own X11 connection to a session's display (crates/fleetd/src/node/desktop/x11.rs), over its socket with
// the display's cookie: the screen as JPEG (GetImage, with DAMAGE saying when it changed), and the agent's and a
// person's input through XTEST, as xdotool sends it. Nothing else reaches the display but the session's own apps.
//
// The wire protocol is spoken here directly (little-endian), only the requests the node needs: QueryExtension,
// GetKeyboardMapping and ChangeKeyboardMapping, GetImage, QueryPointer, GetInputFocus (a round trip, for sync), XTEST
// FakeInput and DAMAGE's QueryVersion, Create and Subtract.
import { connect as netConnect, type Socket } from "node:net";
import { jpeg, type Raw, type Screen } from "./screen.ts";

const NO_SYMBOL = 0;
const SHIFT_L = 0xffe1;

const KEY_PRESS = 2;
const KEY_RELEASE = 3;
const BUTTON_PRESS = 4;
const BUTTON_RELEASE = 5;
const MOTION_NOTIFY = 6;
const MAPPING_NOTIFY = 34;
const GENERIC_EVENT = 35;

/** How long the node waits for a display's socket to answer. */
export const CONNECT_TIMEOUT = 20_000;
/** How long one round trip may take before the display counts as gone. */
const REPLY_TIMEOUT = 15_000;

const pad4 = (n: number) => (4 - (n % 4)) % 4;
const xErr = (e: unknown) => `the X display: ${e instanceof Error ? e.message : String(e)}`;

/** The display's keyboard mapping, as the node last read or changed it. */
class Keymap {
  /** A keycode with nothing on it, bound to each keysym the map lacks while it is typed. */
  scratch: number | undefined;
  constructor(
    readonly min: number,
    readonly per: number,
    readonly syms: number[],
  ) {}

  /** The keycode for a keysym, and whether Shift picks it there. */
  find(sym: number): [number, boolean] | undefined {
    const per = Math.max(1, this.per);
    for (let i = 0; i * per < this.syms.length; i++) {
      const code = this.min + i;
      if (code > 255) return undefined;
      const at = this.syms.slice(i * per, i * per + Math.min(2, per)).indexOf(sym);
      if (at >= 0) return [code, at > 0];
    }
    return undefined;
  }
}

type Pending = { resolve: (reply: Buffer) => void; reject: (e: Error) => void };

/** One connection: requests out, replies matched by sequence number, events and errors as they come. */
class Wire {
  private buf: Buffer = Buffer.alloc(0);
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private closed: Error | undefined;
  onEvent: (event: Buffer) => void = () => {};

  constructor(
    private readonly socket: Socket,
    rest: Buffer,
  ) {
    if (rest.length) queueMicrotask(() => this.data(rest));
    socket.on("data", (chunk: Buffer) => this.data(chunk));
    socket.on("error", (e) => this.close(e));
    socket.on("close", () => this.close(new Error("the X server closed the connection")));
  }

  private close(e: Error): void {
    if (this.closed) return;
    this.closed = e;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private data(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 32) {
      const kind = this.buf[0]!;
      const long = kind === 1 || (kind & 0x7f) === GENERIC_EVENT;
      const size = long ? 32 + this.buf.readUInt32LE(4) * 4 : 32;
      if (this.buf.length < size) return;
      const message = this.buf.subarray(0, size);
      this.buf = this.buf.subarray(size);
      const seq = message.readUInt16LE(2);
      if (kind === 1) {
        const p = this.pending.get(seq);
        this.pending.delete(seq);
        p?.resolve(Buffer.from(message));
      } else if (kind === 0) {
        const p = this.pending.get(seq);
        this.pending.delete(seq);
        // A request that has no reply fails quietly, as x11rb's unchecked requests do.
        p?.reject(new Error(`X error ${message[1]} (request ${message[10]}.${message.readUInt16LE(8)})`));
      } else this.onEvent(Buffer.from(message));
    }
  }

  /** Sends one request; its sequence number. */
  send(request: Uint8Array): number {
    if (this.closed) throw this.closed;
    this.socket.write(request);
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  /** Sends one request that has a reply, and waits for it. */
  ask(request: Uint8Array): Promise<Buffer> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`no reply within ${REPLY_TIMEOUT / 1000} s`));
      }, REPLY_TIMEOUT);
      const seq = this.send(request);
      this.pending.set(seq, {
        resolve: (b) => (clearTimeout(timer), resolve(b)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  end(): void {
    this.close(new Error("the X connection is closed"));
    this.socket.destroy();
  }
}

/** A request: its opcode, its data byte and its body, its length filled in. */
function request(opcode: number, data: number, body: Uint8Array = new Uint8Array(0)): Buffer {
  const out = Buffer.alloc(4 + body.length + pad4(body.length));
  out[0] = opcode;
  out[1] = data;
  out.writeUInt16LE(out.length / 4, 2);
  out.set(body, 4);
  return out;
}

function body(size: number, fill: (b: Buffer) => void): Buffer {
  const b = Buffer.alloc(size);
  fill(b);
  return b;
}

/** The connection setup's request, authorized by an MIT cookie. */
export function setupRequest(cookie: Uint8Array): Buffer {
  const name = Buffer.from("MIT-MAGIC-COOKIE-1");
  const out = Buffer.alloc(12 + name.length + pad4(name.length) + cookie.length + pad4(cookie.length));
  out[0] = 0x6c; // 'l': little-endian
  out.writeUInt16LE(11, 2);
  out.writeUInt16LE(0, 4);
  out.writeUInt16LE(name.length, 6);
  out.writeUInt16LE(cookie.length, 8);
  out.set(name, 12);
  out.set(cookie, 12 + name.length + pad4(name.length));
  return out;
}

type Setup = {
  ridBase: number;
  ridMask: number;
  lsbFirst: boolean;
  minKeycode: number;
  maxKeycode: number;
  root: number;
  width: number;
  height: number;
};

/** Reads the server's answer to setup off the socket. */
function readSetup(socket: Socket): Promise<{ setup: Setup; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const fail = (e: Error) => (cleanup(), reject(e));
    const closed = () => fail(new Error("the X server closed the connection"));
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", closed);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 8) return;
      const size = 8 + buf.readUInt16LE(6) * 4;
      if (buf.length < size) return;
      cleanup();
      const rest = Buffer.from(buf.subarray(size));
      if (buf[0] !== 1) {
        const why = buf[0] === 0 ? buf.subarray(8, 8 + buf[1]!).toString("latin1") : "it asks for more authentication";
        return reject(new Error(`the X server refused the connection: ${why.trim()}`));
      }
      const vendor = buf.readUInt16LE(24);
      const formats = buf[29]!;
      const screens = buf[28]!;
      if (screens < 1) return reject(new Error("the X display has no screen"));
      const at = 40 + vendor + pad4(vendor) + 8 * formats;
      // Whatever came after setup (an event) goes to the connection.
      resolve({ rest, setup: {
        ridBase: buf.readUInt32LE(12),
        ridMask: buf.readUInt32LE(16),
        lsbFirst: buf[30] === 0,
        minKeycode: buf[34]!,
        maxKeycode: buf[35]!,
        root: buf.readUInt32LE(at),
        width: buf.readUInt16LE(at + 20),
        height: buf.readUInt16LE(at + 22),
      } });
    };
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("close", closed);
  });
}

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(path);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (e) => reject(new Error(`cannot reach ${path}: ${e.message}`)));
  });
}

export class X implements Screen {
  private damaged = true;
  private keys: Keymap;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly wire: Wire,
    private readonly setup: Setup,
    keys: Keymap,
    private readonly xtest: number,
    private readonly damage: { major: number; event: number; id: number } | undefined,
  ) {
    this.keys = keys;
    wire.onEvent = (event) => this.event(event);
  }

  /** Connects to the X server at `socket`, authorized by its MIT cookie. */
  static async connect(socket: string, cookie: Uint8Array): Promise<X> {
    const s = await connectSocket(socket);
    try {
      s.write(setupRequest(cookie));
      const { setup, rest } = await readSetup(s);
      const wire = new Wire(s, rest);
      const ext = async (name: string) => {
        const n = Buffer.from(name);
        const reply = await wire.ask(request(98, 0, body(4 + n.length, (b) => (b.writeUInt16LE(n.length, 0), b.set(n, 4)))));
        return reply[8] ? { major: reply[9]!, event: reply[10]! } : undefined;
      };
      const xtest = await ext("XTEST").catch((e) => Promise.reject(new Error(xErr(e))));
      if (!xtest) throw new Error("the X display has no XTEST extension");
      let damage: { major: number; event: number; id: number } | undefined;
      try {
        const found = await ext("DAMAGE");
        if (found) {
          await wire.ask(request(found.major, 0, body(8, (b) => (b.writeUInt32LE(1, 0), b.writeUInt32LE(1, 4)))));
          const id = setup.ridBase | (1 & setup.ridMask);
          // ReportLevel NonEmpty: one notify until the node subtracts it.
          wire.send(request(found.major, 1, body(12, (b) => (b.writeUInt32LE(id, 0), b.writeUInt32LE(setup.root, 4), (b[8] = 3)))));
          damage = { ...found, id };
        }
      } catch {
        damage = undefined;
      }
      const keys = await readKeymap(wire, setup.minKeycode, setup.maxKeycode);
      return new X(wire, setup, keys, xtest.major, damage);
    } catch (e) {
      s.destroy();
      throw e instanceof Error && e.message.startsWith("the X") ? e : new Error(xErr(e));
    }
  }

  private event(event: Buffer): void {
    const code = event[0]! & 0x7f;
    if (this.damage && code === this.damage.event) this.damaged = true;
    else if (code === MAPPING_NOTIFY) {
      void readKeymap(this.wire, this.keys.min, this.setup.maxKeycode)
        .then((keys) => {
          keys.scratch = this.keys.scratch;
          this.keys = keys;
        })
        .catch(() => {});
    }
  }

  close(): void {
    this.wire.end();
  }

  size(): [number, number] {
    return [this.setup.width, this.setup.height];
  }

  /** Whether the screen may have changed since the last call: always without DAMAGE. */
  changed(): boolean {
    if (!this.damage) return true;
    const changed = this.damaged;
    if (changed) {
      this.damaged = false;
      try {
        this.wire.send(request(this.damage.major, 3, body(12, (b) => b.writeUInt32LE(this.damage!.id, 0))));
      } catch {}
    }
    return changed;
  }

  /** The screen's pixels as the server sends them (32 bits each). */
  async grabRaw(): Promise<Raw> {
    const [width, height] = this.size();
    const reply = await this.wire
      .ask(
        request(
          73,
          2, // ZPixmap
          body(16, (b) => {
            b.writeUInt32LE(this.setup.root, 0);
            b.writeUInt16LE(width, 8);
            b.writeUInt16LE(height, 10);
            b.writeUInt32LE(0xffffffff, 12);
          }),
        ),
      )
      .catch((e) => Promise.reject(new Error(xErr(e))));
    const data = reply.subarray(32);
    if (data.length < width * height * 4) {
      throw new Error(`the X display sent ${data.length} bytes for a ${width}x${height} screen; it needs 24-bit color`);
    }
    return { data: data.subarray(0, width * height * 4), width, height };
  }

  /** A raw grab as a JPEG. */
  encode(raw: Raw): Promise<Uint8Array> {
    if (this.setup.lsbFirst) return jpeg(raw.data, raw.width, raw.height);
    // xRGB, most significant byte first: the same bytes reversed in each pixel.
    const flipped = new Uint8Array(raw.data.length);
    for (let i = 0; i < raw.data.length; i += 4) {
      flipped[i] = raw.data[i + 3]!;
      flipped[i + 1] = raw.data[i + 2]!;
      flipped[i + 2] = raw.data[i + 1]!;
      flipped[i + 3] = raw.data[i]!;
    }
    return jpeg(flipped, raw.width, raw.height);
  }

  async grab(): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
    const raw = await this.grabRaw();
    return { jpeg: await this.encode(raw), width: raw.width, height: raw.height };
  }

  private fake(type: number, detail: number, x = 0, y = 0): void {
    try {
      this.wire.send(
        request(
          this.xtest,
          2, // FakeInput
          body(32, (b) => {
            b[0] = type;
            b[1] = detail;
            b.writeUInt32LE(this.setup.root, 8);
            b.writeInt16LE(x, 20);
            b.writeInt16LE(y, 22);
          }),
        ),
      );
    } catch (e) {
      throw new Error(xErr(e));
    }
  }

  /** Waits until the server has done everything sent so far. */
  async sync(): Promise<void> {
    await this.wire.ask(request(43, 0)).catch((e) => Promise.reject(new Error(xErr(e))));
  }

  private clamp(x: number, y: number): [number, number] {
    const [w, h] = this.size();
    return [Math.max(0, Math.min(Math.max(0, w - 1), Math.trunc(x))), Math.max(0, Math.min(Math.max(0, h - 1), Math.trunc(y)))];
  }

  async moveTo(x: number, y: number): Promise<void> {
    const [cx, cy] = this.clamp(x, y);
    this.fake(MOTION_NOTIFY, 0, cx, cy);
  }

  /** Presses or releases a mouse button (1 left, 2 middle, 3 right, 4-7 the wheel). */
  async button(button: number, down: boolean): Promise<void> {
    this.fake(down ? BUTTON_PRESS : BUTTON_RELEASE, button);
  }

  async click(x: number, y: number, button: number, count: number): Promise<void> {
    await this.moveTo(x, y);
    for (let i = 0; i < count; i++) {
      await this.button(button, true);
      await this.button(button, false);
    }
    await this.sync();
  }

  async drag(from: [number, number], to: [number, number]): Promise<void> {
    await this.moveTo(from[0], from[1]);
    await this.button(1, true);
    await this.sync();
    // A few steps on the way, for apps that only start a drag once the pointer moves.
    for (let step = 1; step <= 4; step++) {
      const at = (a: number, b: number) => a + Math.trunc(((b - a) * step) / 4);
      await this.moveTo(at(from[0], to[0]), at(from[1], to[1]));
    }
    await this.button(1, false);
    await this.sync();
  }

  /** Wheel clicks at a point: `dy` > 0 scrolls down, `dx` > 0 right. */
  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    await this.moveTo(x, y);
    const wheel = async (button: number, n: number) => {
      for (let i = 0; i < Math.min(Math.abs(n), 50); i++) {
        await this.button(button, true);
        await this.button(button, false);
      }
    };
    await wheel(dy < 0 ? 4 : 5, dy);
    await wheel(dx < 0 ? 6 : 7, dx);
    await this.sync();
  }

  async pointer(): Promise<[number, number]> {
    const reply = await this.wire
      .ask(request(38, 0, body(4, (b) => b.writeUInt32LE(this.setup.root, 0))))
      .catch((e) => Promise.reject(new Error(xErr(e))));
    return [reply.readInt16LE(16), reply.readInt16LE(18)];
  }

  /** The keycode for a keysym, binding it to the scratch keycode when the keyboard lacks it; and whether Shift picks
   * it. */
  private async keycode(sym: number): Promise<[number, boolean]> {
    const keys = this.keys;
    const found = keys.find(sym);
    if (found) return found;
    const per = Math.max(1, keys.per);
    if (keys.scratch === undefined) {
      let empty = -1;
      for (let i = Math.floor(keys.syms.length / per) - 1; i >= 0; i--) {
        if (keys.syms.slice(i * per, i * per + per).every((s) => s === NO_SYMBOL)) {
          empty = i;
          break;
        }
      }
      if (empty < 0 || keys.min + empty > 255) throw new Error("the keyboard has no free keycode to type this with");
      keys.scratch = keys.min + empty;
    }
    const scratch = keys.scratch;
    const row = Array<number>(per).fill(sym);
    this.wire.send(
      request(
        100,
        1,
        body(4 + 4 * per, (b) => {
          b[0] = scratch;
          b[1] = per;
          row.forEach((s, i) => b.writeUInt32LE(s, 4 + 4 * i));
        }),
      ),
    );
    const start = (scratch - keys.min) * per;
    keys.syms.splice(start, per, ...row);
    await this.sync();
    return [scratch, false];
  }

  /** Presses or releases one key by keysym; Shift goes with it where the keyboard needs it, when `shift` allows. */
  async keySym(sym: number, down: boolean, shift: boolean): Promise<void> {
    const [code, needsShift] = await this.keycode(sym);
    const shiftCode = needsShift && shift ? (await this.keycode(SHIFT_L))[0] : undefined;
    if (down && shiftCode !== undefined) this.fake(KEY_PRESS, shiftCode);
    this.fake(down ? KEY_PRESS : KEY_RELEASE, code);
    if (!down && shiftCode !== undefined) this.fake(KEY_RELEASE, shiftCode);
  }

  /** A chord as xdotool names it (`ctrl+shift+t`): every key pressed in order, then released in reverse. */
  async chord(chord: string): Promise<void> {
    const syms = parseChord(chord);
    const shifted = syms.length === 1;
    for (const sym of syms) await this.keySym(sym, true, shifted);
    for (const sym of [...syms].reverse()) await this.keySym(sym, false, shifted);
    await this.sync();
  }

  /** Types text, a key per character. */
  async typeText(text: string): Promise<void> {
    for (const c of text) {
      const sym = charKeysym(c);
      await this.keySym(sym, true, true);
      await this.keySym(sym, false, true);
      // Each key is done before the next, as xdotool's own small delay makes sure.
      await this.sync();
    }
  }

  /** Runs `fn` after every action queued before it: one action at a time on this connection. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
}

async function readKeymap(wire: Wire, min: number, max: number): Promise<Keymap> {
  const reply = await wire.ask(request(101, 0, body(4, (b) => ((b[0] = min), (b[1] = max - min + 1)))));
  const per = reply[1]!;
  const count = reply.readUInt32LE(4);
  const syms: number[] = [];
  for (let i = 0; i < count; i++) syms.push(reply.readUInt32LE(32 + 4 * i));
  return new Keymap(min, per, syms);
}

/** A character's keysym: Latin-1 as itself, the rest of Unicode as X maps it; newline and tab as their keys. */
export function charKeysym(c: string): number {
  const code = c.codePointAt(0) ?? 0;
  if (c === "\n" || c === "\r") return 0xff0d;
  if (c === "\t") return 0xff09;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return 0x0100_0000 | code;
}

const NAMED: Record<string, number> = {
  return: 0xff0d, enter: 0xff0d, kp_enter: 0xff0d,
  tab: 0xff09,
  escape: 0xff1b, esc: 0xff1b,
  backspace: 0xff08,
  delete: 0xffff, del: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  page_up: 0xff55, prior: 0xff55, pageup: 0xff55,
  page_down: 0xff56, next: 0xff56, pagedown: 0xff56,
  left: 0xff51, arrowleft: 0xff51,
  up: 0xff52, arrowup: 0xff52,
  right: 0xff53, arrowright: 0xff53,
  down: 0xff54, arrowdown: 0xff54,
  space: 0x20,
  menu: 0xff67, contextmenu: 0xff67,
  print: 0xff61, printscreen: 0xff61,
  caps_lock: 0xffe5, capslock: 0xffe5,
  shift: SHIFT_L, shift_l: SHIFT_L,
  shift_r: 0xffe2,
  ctrl: 0xffe3, control: 0xffe3, control_l: 0xffe3,
  control_r: 0xffe4,
  alt: 0xffe9, alt_l: 0xffe9, option: 0xffe9, opt: 0xffe9,
  alt_r: 0xffea, altgraph: 0xffea,
  super: 0xffeb, super_l: 0xffeb, meta: 0xffeb, win: 0xffeb, cmd: 0xffeb, command: 0xffeb, os: 0xffeb,
  super_r: 0xffec,
  minus: 0x2d,
  plus: 0x2b,
  equal: 0x3d,
  comma: 0x2c,
  period: 0x2e,
  slash: 0x2f,
  backslash: 0x5c,
  semicolon: 0x3b,
  apostrophe: 0x27,
  grave: 0x60,
  bracketleft: 0x5b,
  bracketright: 0x5d,
};

/** A key's keysym by its xdotool (X keysym) name, its browser `KeyboardEvent.key` name, or the character it types. */
export function keysym(name: string): number | undefined {
  const chars = [...name];
  if (chars.length === 1) return charKeysym(chars[0]!);
  const f = /^[Ff](\d+)$/.exec(name);
  if (f) {
    const n = Number(f[1]);
    if (n >= 1 && n <= 24) return 0xffbe + n - 1;
  }
  return Object.hasOwn(NAMED, name.toLowerCase()) ? NAMED[name.toLowerCase()] : undefined;
}

/** `ctrl+shift+t` as keysyms, in order. */
export function parseChord(chord: string): number[] {
  const names = chord === "+" ? ["+"] : chord.split("+").map((n) => n.trim());
  return names.map((name) => {
    if (!name) throw new Error(`\`${chord}\` names an empty key`);
    const sym = keysym(name);
    if (sym === undefined) throw new Error(`\`${name}\` is not a key name (use xdotool's: Return, ctrl+s, alt+F4, Page_Down)`);
    return sym;
  });
}
