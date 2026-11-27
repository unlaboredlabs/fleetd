// Share links' pure parts: the HTTP/1.1 proxy and WebSocket bridge over a byte stream, the cookie, the rules.
import { afterAll, expect, test } from "bun:test";
import net from "node:net";
import type { Duplex } from "node:stream";
import { COOKIE, cookieEnd, header, read, refreshDue, sign, strip, verify } from "../src/hub/share_links/cookie.ts";
import { bridge, Upstream, upgradeToDev } from "../src/hub/share_links/proxy.ts";
import {
  checkPreviewUrl,
  COOKIE_MS,
  enterUrl,
  lifeMinutes,
  MAX_MINUTES,
  NAME,
  newPreviewName,
  previewHostName,
  previewUrl,
  safePath,
} from "../src/hub/share_links/rules.ts";

// A dev server: echoes what it was sent, redirects, streams, and an HMR socket that names its subprotocol.
const seen: { host?: string; origin?: string | null; cookie?: string | null }[] = [];
const dev = Bun.serve<{ protocol: string }>({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req, server): Promise<Response | undefined> {
    const url = new URL(req.url);
    seen.push({ host: req.headers.get("host") ?? undefined, origin: req.headers.get("origin"), cookie: req.headers.get("cookie") });
    if (url.pathname === "/hmr") {
      const protocol = req.headers.get("sec-websocket-protocol") ?? "";
      if (protocol !== "vite-hmr") return new Response("no", { status: 400 });
      return server.upgrade(req, { data: { protocol }, headers: { "sec-websocket-protocol": protocol } }) ? undefined : new Response("x", { status: 500 });
    }
    if (url.pathname === "/go") return Response.redirect(`http://localhost:${server.port}/there`, 302);
    if (url.pathname === "/post") return new Response(`got ${(await req.arrayBuffer()).byteLength}`);
    if (url.pathname === "/big") return new Response("x".repeat(300_000));
    return new Response(`hello ${url.pathname}${url.search}`, { headers: { "set-cookie": "dev=1; Path=/" } });
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "connected" }));
    },
    message(ws, m) {
      if (m === "big") return void ws.send("y".repeat(200_000));
      ws.send(typeof m === "string" ? `echo ${m}` : new Uint8Array([...m].reverse()));
    },
  },
});
afterAll(() => dev.stop(true));
const DEV_PORT = dev.port!;

let opened = 0;
const open = async (): Promise<Duplex> => {
  opened++;
  const s = net.connect(DEV_PORT, "127.0.0.1");
  await new Promise((r) => s.once("connect", r));
  return s;
};
const ORIGIN = "https://abcdefabcdef.preview.example.com";
const limits = { maxRequestBytes: 1000, idleMs: 5000 };

test("HTTP: the dev server sees a local visit, the visitor the preview's own", async () => {
  let bytes = 0;
  const up = new Upstream(open, { ...limits, onBytes: (n) => (bytes += n) }, { port: DEV_PORT, origin: ORIGIN });
  try {
    opened = 0;
    const a = await up.fetch(
      new Request(`${ORIGIN}/page?x=1`, { headers: { origin: ORIGIN, cookie: `${COOKIE}=secret; theirs=2`, host: "abcdefabcdef.preview.example.com" } }),
    );
    expect(await a.text()).toBe("hello /page?x=1");
    expect(a.headers.get("set-cookie")).toBe("dev=1; Path=/");
    expect(seen.at(-1)).toEqual({ host: `localhost:${DEV_PORT}`, origin: `http://localhost:${DEV_PORT}`, cookie: "theirs=2" });
    const go = await up.fetch(new Request(`${ORIGIN}/go`));
    expect(go.status).toBe(302);
    expect(go.headers.get("location")).toBe(`${ORIGIN}/there`);
    const big = await up.fetch(new Request(`${ORIGIN}/big`));
    expect(big.headers.get("content-length")).toBe("300000");
    expect((await big.text()).length).toBe(300_000);
    // Kept-open streams: three requests, one at a time, on one.
    expect(opened).toBe(1);
    expect(await (await up.fetch(new Request(`${ORIGIN}/post`, { method: "POST", body: "a".repeat(500) }))).text()).toBe("got 500");
    expect((await up.fetch(new Request(`${ORIGIN}/post`, { method: "POST", body: "a".repeat(5000) }))).status).toBe(413);
    expect(bytes).toBeGreaterThan(300_000);
  } finally {
    up.close();
  }
});

