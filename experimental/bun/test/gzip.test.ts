// gzip on the JSON /mcp and /link/v1 answer (Rust's hub/http/gzip.rs): only when the request offers it, only for a
// JSON answer worth it, and whole either way.
import { afterAll, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { acceptsGzip, MAX_BYTES, negotiate } from "../src/hub/http/gzip.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { build } from "../src/hub/serve/index.ts";
import { hubHome, insertKey } from "./helpers.ts";

const home = hubHome();
const { hub, tools } = build(home.dir, { host: "127.0.0.1", port: 0 });
const server = serve(hub, tools, 0);
afterAll(async () => {
  await stop(server);
  hub.db.close();
  home.done();
});

const offered = (value?: string) => new Headers(value === undefined ? {} : { "accept-encoding": value });

test("reads what Accept-Encoding offers", () => {
  expect(acceptsGzip(offered("gzip"))).toBe(true);
  expect(acceptsGzip(offered("br, GZIP;q=0.5"))).toBe(true);
  expect(acceptsGzip(offered("x-gzip"))).toBe(true);
  expect(acceptsGzip(offered("*"))).toBe(true);
  expect(acceptsGzip(offered("gzip;q=0"))).toBe(false);
  expect(acceptsGzip(offered("gzip; q=0.000"))).toBe(false);
  expect(acceptsGzip(offered("br, deflate"))).toBe(false);
  expect(acceptsGzip(offered())).toBe(false);
});

const answered = async (request: Headers, value: unknown) => {
  const res = await negotiate(request, Response.json(value, { status: 201 }));
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
};

test("gzips a large JSON answer only when asked", async () => {
  const big = { events: Array(200).fill("machine.online devbox") };
  const plain = Buffer.from(JSON.stringify(big));

  const zipped = await answered(offered("gzip, br"), big);
  expect([zipped.status, zipped.headers.get("content-encoding"), zipped.headers.get("vary")]).toEqual([201, "gzip", "accept-encoding"]);
  expect(zipped.body.length * 10).toBeLessThan(plain.length);
  expect(gunzipSync(zipped.body)).toEqual(plain);

  // An older client offers nothing: the very same bytes as before.
  const old = await answered(offered(), big);
  expect(old.headers.get("content-encoding")).toBeNull();
  expect(old.headers.get("vary")).toBe("accept-encoding");
  expect(old.body).toEqual(plain);

  // A small answer isn't worth it.
  const small = await answered(offered("gzip"), { ok: true });
  expect(small.headers.get("content-encoding")).toBeNull();
  expect(small.body.toString()).toBe('{"ok":true}');
});

test("an answer past the cap goes whole and uncompressed", async () => {
  const piece = new Uint8Array(1 << 20).fill(0x20);
  const pieces = (MAX_BYTES >> 20) + 2;
  let sent = 0;
  const streamed = new Response(
    new ReadableStream({
      pull(c) {
        if (sent++ < pieces) c.enqueue(piece);
        else c.close();
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  const out = await negotiate(offered("gzip"), streamed);
  expect(out.headers.get("content-encoding")).toBeNull();
  expect(out.headers.get("vary")).toBe("accept-encoding");
  expect((await out.arrayBuffer()).byteLength).toBe(piece.length * pieces);
});

test("leaves anything but JSON alone", async () => {
  const stream = new Response("data: x\n\n".repeat(500), { headers: { "content-type": "text/event-stream" } });
  const out = await negotiate(offered("gzip"), stream);
  expect(out).toBe(stream);
  expect(out.headers.get("content-encoding")).toBeNull();
});

test("/mcp answers gzipped to a client that offers it, and as before to one that doesn't", async () => {
  const key = insertKey(hub.db, [{ role: "read", machines: "*" }]);
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const post = (body: unknown, headers: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
      decompress: false,
    });
  const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  const session = (await post(init, { "accept-encoding": "identity" })).headers.get("mcp-session-id") ?? "";
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const plain = await post(list, { "mcp-session-id": session, "accept-encoding": "identity" });
  expect(plain.headers.get("content-encoding")).toBeNull();
  const text = await plain.text();
  expect(JSON.parse(text).result.tools.length).toBeGreaterThan(10);
  const zipped = await post(list, { "mcp-session-id": session, "accept-encoding": "gzip" });
  expect([zipped.status, zipped.headers.get("content-encoding"), zipped.headers.get("vary")]).toEqual([200, "gzip", "accept-encoding"]);
  expect(gunzipSync(Buffer.from(await zipped.arrayBuffer())).toString()).toBe(text);
});
