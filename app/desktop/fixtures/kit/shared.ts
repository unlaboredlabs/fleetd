// The shared fixtures every screen is registered against (group.ts SHARED). `typical` and `empty` are real lab hub
// traffic (recorded/, see record.ts and sanitize.ts); the others are those with one thing pushed to its limit.
import fs from "node:fs";
import path from "node:path";
import type { FixtureFile } from "../../src/main/hub/fixture.ts";
import { Fixture, HUB, PROTOCOL } from "./fixture.ts";
import type { SharedName } from "./group.ts";
import { at } from "./ids.ts";
import { isObject, type JsonObject, asText } from "./json.ts";
import { arr, longText, manyAgents, manyPrompts, NODE_TOO_OLD } from "./stress.ts";
import { explainLoss } from "../../src/main/hub/explain.ts";
import { agentsAt, answerRows, commandApproval, LOG, SCREENSHOT, type Draft, firstProject, fromLines, liveStrip, migrated, type Ref, type SceneAgent, sceneStrip, secretRequest, statusRow, streamReply, writeChat } from "./chat.ts";
import { longChat, QUESTION, STREAMING_REST, STREAMING_SO_FAR, TERSE } from "./chatText.ts";
import { uuid } from "./ids.ts";
import { LONG_TITLES, ofLength } from "./text.ts";

const RECORDED = path.join(import.meta.dirname, "../recorded");

/** A recorded lab moment (recorded/<name>.json), as written by sanitize.ts. */
const recorded = (name: string): Fixture =>
  Fixture.fromFile(JSON.parse(fs.readFileSync(path.join(RECORDED, `${name}.json`), "utf8")) as FixtureFile);

// ---- The lead chat ----

/**
 * Every other snapshot project gets a chat and a status row too, so no sidebar entry spins and the dot agrees with
 * the row. They cycle working / waiting on you / blocked / idle by position, as fixtures/status cycles its rows.
 */
const withProjectRows = (f: Fixture, first: { needsYou?: boolean; leadWorking?: boolean }): Fixture => {
  const projects = arr(f.snapshot?.["projects"]).filter(isObject);
  const rows = projects.map((p, i) => {
    const ref = { machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) };
    const title = asText(p["title"]);
    if (i === 0) {
      const state = first.needsYou === true ? "waiting_on_you" : first.leadWorking === true ? "working" : "idle";
      return statusRow(f, ref, title, state, state === "working" ? { agents: 3, merged: "Receipt dates use Intl" } : {});
    }
    switch (i % 4) {
      case 0:
        writeChat(f, ref, [{ author: "human", text: "keep going on the export" }, { author: "lead", text: "On it. Two agents working." }], { leadWorking: true });
        return statusRow(f, ref, title, "working", { agents: 2 });
      case 1:
        writeChat(f, ref, fromLines(QUESTION).slice(0, 1), { needsYou: true });
        return statusRow(f, ref, title, "waiting_on_you", { merged: "Nightly export resumes after a crash" });
      case 2:
        writeChat(f, ref, [{ author: "lead", text: "`rust (macos)` failed on main after the last merge; an agent is on it." }]);
        return statusRow(f, ref, title, "idle", { warning: "`rust (macos)` is red on main, fix in progress" });
      default:
        writeChat(f, ref, []);
        return statusRow(f, ref, title, "idle");
    }
  });
  return answerRows(f, rows);
};

/** The first project's chat: the lead's numbered question with its recommendations, and terse replies. */
const withChat = (f: Fixture, drafts: ReadonlyArray<Draft> = [...fromLines(QUESTION), ...fromLines(TERSE)], opts: { needsYou?: boolean; leadWorking?: boolean } = {}): Fixture => {
  writeChat(f, firstProject(f), drafts, opts);
  return withProjectRows(f, opts);
};

const LONG = 520;
const longDrafts = (): Array<Draft> => [...migrated(), ...fromLines(longChat(LONG)), ...fromLines(QUESTION), ...fromLines(TERSE)];

