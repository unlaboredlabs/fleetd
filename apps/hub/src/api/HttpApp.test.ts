import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/http";
import { describe, expect, it } from "vitest";
import * as AppSocket from "./AppSocket.ts";
import * as FleetApi from "./FleetApi.ts";
import * as HttpApp from "./HttpApp.ts";
import { makeTestHub } from "./testHub.ts";

describe("hub HTTP server", () => {
  it("shuts down promptly while a WebSocket session and an events_wait long-poll are open", async () => {
    const hub = makeTestHub();
    const scope = Effect.runSync(Scope.make());
    const services = AppSocket.layer.pipe(Layer.provideMerge(FleetApi.layer), Layer.provideMerge(hub.layer));
    const context = await Effect.runPromise(
      Layer.buildWithScope(HttpApp.layer({ host: "127.0.0.1", port: 0 }).pipe(Layer.provideMerge(services)), scope),
    );
    hub.bind(context);
    const address = Context.get(context, HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") throw new Error("expected a TCP address");
    const url = `http://127.0.0.1:${address.port}`;
    const { key } = await hub.addKey("reader", [{ role: "read", machines: "*" }]);

    // A streaming /app session never ends on its own, like a node link.
    const socket = new WebSocket(`${url.replace("http", "ws")}/app`);
    const ready = new Promise((r) => socket.addEventListener("message", r, { once: true }));
    await new Promise((r) => socket.addEventListener("open", r));
    socket.send(JSON.stringify({ t: "auth", key }));
    await ready;
    socket.send(JSON.stringify({ t: "events", cursor: 0 }));
    const closed = new Promise<number>((r) => socket.addEventListener("close", (e) => r(e.code)));

    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }) as Transport,
    );
    const poll = client.callTool({ name: "events_wait", arguments: { timeoutSec: 50 } }).catch(() => "ended");
    await hub.waitCalls(2);

    const startedMs = Date.now();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(Date.now() - startedMs).toBeLessThan(3000);
    expect(await closed).toBe(1001);
    await poll;
    await client.close().catch(() => undefined);
  });
});

describe("phone web app at /", () => {
  it("serves the built files with a same-origin CSP that allows WebAssembly and the page's own style only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-pwa-"));
    const css = "body{margin:0}";
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><style>${css}</style><script type="module" src="/app.js"></script>`);
    fs.writeFileSync(path.join(dir, "app.js"), "console.log(1)");
    const hub = makeTestHub();
    const scope = Effect.runSync(Scope.make());
    const services = AppSocket.layer.pipe(Layer.provideMerge(FleetApi.layer), Layer.provideMerge(hub.layer));
    const context = await Effect.runPromise(Layer.buildWithScope(HttpApp.layer({ host: "127.0.0.1", port: 0 }, dir).pipe(Layer.provideMerge(services)), scope));
    try {
      const address = Context.get(context, HttpServer.HttpServer).address;
      if (address._tag === "UnixPathAddress") throw new Error("expected a TCP address");
      const url = `http://127.0.0.1:${address.port}`;
      const page = await fetch(`${url}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const hash = crypto.createHash("sha256").update(css).digest("base64");
      expect(page.headers.get("content-security-policy")).toBe(
        `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'sha256-${hash}'; img-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      );
      expect(await page.text()).toContain("/app.js");
      const script = await fetch(`${url}/app.js`);
      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(await script.text()).toBe("console.log(1)");
      expect((await fetch(`${url}/../hub.sqlite`)).status).toBe(404);
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});
