import { afterAll, expect, test } from "bun:test";
import mcpToolsText from "../../app/desktop/src/shared/contracts/schema/McpTools.json" with { type: "text" };
import { LEAD_CALL_DEFS } from "../src/hub/api/decode.ts";
import { LEAD_CALLS } from "../src/shared/wire_tags.ts";
import { leadCalls, type LeadCall, type LeadResultFrame } from "../src/hub/lead_calls/index.ts";
import { build } from "../src/hub/serve/index.ts";
import { hubHome } from "./helpers.ts";

const home = hubHome();
const { hub } = build(home.dir, { host: "127.0.0.1", port: 0 });
afterAll(() => {
  hub.db.close();
  home.done();
});

hub.db.conn
  .query("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES ('devbox', 'p1', '', '2026-11-08T10:00:00Z', ?)")
  .run(JSON.stringify({ projectId: "p1", workspaceRoot: "/work/app", machineId: "devbox" }));

const calls = leadCalls(hub);
const seen: LeadCall[] = [];
for (const op of LEAD_CALLS) {
  calls.register(op, (_caller, call) => {
    seen.push(call);
    return {};
  });
}
const answer = (call: unknown, cwd = "/work/app") => calls.answer("devbox", { id: "c1", cwd, call: call as LeadCall });
const refusal = (frame: LeadResultFrame) => ("error" in frame ? frame.error : undefined);

const SESSION = {
  op: "browser_session",
  sessionId: `B${"a".repeat(32)}`,
  threadId: "th-1",
  purpose: "check the page",
  state: "live",
  startedAt: "2026-11-08T10:00:00Z",
};

test("every lead call op has its contract in LeadCall.json, and the defs it shares with McpTools.json are the same", () => {
  const variants = (LEAD_CALL_DEFS.LeadCall?.oneOf ?? []).map((v) => (v.properties?.op as { const?: string }).const);
  expect(new Set(variants)).toEqual(new Set(LEAD_CALLS));
  const mcp = (JSON.parse(mcpToolsText) as { $defs: Record<string, unknown> }).$defs;
  for (const [name, def] of Object.entries(LEAD_CALL_DEFS)) {
    if (name in mcp) expect([name, mcp[name]]).toEqual([name, def]);
  }
});

test("a browser session id that isn't one is refused before any handler sees it", async () => {
  const before = seen.length;
  const frame = await answer({ ...SESSION, sessionId: "x/../../sentinel" });
  expect(refusal(frame)).toEqual({
    code: "invalid",
    message: 'Invalid lead call: expected a string matching ^B[0-9a-f]{32}$, got "x/../../sentinel"',
    fix: "Send the call as its contract has it (crates/fleetd-contracts/src/lead_calls.rs); a node on another fleetd than the hub's may need updating.",
  });
  expect(seen.length).toBe(before);
  expect("result" in (await answer(SESSION))).toBe(true);
  expect(seen.at(-1)?.sessionId).toBe(SESSION.sessionId);
});

test("types, required fields, unknown ops and a bad frame are refused in serde's words", async () => {
  const detail = async (call: unknown, cwd?: string) => refusal(await answer(call, cwd))?.message.replace("Invalid lead call: ", "");
  expect(await detail({ op: "nope" })).toStartWith("unknown variant `nope`, expected one of");
  expect(await detail({ key: "a.b" })).toBe("missing field `op`");
  expect(await detail("decide")).toBe('invalid type: string "decide", expected internally tagged enum LeadCall');
  expect(await detail({ op: "decide", key: "a.b" })).toBe("missing field `value`");
  expect(await detail({ op: "decide", key: "Not A Key", value: "v" })).toStartWith("expected a string matching");
  expect(await detail({ op: "task_spawn", workstreamId: 1, title: "t", prompt: "p" })).toBe(
    "invalid type: integer `1`, expected a string",
  );
  expect(await detail({ op: "ask_lead", question: "" })).toBe("expected a non-empty string");
  expect(await detail({ op: "ask_lead", question: "x".repeat(4001) })).toBe("expected at most 4000 characters");
  expect(await detail({ op: "ask_lead", question: "?" }, "work/app")).toBe("cwd must be an absolute path");
});

test("defaults are filled and fields the contract doesn't name are dropped", async () => {
  await answer({ op: "task_spawn", workstreamId: "W1", title: "t", prompt: "p", sneaky: "x" });
  expect(seen.at(-1)).toEqual({ op: "task_spawn", workstreamId: "W1", title: "t", prompt: "p", kind: "write" });
  await answer({ op: "gated_run", argv: ["./deploy.sh"], class: "irreversible", reason: "deploy" });
  expect(seen.at(-1)?.timeoutSec).toBe(1800);
  expect(await answer({ op: "gated_run", argv: ["./deploy.sh"], class: "irreversible", reason: "deploy", timeoutSec: 14_401 })).toHaveProperty("error");
});

test("the contracts' checked! rules on brief_create, request_secret and task_spawn", async () => {
  const brief = { goal: "g", why: "w", pointers: [], constraints: [], doneWhen: ["it works"] };
  const words = async (call: unknown) => refusal(await answer(call))?.message;
  expect(await words({ op: "brief_create", brief })).toBe(
    "Invalid lead call: give workstreamId to brief an open workstream, or text to open one",
  );
  expect(await words({ op: "brief_create", workstreamId: "W1", text: "do it", brief })).toBe(
    "Invalid lead call: text opens a workstream; leave it out with workstreamId",
  );
  const secret = { op: "request_secret", key: "stripe.test_key", text: "Need the key" };
  expect(await words({ ...secret, sink: "file:devbox:/srv/app/key", envName: "STRIPE_KEY" })).toBe(
    "Invalid lead call: only an env: or order: sink has an env name",
  );
  expect("result" in (await answer({ ...secret, sink: "env:devbox:/srv/app/.env", envName: "STRIPE_KEY" }))).toBe(true);
  const spawn = { op: "task_spawn", workstreamId: "W1", title: "t", prompt: "p" };
  expect(await words({ ...spawn, qa: true })).toBe("Invalid lead call: --qa applies only to --kind review");
  expect(await words({ ...spawn, kind: "review" })).toBe("Invalid lead call: a review task needs --pr <PR URL>");
  expect(await words({ ...spawn, notDuplicateOf: ["T1"] })).toBe(
    "Invalid lead call: notDuplicateOf needs notDuplicateWhy: one line on why it is different work",
  );
});
