import type { AddressInfo } from "node:net";
import { constants, createDeflateRaw, type DeflateRaw } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { deflated, inflater, sharedLookup, webSocketTransport, type ConnectionEvents } from "./transport";

/** The hub's side of `deflate`: one raw DEFLATE stream per connection, each message sync-flushed, its tail cut off. */
const deflater = (): ((text: string) => Promise<Buffer>) => {
  const stream: DeflateRaw = createDeflateRaw({ windowBits: 15 });
  return (text) =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const onData = (c: Buffer) => chunks.push(c);
      stream.on("data", onData);
      stream.write(text);
      stream.flush(constants.Z_SYNC_FLUSH, () => {
        stream.off("data", onData);
        const all = Buffer.concat(chunks);
        resolve(all.subarray(0, all.length - 4));
      });
    });
};

describe("inflater", () => {
  it("reads each message of one stream, the context kept between them", async () => {
    const deflate = deflater();
    const inflate = inflater();
    const frame = JSON.stringify({ t: "event", seq: 1, type: "task.started", data: { title: "tighten the store's startup" } });
    const first = await deflate(frame);
    const second = await deflate(frame);
    // The second refers back to the first: alone, it isn't readable.
    expect(second.length).toBeLessThan(first.length / 2);
    expect(await inflate(first)).toBe(frame);
    expect(await inflate(second)).toBe(frame);
  });

  it("compresses the app's frames so the hub's one inflater for the connection reads each in turn", async () => {
    const inflate = inflater();
    const piece = (n: number) => JSON.stringify({ t: "call", id: `c${String(n)}`, tool: "attachment_part", input: { dataB64: "QUJD".repeat(20_000 + n) } });
    const small = deflated(piece(1));
    expect(small.length).toBeLessThan(piece(1).length / 10);
    expect(await inflate(small)).toBe(piece(1));
    expect(await inflate(deflated(piece(2)))).toBe(piece(2));
    expect(await inflate(deflated(piece(3)))).toBe(piece(3));
  });

  it("refuses what isn't DEFLATE", async () => {
    await expect(inflater()(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]))).rejects.toThrow();
  });
});

describe("webSocketTransport", () => {
  let server: WebSocketServer | undefined;
  afterEach(() => server?.close());

  /** A local hub socket; `serve` runs on each connection. */
  const listen = async (serve: (socket: WebSocket) => void): Promise<string> => {
    const s = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    server = s;
    s.on("connection", serve);
    await new Promise((resolve) => s.once("listening", resolve));
    return `ws://127.0.0.1:${String((s.address() as AddressInfo).port)}/app`;
  };

  const record = () => {
    const texts: string[] = [];
    let heard = 0;
    let closed: ((code: number) => void) | undefined;
    const close = new Promise<number>((resolve) => (closed = resolve));
    const events: ConnectionEvents = {
      onOpen: () => undefined,
      onText: (t) => texts.push(t),
      onHeard: () => heard++,
      onClose: (code) => closed?.(code),
    };
    return { events, texts, heard: () => heard, close };
  };

  it("hands Text and inflated Binary frames over in the order they came, and hears every byte and ping", async () => {
    const url = await listen((socket) => {
      const deflate = deflater();
      void (async () => {
        socket.send(JSON.stringify({ t: "ready", protocol: 1, features: ["deflate"] }));
        socket.send(await deflate(JSON.stringify({ t: "snapshot", cursor: 1 })));
        socket.send(await deflate(JSON.stringify({ t: "event", seq: 2, type: "x" })));
        socket.send(JSON.stringify({ t: "event", seq: 3, type: "x" }));
        socket.send(await deflate(JSON.stringify({ t: "event", seq: 4, type: "x" })));
        socket.ping();
        socket.send("end");
      })();
    });
    const r = record();
    const connection = webSocketTransport(url, r.events);
    await expect.poll(() => r.texts.at(-1)).toBe("end");
    expect(r.texts.slice(0, -1).map((t) => JSON.parse(t) as unknown)).toEqual([
      { t: "ready", protocol: 1, features: ["deflate"] },
      { t: "snapshot", cursor: 1 },
      { t: "event", seq: 2, type: "x" },
      { t: "event", seq: 3, type: "x" },
      { t: "event", seq: 4, type: "x" },
    ]);
    // At least once per frame (bytes may come in fewer reads), and for the ping.
    expect(r.heard()).toBeGreaterThanOrEqual(1);
    connection.close();
  });

  it("dials a hub by name through the shared lookup", async () => {
    const url = await listen((socket) => socket.send("hello"));
    const r = record();
    const connection = webSocketTransport(url.replace("127.0.0.1", "localhost"), r.events);
    await expect.poll(() => r.texts).toEqual(["hello"]);
    connection.close();
  });

  it("drops the link when a Binary frame won't inflate", async () => {
    const url = await listen((socket) => {
      socket.send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));
      socket.send(JSON.stringify({ t: "event", seq: 2, type: "x" }));
    });
    const r = record();
    webSocketTransport(url, r.events);
    expect(await r.close).toBe(1006);
    // Nothing after the bad frame is read: the stream can't be trusted from there.
    expect(r.texts).toEqual([]);
  });
});

describe("sharedLookup", () => {
  it("asks the resolver once for dials that overlap, and again once that answer is in", async () => {
    const asked: Array<(error: Error | null, addresses: Array<{ address: string; family: number }>) => void> = [];
    const lookup = sharedLookup((_name, _options, done) => asked.push(done));
    const one = new Promise((resolve) => lookup("devbox.example.ts.net", { all: true }, (_e, addresses) => resolve(addresses)));
    const two = new Promise((resolve) => lookup("devbox.example.ts.net", {}, (_e, address, family) => resolve([address, family])));
    expect(asked).toHaveLength(1);
    asked[0]?.(null, [{ address: "100.64.0.7", family: 4 }]);
    await expect(one).resolves.toEqual([{ address: "100.64.0.7", family: 4 }]);
    await expect(two).resolves.toEqual(["100.64.0.7", 4]);
    const failed = new Promise((resolve) => lookup("devbox.example.ts.net", {}, (e) => resolve(e?.code)));
    expect(asked).toHaveLength(2);
    asked[1]?.(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }), []);
    await expect(failed).resolves.toBe("ENOTFOUND");
  });
});
