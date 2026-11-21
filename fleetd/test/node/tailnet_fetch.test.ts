// HTTP over a connection the team's gateway gives (src/node/sandbox/tailnet_fetch.ts): a local stand-in server, dialled
// in place of the gateway, over plain HTTP and over TLS with a throwaway certificate; no tailnet, no network.
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { probe } from "../../src/node/actions/mcp_probe.ts";
import { dialFetch } from "../../src/node/sandbox/tailnet_fetch.ts";
import { tempHome } from "../helpers.ts";

const home = tempHome();
afterAll(() => home.done());

const to = (port: number, dialed: string[]) => async (host: string, p: number) => {
  dialed.push(`${host}:${p}`);
  return await new Promise<Duplex>((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("connect", () => resolve(s)).once("error", reject);
  });
};

test("a GET over the dial: its headers go, the status and body come back, whole, chunked or not", async () => {
  let seen = null as string | null;
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      seen = req.headers.get("x-api-key");
      const path = new URL(req.url).pathname;
      if (path === "/chunked") {
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("one "));
            c.enqueue(new TextEncoder().encode("two"));
            c.close();
          },
        });
        return new Response(body);
      }
      if (path === "/none") return new Response(null, { status: 204 });
      return new Response("refused", { status: 401, statusText: "Unauthorized" });
    },
  });
  const dialed: string[] = [];
  const f = dialFetch(to(srv.port!, dialed));
  try {
    const refused = await f("http://devbox.tail1234.ts.net:8317/v1/models?limit=1", { headers: { "x-api-key": "sk-devbox" } });
    expect([refused.status, refused.statusText, await refused.text()]).toEqual([401, "Unauthorized", "refused"]);
    expect(seen).toBe("sk-devbox");
    expect(await (await f("http://100.104.249.49/chunked")).text()).toBe("one two");
    expect((await f("http://100.104.249.49:80/none")).status).toBe(204);
    expect(dialed).toEqual(["devbox.tail1234.ts.net:8317", "100.104.249.49:80", "100.104.249.49:80"]);
    await expect(f("http://100.104.249.49/", { headers: { "x-bad": "a\r\nb" } })).rejects.toThrow("line break");
  } finally {
    srv.stop(true);
  }
});

test("a POST over the dial sends its body, and an MCP server on the tailnet lists its tools through it", async () => {
  const seen: string[] = [];
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      seen.push(`${req.method} ${Number(req.headers.get("content-length")) === Buffer.byteLength(text)} ${req.headers.get("accept")} ${req.headers.get("user-agent")?.split("/")[0]}`);
      if (new URL(req.url).pathname === "/echo") return new Response(`got ${text}`);
      if (req.headers.get("authorization") !== "Bearer made-up-key") return new Response("no", { status: 401 });
      const body = JSON.parse(text) as { id?: number; method: string };
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18", serverInfo: { name: "tailnet-mcp", version: "1.0.0" } } : { tools: [{ name: "search" }] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": "s1" } });
    },
  });
  const f = dialFetch(to(srv.port!, []));
  try {
    const echoed = await f("http://100.104.249.49/echo", { method: "POST", body: "héllo", headers: { "content-length": "1" } });
    expect(await echoed.text()).toBe("got héllo");
    expect(seen.shift()).toBe("POST true */* fleetd");
    await expect(f("http://100.104.249.49/", { method: "GET /x HTTP/1.1\r\n" })).rejects.toThrow("isn't an HTTP method");
    const server = { name: "crm", transport: { type: "http" as const, url: "http://devbox.tail1234.ts.net:8080/mcp" }, values: [["Authorization", "Bearer made-up-key"]] as [string, string][], secrets: [] };
    expect(await probe(server, { fetch: f })).toEqual({ server: "tailnet-mcp 1.0.0", tools: [{ name: "search" }] });
    // The probe's own accept and user agent, not the dial's defaults beside them.
    expect(seen).toEqual(Array(3).fill("POST true application/json, text/event-stream fleetd-mcp-test"));
  } finally {
    srv.stop(true);
  }
});

test("https goes over TLS on top of the dial, checking the endpoint's certificate", async () => {
  const key = join(home.dir, "key.pem");
  const cert = join(home.dir, "cert.pem");
  const made = Bun.spawnSync(
    ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=devbox.tail1234.ts.net", "-addext", "subjectAltName=DNS:devbox.tail1234.ts.net"],
    { stderr: "ignore", stdout: "ignore" },
  );
  if (made.exitCode !== 0) return console.log("no openssl here: TLS over the dial isn't tried");
  const srv = Bun.serve({ port: 0, tls: { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") }, fetch: () => new Response("secure") });
  const dialed: string[] = [];
  try {
    const trusted = dialFetch(to(srv.port!, dialed), { ca: readFileSync(cert, "utf8") });
    expect(await (await trusted("https://devbox.tail1234.ts.net/")).text()).toBe("secure");
    expect(dialed).toEqual(["devbox.tail1234.ts.net:443"]);
    // Another name than the certificate's, or a CA nobody trusts, is refused.
    await expect(trusted("https://other.tail1234.ts.net/")).rejects.toThrow();
    await expect(dialFetch(to(srv.port!, dialed))("https://devbox.tail1234.ts.net/")).rejects.toThrow();
  } finally {
    srv.stop(true);
  }
});

test("a dial or an answer that takes too long ends at the signal, as a timeout", async () => {
  const hang = dialFetch(() => new Promise<Duplex>(() => {}));
  const err = await hang("http://100.104.249.49:8317", { signal: AbortSignal.timeout(50) }).catch((e: Error) => e);
  expect((err as Error).name).toBe("TimeoutError");
  // A server that takes the request and never answers.
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    const slow = await dialFetch(to(silent.port, []))("http://100.104.249.49:8317", { signal: AbortSignal.timeout(50) }).catch((e: Error) => e);
    expect((slow as Error).name).toBe("TimeoutError");
  } finally {
    silent.stop(true);
  }
});
