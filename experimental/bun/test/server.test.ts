import { afterAll, expect, test } from "bun:test";
import { onError, serve, stop } from "../src/hub/http/index.ts";
import { build, parseHubArgs, parseListen } from "../src/hub/serve/index.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";
import { internalError } from "../src/shared/errors.ts";
import { hubHome, insertKey } from "./helpers.ts";

const home = hubHome();
const { hub, tools } = build(home.dir, { host: "127.0.0.1", port: 0 });
const server = serve(hub, tools, 0);
const base = `http://127.0.0.1:${server.port}`;
afterAll(async () => {
  await stop(server);
  hub.db.close();
  home.done();
});

test("/healthz says the version and protocol", async () => {
  const res = await fetch(`${base}/healthz`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, version: "0.0.0", protocol: PROTOCOL_VERSION });
});

test("/mcp checks the key on every request", async () => {
  const none = await fetch(`${base}/mcp`, { method: "POST" });
  expect(none.status).toBe(401);
  expect(none.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
  expect(await none.json()).toEqual({
    code: "forbidden",
    message: "The MCP endpoint needs an agent key.",
    fix: "Send Authorization: Bearer fld_… (create one with fleetd hub key create).",
  });
  const unknown = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer fld_${"a".repeat(52)}` } });
  expect(unknown.status).toBe(401);
  expect(((await unknown.json()) as { message: string }).message).toBe("unknown agent key");

  const key = insertKey(hub.db, [{ role: "read", machines: "*" }]);
  const known = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
  // Past the key check: a POST without a JSON body is the endpoint's own 415 (test/mcp.test.ts).
  expect(known.status).toBe(415);
  hub.db.conn.run("UPDATE agent_keys SET revoked_ms = 1");
  const revoked = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
  expect(revoked.status).toBe(401);
  expect(((await revoked.json()) as { message: string }).message).toBe(`agent key ${key.slice(0, 10)} was revoked`);
});

test("websocket routes want an upgrade; unknown paths and methods are refused", async () => {
  for (const path of ["/app", "/node/link", "/relay/t1"]) {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(426);
    expect(await res.text()).toBe("Expected a WebSocket upgrade");
  }
  expect((await fetch(`${base}/nope`)).status).toBe(404);
  expect((await fetch(`${base}/pair`)).status).toBe(405);
  // An empty body is no pairing request (test/pair.test.ts).
  expect((await fetch(`${base}/pair`, { method: "POST" })).status).toBe(400);
  // An unknown automation and a wrong secret look the same (test/automations.test.ts).
  expect((await fetch(`${base}/hooks/a1/s3cret`, { method: "POST" })).status).toBe(404);
});

test("a malformed escape is a 400 and a crash is JSON, never Bun's error page", async () => {
  for (const [method, path] of [["POST", "/hooks/%E0%A4%A/x"], ["GET", "/relay/%ZZ"]] as const) {
    const res = await fetch(`${base}${path}`, { method });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("<html");
  }
  const quiet = console.error;
  console.error = () => {};
  const crashed = onError(new Error("boom"));
  console.error = quiet;
  expect(crashed.status).toBe(500);
  expect(await crashed.json()).toEqual(internalError().toJSON());
});

test("hub start's flags, with the Rust hub's messages", () => {
  expect(parseListen("4791")).toEqual({ host: "127.0.0.1", port: 4791 });
  expect(parseListen("[::1]:4790")).toEqual({ host: "::1", port: 4790 });
  expect(parseListen("devbox:0")).toBeUndefined();
  expect(parseHubArgs(["--home=/x", "--listen", "0.0.0.0:80"])).toEqual({ home: "/x", listen: { host: "0.0.0.0", port: 80 } });
  expect(parseHubArgs(["--port", "1"])).toBe("Unknown option '--port'");
  expect(parseHubArgs(["x"])).toBe("Unexpected argument 'x'. This command does not take positional arguments");
  expect(parseHubArgs(["--listen"])).toBe("Option '--listen <value>' argument missing");
  expect(parseHubArgs(["--listen", "nope"])).toBe("--listen must be host:port, got 'nope'");
});

test("hub.url() is the URL setup saved, unless it is a wildcard address", async () => {
  const { configuredUrl } = await import("../src/hub/serve/index.ts");
  const { writeFileSync } = await import("node:fs");
  const dir = hubHome();
  const save = (url: string, machines: Record<string, unknown> = {}) =>
    writeFileSync(`${dir.dir}/setup.json`, JSON.stringify({ listen: "0.0.0.0:4790", url, machines }));
  expect(configuredUrl(dir.dir)).toBeUndefined();
  save("http://devbox:4790");
  expect(configuredUrl(dir.dir)).toBe("http://devbox:4790");
  const built = build(dir.dir, { host: "127.0.0.1", port: 0 });
  expect(built.hub.url()).toBe("http://devbox:4790");
  built.hub.db.close();
  save("http://0.0.0.0:4790");
  expect(configuredUrl(dir.dir)).toBeUndefined();
  save("http://devbox:4790", { "Not An Id": {} });
  expect(configuredUrl(dir.dir)).toBeUndefined();
  dir.done();
});