test("HTTP: a dev server that isn't there is a 503 page", async () => {
  const gone = async (): Promise<Duplex> => {
    throw new Error("refused");
  };
  const up = new Upstream(gone, limits, { port: 1, origin: ORIGIN });
  const r = await up.fetch(new Request(`${ORIGIN}/`));
  expect(r.status).toBe(503);
  expect(await r.text()).toContain("Nothing answered on port 1");
  up.close();
});

test("WebSocket: a dev server whose handshake doesn't match is a 503 page, which the cloud's front passes on", async () => {
  // It answers 101 with an accept of some other key.
  const wrong = net.createServer((s) => s.once("data", () => s.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: bm90IGl0\r\n\r\n")));
  await new Promise<void>((r) => wrong.listen(0, "127.0.0.1", r));
  const port = (wrong.address() as net.AddressInfo).port;
  const dialWrong = async (): Promise<Duplex> => {
    const s = net.connect(port, "127.0.0.1");
    await new Promise((r) => s.once("connect", r));
    return s;
  };
  const out = await upgradeToDev(new Request(`${ORIGIN}/hmr`, { headers: { upgrade: "websocket" } }), dialWrong, limits, { port, origin: ORIGIN });
  expect("refused" in out && out.refused.status).toBe(503);
  expect("refused" in out && (await out.refused.text())).toContain("answered wrong");
  wrong.close();
});

test("WebSocket: the subprotocol comes back, frames go both ways, a close crosses", async () => {
  const refused = await upgradeToDev(new Request(`${ORIGIN}/hmr`, { headers: { upgrade: "websocket" } }), open, limits, { port: DEV_PORT, origin: ORIGIN });
  expect("refused" in refused && refused.refused.status).toBe(400);
  const up = await upgradeToDev(
    new Request(`${ORIGIN}/hmr`, { headers: { upgrade: "websocket", "sec-websocket-protocol": "vite-hmr", "sec-websocket-extensions": "permessage-deflate", origin: ORIGIN } }),
    open,
    limits,
    { port: DEV_PORT, origin: ORIGIN },
  );
  if (!("socket" in up)) throw new Error("not upgraded");
  expect(up.protocol).toBe("vite-hmr");
  const got: (string | Uint8Array)[] = [];
  let closedWith: number | undefined;
  const b = bridge({ send: (d) => got.push(d), close: (code) => (closedWith = code) }, up.socket, up.head);
  b.message("hi");
  b.message(new Uint8Array([1, 2, 3]));
  b.message("big");
  for (let i = 0; i < 50 && got.length < 4; i++) await Bun.sleep(10);
  expect(got[0]).toBe(JSON.stringify({ type: "connected" }));
  expect(got[1]).toBe("echo hi");
  expect([...(got[2] as Uint8Array)]).toEqual([3, 2, 1]);
  expect((got[3] as string).length).toBe(200_000);
  b.close(1000, "bye");
  await Bun.sleep(50);
  expect(closedWith).toBeUndefined();
});

test("the cookie: one link's, signed, ending, and never sent on", () => {
  const now = 1_000_000;
  const v = sign("s1", "abcdefabcdef", "p_abc", now + COOKIE_MS);
  expect(verify("s1", "abcdefabcdef", v, now)).toEqual({ personId: "p_abc", expMs: now + COOKIE_MS });
  expect(verify("s2", "abcdefabcdef", v, now)).toBeUndefined();
  expect(verify("s1", "bbbbbbbbbbbb", v, now)).toBeUndefined();
  expect(verify("s1", "abcdefabcdef", v, now + COOKIE_MS)).toBeUndefined();
  expect(verify("s1", "abcdefabcdef", v.replace(`.${now + COOKIE_MS}.`, `.${now + 2 * COOKIE_MS}.`), now)).toBeUndefined();
  expect(read(`a=1; ${COOKIE}=${v}; b=2`)).toBe(v);
  expect(strip(`a=1; ${COOKIE}=${v}; b=2`)).toBe("a=1; b=2");
  expect(strip(`${COOKIE}=${v}`)).toBeUndefined();
  expect(header(v, now + 60_000, now)).toBe(`${COOKIE}=${v}; Max-Age=60; Path=/; Secure; HttpOnly; SameSite=Lax`);
  expect(header(v, now + 60_000, now, false)).toBe(`fleetd_preview=${v}; Max-Age=60; Path=/; HttpOnly; SameSite=Lax`);
  expect(read(`fleetd_preview=${v}`)).toBeUndefined();
  expect(read(`fleetd_preview=${v}`, false)).toBe(v);
  expect(strip(`fleetd_preview=${v}; a=1`)).toBe("a=1");
  expect(cookieEnd(now, now + 10)).toBe(now + 10);
  expect(refreshDue(now + COOKIE_MS / 4, now, now + COOKIE_MS * 2)).toBe(true);
  expect(refreshDue(now + COOKIE_MS / 4, now, now + COOKIE_MS / 4)).toBe(false);
});

test("the rules: names, hosts, addresses, lives", () => {
  for (let i = 0; i < 100; i++) expect(newPreviewName()).toMatch(NAME);
  expect(previewHostName("abcdefabcdef.preview.example.com:443", "preview.example.com")).toBe("abcdefabcdef");
  expect(previewHostName("ABCDEFABCDEF.Preview.Example.com", "preview.example.com")).toBe("abcdefabcdef");
  expect(previewHostName("x.abcdefabcdef.preview.example.com", "preview.example.com")).toBeUndefined();
  expect(previewHostName("preview.example.com", "preview.example.com")).toBeUndefined();
  expect(previewHostName("abcdefabcdef.evilpreview.example.com", "preview.example.com")).toBeUndefined();
  expect(checkPreviewUrl("https://preview.example.com/")).toEqual({ url: "https://preview.example.com" });
  expect(checkPreviewUrl("http://localhost:4790")).toEqual({ url: "http://localhost:4790" });
  expect(checkPreviewUrl("http://preview.example.com")).toEqual({ why: "it must start with https://" });
  expect("why" in checkPreviewUrl("https://preview.example.com/x")).toBe(true);
  expect("why" in checkPreviewUrl("https://example.com", "https://ws.example.com")).toBe(true);
  expect("why" in checkPreviewUrl("https://ws.example.com", "https://ws.example.com")).toBe(true);
  expect(checkPreviewUrl("https://preview.example.com", "https://ws.example.com")).toEqual({ url: "https://preview.example.com" });
  expect(previewUrl("http://localhost:4790", "abcdefabcdef")).toBe("http://abcdefabcdef.localhost:4790");
  expect(enterUrl("https://p.example.com", "abcdefabcdef", "c0de", "/a?b=1")).toBe("https://abcdefabcdef.p.example.com/.fleetd/preview?code=c0de&to=%2Fa%3Fb%3D1");
  expect(safePath("//evil.com")).toBe("/");
  expect(safePath("https://evil.com")).toBe("/");
  expect(safePath("/\\evil.com")).toBe("/");
  expect(safePath("/ok?x")).toBe("/ok?x");
  expect(lifeMinutes(undefined)).toBe(120);
  expect(lifeMinutes(MAX_MINUTES + 1)).toBeUndefined();
  expect(lifeMinutes(0)).toBeUndefined();
});
