// A bot made before its team had a Claude account (a new cloud team on fleetd's computers, or a hub before its API key):
// its lead's thread launched on no account. The key saved afterwards reaches that bot at its next turn, a fresh session
// on the key keeping its chat, with no remake and no Restart lead (G1, W890); one refused for its sign-in carries on by
// itself once the key is saved. Fake ports: no node.
import { afterEach, expect, test } from "bun:test";
import { Registry } from "../src/hub/api/registry.ts";
import { registerLeadCalls } from "../src/hub/chat/calls.ts";
import { chat } from "../src/hub/chat/index.ts";
import { forLead, isRefusal, leadAccountMoved, Setup } from "../src/hub/claude_accounts/index.ts";
import { accounts } from "../src/hub/claude_accounts/tools.ts";
import { leads } from "../src/hub/leads/index.ts";
import { start } from "../src/hub/leads/loops.ts";
import { leadWiring } from "../src/hub/leads/ports.ts";
import { signedInAgain } from "../src/hub/leads/signed_in.ts";
import { type SendOpts, WriteQueue } from "../src/hub/queue/index.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { ProjectRef } from "../src/shared/contracts.ts";
import { RUNNER_ID } from "../src/shared/sandbox.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const ADMIN = caller("admin", true, { personId: "p_ada", name: "Ada" });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0).reverse()) done();
});

