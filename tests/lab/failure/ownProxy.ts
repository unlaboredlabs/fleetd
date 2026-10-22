// own-proxy: a machine whose user runs claude through a local proxy set in their own ~/.claude/settings.json
// (`env.ANTHROPIC_BASE_URL`, as CLIProxyAPI setups do). Sessions use that setup as it is: the doctor describes the
// login and names the proxy and the file it is set in, a session's requests all reach the proxy, and the run
// completes. The proxy is a stub on 127.0.0.1 that records each request and answers with a canned reply; it forwards
// nothing, so no request reaches Anthropic.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { type Body, type Lab, nodeHome, seedRepo } from "../harness.ts";
import { claudeOf, launch, newestReply, runEnd } from "./kit.ts";

const MACHINE = "lab-proxy";
const TOKEN = "stub-proxy-token";
const REPLY = "OK";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly bearer: boolean;
}

/** The Messages API's streamed answer for one text block, the shape claude reads from any base URL. */
const sse = (model: string) =>
  [
    ["message_start", { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ]
    .map(([event, data]) => `event: ${event as string}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");

const startStubProxy = async () => {
  const seen: Array<Seen> = [];
  const server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", bearer: req.headers.authorization === `Bearer ${TOKEN}` || req.headers["x-api-key"] === TOKEN });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "request-id": "req_stub" });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST") return json(404, { type: "error", error: { type: "not_found_error", message: "stub proxy" } });
      if (req.url?.includes("count_tokens")) return json(200, { input_tokens: 10 });
      let body: Body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
      } catch {
        // Not JSON: answered like any other message request.
      }
      const model = typeof body.model === "string" ? body.model : "stub";
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_stub" });
        return res.end(sse(model));
      }
      json(200, { id: "msg_stub", type: "message", role: "assistant", model, content: [{ type: "text", text: REPLY }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => server.close(r)) };
};

export async function ownProxy(lab: Lab) {
  const { check, ok, callTool } = lab;
  const repo = path.join(lab.dir, "repo");
  seedRepo(repo, MACHINE);
  const proxy = await startStubProxy();
  await lab.joinNode(MACHINE, {
    claudeSettings: { env: { ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_AUTH_TOKEN: TOKEN, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } },
  });
  try {
    // Online means its node's probe found a usable login, which here only the proxy settings provide.
    await lab.until(`${MACHINE} online`, 120_000, async () => {
      const s = (await callTool("fleetd_status")).body;
      if ((s.machines as Array<Body>).some((m) => m.machineId === MACHINE && m.status === "online")) return true;
      await callTool("events_wait", { cursor: s.cursor, timeoutSec: 5 });
      return undefined;
    });
    const checks = (await callTool("doctor_list", { rerun: true })).body.checks as Array<Body>;
    const login = checks.find((c) => c.id === `${MACHINE}/claude_login`);
    const described = `via proxy ${proxy.url} from ~/.claude/settings.json`;
    check(login?.status === "ok" && String(login.message).includes(described), `doctor names the user's proxy: ${JSON.stringify(login)}`);
    ok(`doctor ${login!.id}: ${login!.message}`);
    check(proxy.seen.every((r) => r.method !== "POST" || !r.url.includes("/messages")), `the probe made no model call: ${JSON.stringify(proxy.seen)}`);

    const projectId = await lab.addProject(MACHINE, repo, "proxy");
    const from = await lab.cursor();
    const threadId = await launch(lab, MACHINE, projectId, "fleetd lab own-proxy", "Reply with the single word OK and nothing else.");
    const { event } = await runEnd(lab, MACHINE, threadId, from, 120_000);
    check(event.type === "thread.completed", `the run through the proxy ended ${event.type}: ${event.summary}`);
    const { reply } = await newestReply(lab, MACHINE, threadId);
    check(reply === REPLY, `the reply is the proxy's: ${reply}`);

    const messages = proxy.seen.filter((r) => r.method === "POST" && r.url.includes("/v1/messages"));
    check(messages.length > 0, `the session's requests reached the proxy: ${JSON.stringify(proxy.seen)}`);
    check(messages.every((r) => r.bearer), "every request carried the token from the user's settings.json");
    ok(`${messages.length} model request(s) went through the stub proxy, none anywhere else`);

    // The session ran on the user's own setup: no config dir of fleetd's, fleetd's overlay and MCP config added on top.
    const proc = claudeOf(lab.nodePid(MACHINE)!, threadId);
    if (proc) {
      const environ = fs.readFileSync(`/proc/${proc.pid}/environ`, "utf8").split("\0");
      check(!environ.some((e) => e.startsWith("CLAUDE_CONFIG_DIR=")), "the session has no CLAUDE_CONFIG_DIR");
      check(proc.cmdline.includes("--settings") && !proc.cmdline.includes("--strict-mcp-config"), `argv: ${proc.cmdline.join(" ")}`);
      ok("the session runs without CLAUDE_CONFIG_DIR, with fleetd's --settings overlay and no --strict-mcp-config");
    }
    check(fs.existsSync(path.join(nodeHome(MACHINE), "transcripts", `${threadId}.jsonl`)), "fleetd keeps its own transcript copy");
  } finally {
    await lab.stopNode(MACHINE);
    await proxy.close();
  }
}
