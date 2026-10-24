// The bench's usage accounting: `node --test tests/lab/bench/accounting.test.ts` (no API calls, no claude).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { accountRun, tokensOf, usdOf } from "./accounting.ts";
import { type ProxyRecord, readProxyLog, startProxy, usageFromResponse } from "./proxy.ts";

/** A Messages API stream whose cache write is split across both TTLs, its output count arriving in message_delta. */
const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, "fixtures/messages-both-ttl.sse"), "utf8");
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "bench-accounting-"));

test("a streamed response's usage: message_start's input side, message_delta's output, both cache TTLs", () => {
  const parsed = usageFromResponse(FIXTURE);
  assert.equal(parsed?.messageId, "msg_011CgKeBsHS8Hpevhw9de6BL");
  assert.deepEqual(tokensOf(parsed!.usage), { requests: 1, input: 2, cacheRead: 11141, cacheWrite5m: 2400, cacheWrite1h: 4701, output: 181 });
  // $4 input, $0.20 cache read, $5 5 min write, $8 1 h write, $20 output per million.
  assert.equal(usdOf(tokensOf(parsed!.usage)), 0.055464);
});

test("a usage object without the TTL split counts its cache write as 5 min", () => {
  assert.deepEqual(tokensOf({ input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 7, output_tokens: 9 }), {
    requests: 1,
    input: 3,
    cacheRead: 7,
    cacheWrite5m: 100,
    cacheWrite1h: 0,
    output: 9,
  });
});

test("the proxy logs a gzipped stream's message id and usage, and the request's tool schema size, passing the body through", async () => {
  const dir = scratch();
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
      res.end(zlib.gzipSync(FIXTURE));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const log = path.join(dir, "requests.jsonl");
  const proxy = await startProxy(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, log);
  try {
    const tools = [{ name: "Bash", description: "Runs a command", input_schema: { type: "object" } }];
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5-5", output_config: { effort: "high" }, tools, messages: [] }),
    });
    assert.equal(await res.text(), FIXTURE);
    const [record] = readProxyLog(log);
    assert.equal(record?.messageId, "msg_011CgKeBsHS8Hpevhw9de6BL");
    assert.equal(record?.tools, 1);
    assert.equal(record?.toolsBytes, Buffer.byteLength(JSON.stringify(tools)));
    assert.deepEqual(tokensOf(record!.usage!), { requests: 1, input: 2, cacheRead: 11141, cacheWrite5m: 2400, cacheWrite1h: 4701, output: 181 });
    assert.ok(Date.parse(record!.endAt!) >= Date.parse(record!.sentAt!));
  } finally {
    await proxy.close();
    upstream.close();
  }
});

const MIN = 60_000;
const T0 = Date.parse("2026-10-23T18:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const usage = (read: number, write1h: number, output: number) => ({
  input_tokens: 2,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write1h,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write1h },
  output_tokens: output,
});
const prompt = (text: string, ms: number) => ({ type: "user", timestamp: at(ms), message: { role: "user", content: text } });
/** One request as claude writes it: the request line, its shape, then two content-block lines of one message. */
const request = (id: string, ms: number, u: Record<string, unknown>, toolsJson: string) => [
  { type: "api-request-shape", shapeHash: `shape-${toolsJson.length}`, timestamp: at(ms), shape: { system: [], tools: JSON.parse(toolsJson) } },
  { type: "api-request", id: `req-${id}`, timestamp: at(ms), shapeHash: `shape-${toolsJson.length}` },
  { type: "assistant", requestRef: `req-${id}`, timestamp: at(ms + 1000), message: { id, model: "claude-opus-5-5", usage: { ...u, output_tokens: 1 } } },
  { type: "assistant", requestRef: `req-${id}`, timestamp: at(ms + 2000), message: { id, model: "claude-opus-5-5", usage: u } },
];
const writeSession = (dir: string, name: string, lines: ReadonlyArray<unknown>) => {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  return file;
};