function withLead(r: ProjectRef) {
  const t = testHub();
  cleanups.push(t.done);
  const at = isoMs(t.hub.clock.now());
  t.hub.db.conn.query("INSERT INTO machines (machine_id, data) VALUES (?, ?)").run(r.machineId, JSON.stringify({ machineId: r.machineId, name: r.machineId, status: "online", lastSeenAt: at }));
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
  // The real port's account (leads/wiring.ts), recorded per thread as the executor's launch does.
  Object.assign(leadWiring(t.hub).ports, {
    launch: async (m: string, input: { prompt: string; projectId: string }) => {
      launches.push(input.prompt);
      const threadId = `lead-${launches.length}`;
      const account = forLead(t.hub.db, () => "runs", { machineId: m, projectId: input.projectId });
      if (isRefusal(account)) throw new Error(account.message);
      if (account !== undefined) accounts(t.hub).setThreadAccount(m, threadId, account);
      return threadId;
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
  const lead = () => leads(t.hub).records.leadGet(r)!;
  /** The lead's thread as its node reports it once its turn ended. */
  const idle = () => {
    const now = isoMs(t.hub.clock.now());
    store(t.hub).threadUpsert({
      thread: { machineId: r.machineId, threadId: lead().threadId, projectId: r.projectId, title: "lead", status: "idle", headline: "", latestMessageTail: "", lastProgressAt: now, stale: false, asOf: now } as never,
    });
  };
  /** The hub's API key saved, held where the bot runs (claude_hub_api_set's record, the seal relayed). */
  const saveKey = () => {
    accounts(t.hub).putHubApi({ sealedOn: [{ machineId: r.machineId, fingerprint: "sha256:aa" } as never], updatedAt: isoMs(t.hub.clock.now()) });
  };
  const runsOn = () => accounts(t.hub).threadAccount(r.machineId, lead().threadId);
  let n = 0;
  const say = (text: string) => call("chat_send", { projectRef: r, text, clientRequestId: `c${++n}` });
  const lines = () => chat(t.hub).page(r, undefined, undefined, 50).messages.filter((m) => m.author === "system").map((m) => m.text);
  return { ...t, launches, sends, call, idle, saveKey, runsOn, say, lines, lead };
}

test("a key saved after a bot was made reaches its lead's next turn in a fresh session on the key, keeping its chat", async () => {
  const t = withLead(PROJECT);
  await t.say("hello");
  expect(t.launches.length).toBe(1);
  // Made before the team had an account: the machine's own login.
  expect(t.runsOn()).toBeUndefined();
  chat(t.hub).add(PROJECT, { author: "lead", text: "Hi: what shall we build?" });
  t.idle();
  t.saveKey();
  await t.say("add dark mode");
  // No remake, no Restart lead: the message starts a fresh session on the key, carrying the chat on.
  expect(t.launches.length).toBe(2);
  expect(t.sends).toEqual([]);
  expect(t.launches[1]).toContain("add dark mode");
  expect(t.launches[1]).toContain("Hi: what shall we build?");
  expect(t.runsOn()).toEqual({ kind: "hub" });
  // On the key now: the next message goes into the same session.
  t.idle();
  await t.say("and a toggle");
  expect(t.launches.length).toBe(2);
  expect(t.sends.length).toBe(1);
  // Removed: the lead's next turn leaves the key it no longer has.
  accounts(t.hub).removeHubApi();
  t.idle();
  await t.say("still there?");
  expect(t.launches.length).toBe(3);
  expect(t.runsOn()).toBeUndefined();
});

test("a lead mid-turn keeps its session when the key is saved: the turn after it moves", async () => {
  const t = withLead(PROJECT);
  await t.say("hello");
  // Its thread hasn't reported its turn's end: busy.
  t.saveKey();
  await t.say("and this");
  expect(t.launches.length).toBe(1);
  expect(t.sends.length).toBe(1);
  t.idle();
  await t.say("now");
  expect(t.launches.length).toBe(2);
  expect(t.runsOn()).toEqual({ kind: "hub" });
});

test("a lead refused for its sign-in on no account carries on by itself once the key is saved, in a fresh session on it", async () => {
  // The cloud's bot on fleetd's computers is the same lead (fleetd-cloud's leads/follow.ts reads signedOutLine with its
  // machine; settings_paths.test.ts holds its line to Providers › Anthropic): here a machine with no login.
  const t = withLead(PROJECT);
  await t.say("hello");
  expect(t.runsOn()).toBeUndefined();
  events(t.hub).append({
    at: isoMs(t.hub.clock.now()),
    type: "thread.failed",
    machineId: PROJECT.machineId,
    projectId: PROJECT.projectId,
    threadId: t.lead().threadId,
    summary: "failed",
    data: { runId: "r1", endCause: "failed", error: { class: "auth", message: "Not logged in · Please run /login" } },
  });
  for (let i = 0; i < 200 && t.lines().length === 0; i++) await Bun.sleep(10);
  expect(t.lines()).toEqual(["Claude's sign-in on this bot's machine stopped working: sign it in again there with `claude auth login`, then send a message."]);
  t.idle();
  // An admin saves the key: the lead carries on by itself, on the key rather than the login that refused it.
  t.saveKey();
  signedInAgain(t.hub);
  for (let i = 0; i < 1500 && t.launches.length < 2; i++) await Bun.sleep(10);
  expect(t.launches.length).toBe(2);
  expect(t.launches[1]).toContain("Your Claude sign-in was reconnected");
  expect(t.sends).toEqual([]);
  expect(t.runsOn()).toEqual({ kind: "hub" });
}, 30_000);

test("leadAccountMoved, the rule fleetd cloud's leads read too: moved to a key saved or from one removed, never to a refusal", () => {
  const api = (machineId: string) => ({ sealedOn: [{ machineId, fingerprint: "sha256:aa" }], updatedAt: "2026-11-08T10:00:00Z" }) as never;
  const setup = (hubApi?: unknown) => new Setup(hubApi as never, { membersUseHubApi: true }, new Map(), new Map(), "p_owner000", new Map([["p_owner000", "owner"]]));
  // Nothing set up, nothing recorded: as it was.
  expect(leadAccountMoved(setup(), RUNNER_ID, undefined)).toBe(false);
  // A key saved since the bot was made on none: moved; on the key already: not.
  expect(leadAccountMoved(setup(api(RUNNER_ID)), RUNNER_ID, undefined)).toBe(true);
  expect(leadAccountMoved(setup(api(RUNNER_ID)), RUNNER_ID, { kind: "hub" })).toBe(false);
  // The key removed: back to the machine's own login.
  expect(leadAccountMoved(setup(), RUNNER_ID, { kind: "hub" })).toBe(true);
  // The key held on another machine only: refused here, so the thread stays.
  expect(leadAccountMoved(setup(api("devbox")), RUNNER_ID, undefined)).toBe(false);
});