/** The sidebar and Status mix: projects needing you, running, both and neither, each row state, long names. */
const PROJECTS: ReadonlyArray<{ title: string; machine: string; needsYou: boolean; working: boolean; row: Parameters<typeof statusRow>[3]; extra: Parameters<typeof statusRow>[4] }> = [
  { title: "storefront", machine: "devbox", needsYou: false, working: true, row: "working", extra: { agents: 4, merged: "Receipt dates use Intl" } },
  { title: "billing", machine: "buildbox", needsYou: true, working: false, row: "waiting_on_you", extra: { agents: 0, merged: "Nightly export resumes after a crash", mergedAgoMs: 26 * 3_600_000 } },
  { title: "checkout", machine: "devbox", needsYou: false, working: false, row: "idle", extra: { warning: "`ios sessions` is red on main, fix in progress" } },
  { title: "docs", machine: "devbox", needsYou: false, working: false, row: "idle", extra: { merged: "Quick start opens a project's chat", mergedAgoMs: 12 * 86_400_000 } },
  { title: "inventory", machine: "buildbox", needsYou: true, working: true, row: "waiting_on_you", extra: { agents: 2 } },
  { title: "search", machine: "buildbox", needsYou: false, working: false, row: "blocked", extra: { blocked: "buildbox is offline", stale: "buildbox stopped answering" } },
  { title: ofLength(LONG_TITLES[1], 118), machine: "devbox", needsYou: false, working: true, row: "working", extra: { agents: 12 } },
  { title: "mobile", machine: "devbox", needsYou: false, working: false, row: "idle", extra: {} },
];

const withProjectsMix = (f: Fixture): Fixture => {
  if (f.snapshot === undefined) throw new Error("status-rows needs a snapshot");
  // storefront keeps the id every chat fixture uses, so one registry route opens it in all of them.
  const storefront = firstProject(f);
  const id = (title: string) => (title === "storefront" ? storefront.projectId : uuid(`project ${title}`));
  f.snapshot["projects"] = PROJECTS.map((p, i) => ({
    machineId: p.machine,
    projectId: id(p.title),
    title: p.title,
    workspaceRoot: `/home/dev/src/${i === 6 ? "pricing-copy" : p.title}`,
    lastActivityAt: at(f.now, -i * 600_000),
    threads: { running: p.working ? 1 : 0, waiting: p.needsYou ? 1 : 0, idle: 2, failed: p.row === "blocked" ? 1 : 0 },
  }));
  f.snapshot["chats"] = [];
  const rows = PROJECTS.map((p) => {
    const ref: Ref = { machineId: p.machine, projectId: id(p.title) };
    // Every project has a chat, so opening any of them (the frame opens the first) shows it rather than an error.
    const drafts: Array<Draft> =
      p.title === "mobile"
        ? []
        : p.needsYou
          ? fromLines(QUESTION).slice(0, 1)
          : p.row === "blocked"
            ? [{ author: "lead", text: `Stuck: ${p.extra?.blocked ?? "blocked"}. I'll pick it up as soon as that clears.` }]
            : [{ author: "human", text: "how's it going" }, { author: "lead", text: p.working ? "Agents are on it. Nothing needs you." : "All done. Nothing running." }];
    writeChat(f, ref, drafts, { needsYou: p.needsYou, leadWorking: p.working });
    return statusRow(f, ref, p.title, p.row, p.extra);
  });
  // The sidebar counts a project's running agents from its live lanes: give each the agents its row says.
  agentsAt(
    f,
    PROJECTS.flatMap((p) => ((p.extra?.agents ?? 0) > 0 ? [{ ref: { machineId: p.machine, projectId: id(p.title) }, n: p.extra?.agents ?? 0 }] : [])),
    true,
  );
  return answerRows(f, rows);
};