/** A writer that idles 6 min and then rewrites its cache, gets a fix message, and a lead with one request. */
const fixtureRun = () => {
  const dir = scratch();
  const tools = JSON.stringify([{ name: "Bash" }]);
  const writer = writeSession(dir, "writer", [
    prompt("You are fleetd agent T1 (write) for workstream W1 in project p: Fix it", 0),
    ...request("msg_w1", 0, usage(6000, 7000, 300), tools),
    { type: "user", timestamp: at(3000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } },
    ...request("msg_w2", 3000, usage(13000, 500, 200), tools),
    // 6 min idle after msg_w2 ended (5 s): the next request writes its whole prompt again.
    ...request("msg_w3", 5000 + 6 * MIN, usage(0, 14000, 100), tools),
    prompt("Fix your PR https://github.com/o/r/pull/1: CI failed.", 7 * MIN),
    ...request("msg_w4", 7 * MIN, usage(14000, 400, 50), tools),
  ]);
  const lead = writeSession(dir, "lead", [prompt("You are the lead of project p in fleetd.", 0), ...request("msg_l1", 0, usage(5000, 9000, 70), JSON.stringify([{ name: "Bash" }, { name: "Read" }]))]);
  return [writer, lead];
};

test("from session files alone: one request per message, roles by first prompt, fix work, first-request size, idle rewrites", () => {
  const proxy: Array<ProxyRecord> = Array.from({ length: 6 }, () => ({ at: at(0), method: "POST", path: "/v1/messages", model: "claude-opus-5-5", effort: "high", status: 200 }));
  const e = accountRun({ files: fixtureRun(), proxy });
  assert.equal(e.source, "sessions");
  assert.deepEqual(e.total, { requests: 5, input: 10, cacheRead: 38000, cacheWrite5m: 0, cacheWrite1h: 30900, output: 720, usd: usdOf({ requests: 5, input: 10, cacheRead: 38000, cacheWrite5m: 0, cacheWrite1h: 30900, output: 720 }) });
  assert.deepEqual(Object.keys(e.byRole).sort(), ["fix", "lead", "writer"]);
  assert.equal(e.byRole.writer?.requests, 3);
  assert.equal(e.byRole.fix?.requests, 1);
  assert.equal(e.byRole.writer?.agents, 1);
  assert.deepEqual(e.byRole.writer?.startContext, [13002]);
  assert.deepEqual(e.byRole.lead?.startContext, [14002]);
  assert.equal(e.byRole.lead?.toolsBytes, Buffer.byteLength(JSON.stringify([{ name: "Bash" }, { name: "Read" }])));
  assert.deepEqual(e.idle, { gapsOverIdle: 1, rewrites: 1, rewriteTokens: 14000, rewriteExtraUsd: 0.1092 });
  assert.equal(e.crossCheck.proxyRequests, 6);
  assert.equal(e.crossCheck.sessionMessages, 5);
});

test("with usage in the proxy log, the proxy's count wins; sessions name the roles and the difference is reported", () => {
  const files = fixtureRun();
  const sessionIds = ["msg_w1", "msg_w2", "msg_w3", "msg_w4", "msg_l1"];
  const proxy: Array<ProxyRecord> = [
    ...sessionIds.map((messageId, i) => ({ at: at(i * MIN), sentAt: at(i * MIN), endAt: at(i * MIN + 2000), method: "POST", path: "/v1/messages", status: 200, messageId, usage: usage(1000, 0, 10) })),
    // A helper call no session file recorded.
    { at: at(0), method: "POST", path: "/v1/messages", status: 200, messageId: "msg_helper", usage: usage(0, 500, 5) },
  ];
  const e = accountRun({ files, proxy });
  assert.equal(e.source, "proxy");
  assert.equal(e.total.requests, 6);
  assert.equal(e.total.cacheRead, 5000);
  assert.equal(e.total.cacheWrite1h, 500);
  assert.equal(e.byRole.unattributed?.requests, 1);
  assert.equal(e.byRole.writer?.requests, 3);
  assert.equal(e.crossCheck.proxyOnly, 1);
  assert.equal(e.crossCheck.sessionOnly, 0);
  assert.equal(e.crossCheck.delta?.cacheWrite1h, 500 - 30900);
  // The proxy's timings: no gap over 5 min on any session.
  assert.equal(e.idle.gapsOverIdle, 0);
});
