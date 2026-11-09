// A node link's silence is timed by bytes arriving, not whole frames (Rust's hub/http/counted.rs): one large frame
// coming in slowly keeps its machine online, and a link where nothing arrives still goes offline.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { Socket } from "bun";
import { type Peer, parseSs, ReadCounts } from "../src/hub/http/counted.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { link } from "../src/hub/link/index.ts";
import { build } from "../src/hub/serve/index.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";
import { FakeNode, nodeKey } from "./fake-node.ts";
import { hubHome } from "./helpers.ts";

const home = hubHome();
const { hub, tools } = build(home.dir, { host: "127.0.0.1", port: 0 });
const server = serve(hub, tools, 0);
const links = link(hub);
const realCounts = links.readCounts;
links.timings = { ...links.timings, silenceMs: 1000, progressMs: 100 };
afterAll(async () => {
  hub.shutdown.abort();
  await stop(server);
  hub.db.close();
  home.done();
});

const ss = process.platform === "linux" && spawnSync("ss", ["-V"]).status === 0;

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

/** A node over a bare TCP socket, so it can send one frame a few bytes at a time as a slow link would. */
class RawNode {
  private socket!: Socket<undefined>;
  private buf = Buffer.alloc(0);
  private upgraded = false;
  readonly frames: Record<string, unknown>[] = [];
  closeCode: number | undefined;
  private readonly key = nodeKey();

  constructor(readonly machineId: string, private readonly token: string) {}

  async open(port: number): Promise<void> {
    this.socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data: (_s, data) => this.data(data), close: () => void (this.closeCode ??= 1006) },
    });
    this.socket.write(
      `GET /node/link HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    await until(() => this.frames.some((f) => f.t === "welcome"));
  }

  private data(data: Buffer): void {
    this.buf = Buffer.concat([this.buf, data]);
    if (!this.upgraded) {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      this.upgraded = true;
      this.buf = this.buf.subarray(end + 4);
    }
    for (;;) {
      if (this.buf.length < 2) return;
      const opcode = (this.buf[0] ?? 0) & 0x0f;
      let len = (this.buf[1] ?? 0) & 0x7f;
      let at = 2;
      if (len === 126) [len, at] = [this.buf.readUInt16BE(2), 4];
      else if (len === 127) [len, at] = [Number(this.buf.readBigUInt64BE(2)), 10];
      if (this.buf.length < at + len) return;
      const payload = this.buf.subarray(at, at + len);
      this.buf = this.buf.subarray(at + len);
      if (opcode === 1) this.got(JSON.parse(payload.toString()));
      if (opcode === 8) this.closeCode = payload.readUInt16BE(0);
      if (opcode === 9) this.socket.write(frameBytes(0xa, payload));
    }
  }

  private got(frame: Record<string, unknown>): void {
    this.frames.push(frame);
    if (frame.t !== "challenge") return;
    this.send({
      t: "hello",
      machineId: this.machineId,
      name: this.machineId,
      tags: [],
      nodeVersion: "0.0.0-test",
      protocol: PROTOCOL_VERSION,
      pubKey: this.key.pubKey,
      sig: this.key.sign(frame.nonce as string),
      enrollToken: this.token,
      capabilities: [],
    });
  }

  send(frame: unknown): void {
    this.socket.write(frameBytes(0x1, Buffer.from(JSON.stringify(frame))));
  }

  /** `frame` sent as one websocket message, `piece` bytes every `everyMs`; stops early once `stopAt` bytes are out. */
  async trickle(frame: unknown, piece: number, everyMs: number, stopAt = Infinity): Promise<void> {
    const bytes = frameBytes(0x1, Buffer.from(JSON.stringify(frame)));
    for (let at = 0; at < Math.min(bytes.length, stopAt); at += piece) {
      expect(this.socket.write(bytes.subarray(at, Math.min(at + piece, bytes.length)))).toBeGreaterThan(0);
      await Bun.sleep(everyMs);
    }
  }

  end(): void {
    this.socket.end();
  }
}

/** One masked client frame. */
function frameBytes(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : Buffer.alloc(len < 65536 ? 4 : 10);
  if (len >= 126) {
    head[0] = 0x80 | opcode;
    if (len < 65536) {
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
  }
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] ?? 0)));
  return Buffer.concat([head, mask, masked]);
}

const status = (machineId: string) => store(hub).machineGet(machineId)?.status;
const big = () => ({ t: "hb", at: new Date().toISOString(), pad: "x".repeat(48 * 1024) });

test("ss's lines read as each peer's bytes received", () => {
  const out = parseSs(
    [
      "0      0      127.0.0.1:4790 127.0.0.1:56354 cubic wscale:10,10 bytes_sent:99538 bytes_received:1817667 segs_out:2368",
      "0      0      [::1]:4790  [::1]:40000 cubic bytes_acked:1",
      "0      0      [::ffff:10.0.0.7]:4790  [::ffff:10.0.0.8]:41000 cubic bytes_received:12",
      "",
    ].join("\n"),
  );
  expect([...out]).toEqual([
    ["127.0.0.1 56354", 1817667],
    ["::1 40000", 0],
    ["10.0.0.8 41000", 12],
  ]);
  const counts = new Map([...out].map(([k, v]) => [`4790 ${k}`, v]));
  const peer = (address: string, port: number): Peer => ({ address, port, local: 4790 });
  expect(ReadCounts.read(counts, peer("::ffff:10.0.0.8", 41000))).toBe(12);
  expect(ReadCounts.read(counts, peer("::1", 40000))).toBe(0);
  expect(ReadCounts.read(counts, peer("127.0.0.1", 1))).toBeUndefined();
});

test("bytes still arriving keep a link alive; once they stop it goes offline", async () => {
  // A count that grows while `arriving`, as a large frame's bytes would, though no frame comes whole.
  let read = 0;
  let arriving = true;
  links.readCounts = {
    sample: async (peers: Peer[]) => new Map(peers.map((p) => [`${p.local} ${p.address} ${p.port}`, arriving ? (read += 100) : read])),
  } as unknown as ReadCounts;
  try {
    const { token } = hub.auth.nodes.createEnrollToken("slow-fake", "test");
    const node = new FakeNode(`ws://127.0.0.1:${server.port}/node/link`, { machineId: "slow-fake", enrollToken: token });
    await node.tag("welcome");
    await Bun.sleep(2500);
    expect(status("slow-fake")).not.toBe("offline");
    arriving = false;
    expect(await node.closed).toEqual({ code: 4008, reason: "no frame for 1 s" });
    expect(status("slow-fake")).toBe("offline");
  } finally {
    links.readCounts = realCounts;
  }
});

test.if(ss)("a large frame over a slow link keeps its machine online, by the kernel's byte count", async () => {
  const { token } = hub.auth.nodes.createEnrollToken("slow-raw", "test");
  const node = new RawNode("slow-raw", token);
  await node.open(server.port ?? 0);
  // 48 KiB over 4 s: past the 1 s silence four times, with no whole frame in between.
  await node.trickle(big(), 512, 40);
  await Bun.sleep(50);
  expect(node.closeCode).toBeUndefined();
  expect(status("slow-raw")).not.toBe("offline");
  // Half a frame, then nothing: the link is dead, however much of a frame it had sent.
  await node.trickle(big(), 1024, 40, 8 * 1024);
  await until(() => node.closeCode !== undefined, 3000);
  expect(node.closeCode).toBe(4008);
  expect(status("slow-raw")).toBe("offline");
  node.end();
}, 10_000);