const chatFixtures = (copy: (name: SharedName, note: string) => Fixture): Array<Fixture> => {
  const strip = (f: Fixture, n: number) => liveStrip(f, firstProject(f), n);
  const scene = (f: Fixture, title: string, agents: ReadonlyArray<SceneAgent>) => sceneStrip(f, firstProject(f), title, agents);
  return [
    withChat(copy("chat-long", `${String(LONG)}+ messages in the first project's chat, paged 50 at a time: migrated past orders first, Markdown, code, lists, the lead's numbered question and terse replies.`), longDrafts()),
    (() => {
      const f = strip(
        withChat(
          copy("chat-streaming", "The lead mid-reply: its message streams in over the live chat feed, still unfinished, while 3 agents work under it."),
          [...fromLines(QUESTION), { author: "lead", text: STREAMING_SO_FAR, state: "streaming" }],
          { leadWorking: true },
        ),
        3,
      );
      return streamReply(f, firstProject(f), STREAMING_REST);
    })(),
    withChat(copy("chat-attachments", "A screenshot and a log file sent to the lead, and its reply."), [
      ...fromLines(QUESTION),
      { author: "human", text: "the receipt looks off on mobile, see screenshot + log", attachments: [SCREENSHOT, LOG] },
      { author: "human", text: "", attachments: [SCREENSHOT] },
      { author: "lead", text: "Got both. The date wraps under the total on narrow screens; a writer is fixing the layout." },
    ]),
    // The agents beside each item work on what its chat asked for, so the panel and the strip fit the scene (the
    // site's approve and secret shots are these chats).
    scene(
      withChat(
        copy("chat-secret", "The lead needs a secret: an open masked entry inline, and an earlier one already stored; two agents work on the checkout tests."),
        [
          { author: "lead", text: "Stored earlier for the receipt tests." },
          { author: "lead", text: "", item: secretRequest("stored", copy("empty", "")) },
          { author: "human", text: "run the checkout tests against Stripe test mode" },
          { author: "lead", text: "Need the Stripe test key for that. It goes to devbox only and never into this chat." },
          { author: "lead", text: "", item: secretRequest("open", copy("empty", "")) },
        ],
        { needsYou: true },
      ),
      "Run the checkout tests against Stripe test mode",
      [
        { role: "implementer", title: "Point the checkout tests at Stripe test mode", activity: { kind: "edit", path: "tests/checkout/stripe.setup.ts" } },
        { role: "reader", title: "Read how the receipt tests use Stripe", activity: { kind: "read", path: "tests/receipt/charge.test.ts" } },
      ],
    ),
    scene(
      withChat(
        copy("chat-gated", "A risky command waits for Approve / Deny: the exact command inline; an earlier one ran, one was denied, and an agent's permission prompt; two agents work on the share snapshots."),
        [
          { author: "lead", text: "Last week's migration ran:" },
          { author: "lead", text: "", item: commandApproval("ran", copy("empty", "")) },
          { author: "lead", text: "", item: commandApproval("denied", copy("empty", ""), true) },
          { author: "human", text: "ship the share snapshots table" },
          { author: "lead", text: "This writes to the production database. Approve to run it exactly as below." },
          { author: "lead", text: "", item: commandApproval("open", copy("empty", "")) },
        ],
        { needsYou: true },
      ),
      "Ship the share snapshots table",
      [
        { role: "implementer", title: "Serve share links from the snapshots table", activity: { kind: "edit", path: "src/share/route.ts" } },
        { role: "reviewer", title: "Review the share snapshots migration", activity: { kind: "read", path: "db/migrations/20261019_share_snapshots.sql" } },
      ],
    ),
    strip(withChat(copy("chat-waiting", "The lead asked its numbered question and waits on you: the needs-you dot, no agents running."), fromLines(QUESTION).slice(0, 1), { needsYou: true }), 0),
    strip(withChat(copy("chat-empty", "A project whose chat has no messages yet, and no agents at work."), []), 0),
    withProjectsMix(copy("status-rows", "Eight projects: rows in all four states (one stale, one with a ~120-character name), and the sidebar's needs-you and running mix.")),
  ];
};

