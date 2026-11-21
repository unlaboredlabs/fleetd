// `fleetd mcp-probe` from the CLI: a resolved server on stdin, the node's McpTestResult as one line on stdout. Against
// stand-in servers (a stdio shell script, a local HTTP one), each with a made-up key it may print or echo back: the
// key never reaches stdout or stderr, whether the server works, fails or echoes it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Resolved } from "../../src/node/actions/mcp_probe.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-mcp-probe-"));
const main = join(import.meta.dir, "../../src/main.ts");
const KEY = "made-up-key-4f9a2c";
const WRONG = "made-up-wrong-key-77b1";

/** Runs the CLI's `mcp-probe` with `input` on stdin; a fresh home, so nothing reaches a real one. */
async function run(input: string, args: string[] = [], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, main, "mcp-probe", ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, FLEETD_HOME: join(dir, ".fleetd"), FLEETD_HUB_URL: "http://127.0.0.1:1", ...env },
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

/** A probe that ran: exit 0, one JSON line on stdout and nothing else, no key in either stream. */
async function probed(server: Resolved, env: Record<string, string> = {}) {
  const r = await run(JSON.stringify(server), [], env);
  expect([r.code, r.stderr]).toEqual([0, ""]);
  expect(r.stdout).toEndWith("\n");
  expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
  for (const value of [KEY, WRONG]) expect([r.stdout.includes(value), r.stderr.includes(value)]).toEqual([false, false]);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

const keyed = (name: string, transport: Resolved["transport"], field: string, value: string): Resolved => ({
  name,
  transport,
  values: [[field, value]],
  secrets: [[`${name}.${field}`, value]],
});

/** A stdio server as a shell script: with the right TOKEN it answers initialize and tools/list, naming itself after
 * $NAME_FROM_ENV and echoing the token in a tool's description; with a wrong one it prints the token on stderr and
 * exits 2. */
function script(): Resolved["transport"] {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18", serverInfo: { name: "SERVER", version: "1.0.0" } } });
  const list = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "search", description: "Searches with TOKENVALUE.", annotations: { readOnlyHint: true } }, { name: "fetch" }] } });
  const path = join(dir, "stand-in-mcp");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$TOKEN" != "${KEY}" ]; then echo "bad token: $TOKEN" >&2; exit 2; fi\n` +
      `read l\nprintf '%s\\n' '${init}' | sed "s/SERVER/$NAME_FROM_ENV/"\nread l\nread l\nprintf '%s\\n' '${list}' | sed "s/TOKENVALUE/$TOKEN/"\nread l\n`,
  );
  return { type: "stdio", command: "sh", args: [path] };
}

let http: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  const streams: ReadableStreamDefaultController<string>[] = [];
  const answer = (body: Record<string, any>) =>
    body.method === "initialize"
      ? { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "stand-in-http", version: "2.0.0" } } }
      : { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "lookup" }] } };
  http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      // A wrong key is echoed back in the body, as a careless server might.
      if (auth !== `Bearer ${KEY}`) return new Response(`refused ${auth}`, { status: 500 });
      if (url.pathname === "/mcp") {
        const body = (await req.json()) as Record<string, any>;
        if (body.id === undefined) return new Response(null, { status: 202 });
        return Response.json(answer(body));
      }
      if (url.pathname === "/sse")
        return new Response(
          new ReadableStream<string>({
            start(c) {
              streams.push(c);
              c.enqueue("event: endpoint\ndata: /messages\n\n");
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      const body = (await req.json()) as Record<string, any>;
      if (body.id !== undefined) streams.at(-1)!.enqueue(`event: message\ndata: ${JSON.stringify(answer(body))}\n\n`);
      return new Response("Accepted", { status: 202 });
    },
  });
});
afterAll(() => {
  http.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("a stdio server lists its tools, run with the command's environment, and the key it echoes is masked", async () => {
  expect(await probed(keyed("crm", script(), "TOKEN", KEY), { NAME_FROM_ENV: "stand-in-stdio" })).toEqual({
    server: "stand-in-stdio 1.0.0",
    tools: [{ name: "search", description: "Searches with ***crm.TOKEN***.", readOnly: true }, { name: "fetch" }],
  });
});

test("a stdio server that fails says why with its stderr tail, the key it printed masked", async () => {
  expect(await probed(keyed("crm", script(), "TOKEN", WRONG))).toEqual({ tools: [], error: "the server exited before it answered (exit 2): bad token: ***crm.TOKEN***" });
  const missing = await probed({ name: "x", transport: { type: "stdio", command: "fleetd-no-such-server" }, values: [], secrets: [] });
  expect(missing.error).toContain("fleetd-no-such-server was not found");
});

test("an HTTP and an SSE server list their tools with the key in a header; one that echoes a wrong key gets it masked", async () => {
  const base = `http://127.0.0.1:${http.port}`;
  const want = { server: "stand-in-http 2.0.0", tools: [{ name: "lookup" }] };
  expect(await probed(keyed("api", { type: "http", url: `${base}/mcp` }, "Authorization", `Bearer ${KEY}`))).toEqual(want);
  expect(await probed(keyed("api", { type: "sse", url: `${base}/sse` }, "Authorization", `Bearer ${KEY}`))).toEqual(want);
  expect(await probed(keyed("api", { type: "http", url: `${base}/mcp` }, "Authorization", WRONG))).toEqual({
    tools: [],
    error: "Error POSTing to endpoint (HTTP 500): refused ***api.Authorization***",
  });
  expect(await probed(keyed("api", { type: "sse", url: `${base}/sse` }, "Authorization", WRONG))).toEqual({
    tools: [],
    error: "Error opening the event stream (HTTP 500): refused ***api.Authorization***",
  });
});

test("bad input exits 2 with nothing on stdout, naming the field and never its value", async () => {
  const server = keyed("crm", script(), "TOKEN", KEY);
  const cases: [input: string, args: string[], says: string][] = [
    ["not json", [], "stdin isn't JSON"],
    [JSON.stringify([server]), [], "stdin isn't a JSON object"],
    [JSON.stringify({ ...server, transport: { type: "ws", url: KEY } }), [], "transport.type isn't stdio, http or sse"],
    [JSON.stringify({ ...server, transport: { type: "http", url: KEY } }), [], "transport.url isn't a URL"],
    [JSON.stringify({ ...server, values: [["TOKEN", KEY, KEY]] }), [], "values isn't a list of [name, value] pairs"],
    [JSON.stringify({ ...server, secrets: { TOKEN: KEY } }), [], "secrets isn't a list of [name, value] pairs"],
    [JSON.stringify(server), [KEY], "takes no arguments"],
  ];
  for (const [input, args, says] of cases) {
    const r = await run(input, args);
    expect([r.code, r.stdout, r.stderr.startsWith(`fleetd mcp-probe: ${says}`), r.stderr.includes(KEY)]).toEqual([2, "", true, false]);
  }
});
