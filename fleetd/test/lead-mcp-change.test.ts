// A bot's MCP connections changed while its lead is idle (one added, turned off, removed): the lead's next turn is a
// fresh session that has them, keeping its chat, with no Restart lead (as a Lead model pick, D690). Whatever the lead
// runs on: an Antigravity lead's servers are fixed at its session's start, as a Claude lead's are. Fake ports: no node.
import { afterEach, expect, test } from "bun:test";
import { Registry } from "../src/hub/api/registry.ts";
import { registerLeadCalls } from "../src/hub/chat/calls.ts";
import { chat } from "../src/hub/chat/index.ts";
import { leads } from "../src/hub/leads/index.ts";
import { start } from "../src/hub/leads/loops.ts";
import { leadWiring } from "../src/hub/leads/ports.ts";
import { mcpServers } from "../src/hub/mcp_servers/index.ts";
import { type SendOpts, WriteQueue } from "../src/hub/queue/index.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { isoMs } from "../src/hub/store/time.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const ADMIN = caller("admin", true, { personId: "p_ada", name: "Ada" });
const SCOPE = { kind: "project", ...PROJECT } as const;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0).reverse()) done();
});

function withLead() {
  const t = testHub();
  cleanups.push(t.done);
  const launches: string[] = [];
  const sends: string[] = [];
  t.hub.area(
    "write_queue",
    (h) =>
      new WriteQueue(h, {
        isConnected: () => true,
        awaitLive: async () => {},
        sendWith: async (_thread, text: string, _crid: string, _opts: SendOpts) => {
          sends.push(text);
          return {};
        },
      }),
  );
  start(t.hub);
  Object.assign(leadWiring(t.hub).ports, {
    launch: async (_m: string, input: { prompt: string }) => {
      launches.push(input.prompt);
      return `lead-${launches.length}`;
    },
  });
  registerLeadCalls(t.hub);
  const tools = new Registry();
  registerAll(tools);
  const call = async (tool: string, input: unknown) => {
    const out = (await tools.call(t.hub, ADMIN, tool, input)) as { output?: any; error?: { kind: string; error?: Error; message?: string } };
    if (out.error) throw new Error(out.error.error?.message ?? out.error.message ?? out.error.kind);
    return out.output;
  };
  /** The lead's thread as its node reports it once its turn ended. */
  const idle = () => {
    const lead = leads(t.hub).records.leadGet(PROJECT)!;
    const at = isoMs(t.hub.clock.now());
    store(t.hub).threadUpsert({
      thread: { machineId: PROJECT.machineId, threadId: lead.threadId, projectId: PROJECT.projectId, title: "lead", status: "idle", headline: "", latestMessageTail: "", lastProgressAt: at, stale: false, asOf: at } as never,
    });
  };
  let n = 0;
  const say = (text: string) => call("chat_send", { projectRef: PROJECT, text, clientRequestId: `c${++n}` });
  const server = (enabled: boolean) =>
    call("mcp_server_set", { scope: SCOPE, name: "deepwiki", enabled, roles: { lead: true, writers: true, reviewers: true }, transport: { type: "stdio", command: "deepwiki-mcp" }, env: [], headers: [] });
  /** The servers the lead's current session started with, by name. */
  const sessionHas = () => {
    const lead = leads(t.hub).records.leadGet(PROJECT)!;
    return Object.keys((leads(t.hub).records.leadMcpGet(PROJECT, lead.threadId) as { servers: Record<string, string> }).servers);
  };
  const lines = () => chat(t.hub).page(PROJECT, undefined, undefined, 50).messages.filter((m) => m.author === "system").map((m) => m.text);
  return { ...t, launches, sends, call, idle, say, server, sessionHas, lines };
}

test("a connection added while the lead is idle reaches its next turn in a fresh session, keeping its chat", async () => {
  const t = withLead();
  await t.say("hello");
  expect(t.launches.length).toBe(1);
  expect(t.sessionHas()).toEqual([]);
  chat(t.hub).add(PROJECT, { author: "lead", text: "Hi: what shall we build?" });
  t.idle();
  await t.server(true);
  expect(Object.keys(mcpServers(t.hub).leadSet(PROJECT).servers)).toEqual(["deepwiki"]);
  await t.say("look up the repo's wiki");
  // No Restart lead: the message starts a fresh session with the server, carrying the chat on.
  expect(t.launches.length).toBe(2);
  expect(t.sends).toEqual([]);
  expect(t.launches[1]).toContain("look up the repo's wiki");
  expect(t.launches[1]).toContain("Hi: what shall we build?");
  expect(t.sessionHas()).toEqual(["deepwiki"]);
  expect(t.lines()).toContain("deepwiki is connected: I can use it now.");
});

test("a connection turned off or removed while the lead is idle leaves its next session", async () => {
  const t = withLead();
  await t.server(true);
  await t.say("hello");
  expect(t.sessionHas()).toEqual(["deepwiki"]);
  t.idle();
  await t.server(false);
  await t.say("and now?");
  expect(t.launches.length).toBe(2);
  expect(t.sessionHas()).toEqual([]);
  t.idle();
  await t.server(true);
  await t.say("on again");
  expect(t.launches.length).toBe(3);
  expect(t.sessionHas()).toEqual(["deepwiki"]);
  t.idle();
  await t.call("mcp_server_remove", { scope: SCOPE, name: "deepwiki" });
  await t.say("gone?");
  expect(t.launches.length).toBe(4);
  expect(t.sessionHas()).toEqual([]);
  // Nothing changed since: the next message goes into the same session.
  t.idle();
  await t.say("thanks");
  expect(t.launches.length).toBe(4);
  expect(t.sends.length).toBe(1);
});

test("a connection changed right after a restart reaches the restarted lead's next turn", async () => {
  const t = withLead();
  await t.say("hello");
  t.idle();
  await leads(t.hub).restart(PROJECT);
  expect(t.launches.length).toBe(2);
  t.idle();
  await t.server(true);
  await t.say("use the wiki");
  expect(t.launches.length).toBe(3);
  expect(t.sessionHas()).toEqual(["deepwiki"]);
});