/** Every shared fixture, by name, freshly built. */
export const buildShared = (): Map<SharedName, Fixture> => {
  const typical = withChat(Fixture.from(recorded("lab-demo"), "typical", "A real lab hub mid-order: one order fanned out to writers and a reviewer per PR, three PRs in the train, live lanes, prompts and time."), undefined, { leadWorking: true });
  // The recording's later live frames settle lanes its board answer (read a moment earlier) still shows working; the
  // app would refetch the board, a fixture can't. Its full frame alone agrees with the board.
  typical.live = typical.live.filter((frame) => frame["full"] === true);
  const copy = (name: SharedName, note: string) => Fixture.from(typical, name, note);
  const shared: Array<Fixture> = [
    answerRows(Fixture.from(recorded("lab-start"), "empty", "A real lab hub before anything happened: machines online, no projects, orders, chats or time."), []),
    typical,
    longText(copy("long-text", "Every title ~120 characters, a ~250-character judge criterion, long branches, paths, prose and prompt keys.")),
    manyPrompts(copy("many-prompts", "72 prompts with long dotted ids, every other one overridden for the project.")),
    manyAgents(copy("many-agents", "One order with 12 working and 14 finished agents (26 lanes), and a board of six orders.")),
    (() => {
      const f = new Fixture("hub-unreachable", "The saved hub doesn't answer; the app retries.");
      // The words the real client gives a refused connect (src/main/hub/explain.ts).
      f.state = { phase: "retrying", hub: HUB, ...explainLoss(HUB, 1006, "", { code: "ECONNREFUSED", message: "connect ECONNREFUSED" }, false), retryAt: Date.parse(f.now) + 8000 };
      return f;
    })(),
    (() => {
      const f = new Fixture("pairing-failed", "The hub refused the saved key, and a new pairing code has expired.");
      f.state = { phase: "refused", hub: HUB, message: "The hub refused this app's key: it was revoked or belongs to another hub." };
      f.connect = { ok: false, message: "That pairing code has expired. Make a new one on the hub with `fleetd pair` and paste it again." };
      // A code typed into the form meets the same expired code at the hub.
      f.pair = { healthz: { ok: true, version: "0.5.0", protocol: PROTOCOL }, redeem: { status: 410, body: { code: "pair_code_expired", message: "That pairing code has expired.", fix: "Run `fleetd pair` on the hub for a new code." } } };
      return f;
    })(),
    (() => {
      const f = copy("node-too-old", "buildbox runs a node too old for the hub: it shows degraded, and finding, inspecting or cloning repos fails.");
      const old = (m: JsonObject) => (m["machineId"] === "buildbox" ? { ...m, status: "degraded", nodeVersion: "0.3.1", degradedReason: "node 0.3.1 is older than this hub needs (0.4.0)" } : m);
      if (f.snapshot !== undefined) f.snapshot["machines"] = arr(f.snapshot["machines"]).map((m) => (isObject(m) ? old(m) : m));
      for (const frame of f.live) if (Array.isArray(frame["machines"])) frame["machines"] = frame["machines"].map((m) => (isObject(m) ? (m["machineId"] === "buildbox" ? { ...m, status: "degraded" } : m) : m));
      f.drop("project_discover");
      for (const a of f.answers("project_add")) if (a.input?.["dryRun"] === true) f.drop("project_add", a.input);
      f.fail("project_discover", undefined, NODE_TOO_OLD).fail("project_add", { dryRun: true }, NODE_TOO_OLD);
      return f;
    })(),
    copy("time-heavy", "The time inspector's stress case: fixtures/time fills it with an order of about 15,000 spans, paged 500 at a time."),
    ...chatFixtures(copy),
  ];
  return new Map(shared.map((f) => [f.name as SharedName, f]));
};
