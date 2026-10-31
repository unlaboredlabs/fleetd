// The showcase's scenes past the storefront's request (qa/showcase.spec.ts moves through them as the batch merges),
// each made of another group's fixture rather than data of its own: Navi with Ada and Home above the projects, Ada's
// lease renewal waiting on your approval and the order it asked storefront for (fixtures/navi), and a second hub, Personal, beside this one in the sidebar (fixtures/sidebar).
// Hub › People's people and invites are admin-owner's (fixtures/admin), and so are the people in checkout's chat, which
// the team shares: Sam writes from this app, Alice and Bob from theirs, and the lead answers them together. The nightly
// memory refresh's line is in storefront's chat (index.ts), and its built-in row on the Automations page comes with
// every fixture (fixtures/settings).
import type { Fixture } from "../kit/fixture.ts";
import { writeChat, type Ref } from "../kit/chat.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";
import { PEOPLE } from "../admin/index.ts";
import { navi, toolApproval, type ToolCall } from "../navi/index.ts";
import { ADA, HOME } from "../navi/ids.ts";
import { retitle } from "../sidebar/index.ts";

/** Ada's renewal: the request the card answers. */
export const ADA_REQUEST = "Q71";
/** How long after Send it Ada says it sent. */
const SENT_MS = 600;

const LEASE: ToolCall = {
  server: "lettings",
  tool: "send_renewal",
  action: "send",
  summary: "Send Marta Klein the lease renewal, with the signed tenant form and October's payslip",
  input: {
    to: "Marta Klein",
    lease: "Flat 3, 18 Elm Street",
    term: "12 months from 2026-12-01",
    files: ["tenant-form-signed.pdf", "payslip-2026-10.pdf"],
    note: "Hi Marta, here are both forms for the renewal. Best, Sam",
  },
};

/**
 * Ada and Home above the projects. Ada asked storefront for W18 earlier; just now it got the lease renewal ready, and
 * sending it waits on you. Send it answers, and Ada says so.
 */
export const naviScene = (f: Fixture, storefront: Ref): void => {
  if (f.snapshot === undefined) throw new Error("the showcase needs a snapshot");
  f.snapshot["projects"] = [...arr(f.snapshot["projects"]), navi(f, ADA, "Ada", "ada"), navi(f, HOME, "Home", "home")];
  if (f.state.phase === "live") f.state = { ...f.state, features: [...(f.state.features ?? []), "navi_asks"] };
  const item = { ...toolApproval(ADA, "ada", LEASE), requestId: ADA_REQUEST };
  const messages = writeChat(
    f,
    ADA,
    [
      { author: "human", text: "Ask the storefront lead to apply gift cards before tax; customers keep asking.", minutesAgo: 52 },
      { author: "lead", text: "Asked storefront’s lead (N3). It opened order W18, *Gift cards apply before tax*, and two writers are on it. I’ll tell you when it lands.", minutesAgo: 51 },
      { author: "human", text: "Get the lease renewal ready for Marta: the tenant form and my October payslip.", minutesAgo: 30 },
      { author: "lead", text: "I filled in the tenant form and added your October payslip. The renewal goes to Marta once you approve it.", minutesAgo: 1 },
      { author: "lead", text: "", item, minutesAgo: 1 },
    ],
    { needsYou: true },
  );
  // Its request, open until Send it answers it.
  const request = { requestId: ADA_REQUEST, projectRef: { ...ADA }, kind: "approval", text: LEASE.summary, createdAt: new Date(Date.parse(f.now) - 60_000).toISOString() };
  const old = f.output("requests_list", { limit: 100 });
  f.answer("requests_list", { limit: 100 }, { requests: [...(isObject(old) ? arr(old["requests"]) : []), { ...request, state: "open" }, { ...request, state: "approved" }] });
  const row = (state: string) => ({ tool: "requests_list", field: "requests", where: { requestId: ADA_REQUEST, state } });
  f.hidden.push(row("approved"));
  f.answer("navi_asks", { navi: { ...ADA } }, {
    navi: { ...ADA },
    asks: [
      {
        handle: "N3",
        to: { ...storefront },
        toTitle: "storefront",
        text: "Apply gift cards before tax; customers keep asking.",
        at: new Date(Date.parse(f.now) - 51 * 60_000).toISOString(),
        orders: [{ workstreamId: "W18", title: "Gift cards apply before tax", state: "open", headline: "Two writers at work: the tax order, and the balance at checkout." }],
      },
      {
        handle: "N2",
        to: { ...storefront },
        toTitle: "storefront",
        text: "Send me last month’s orders by country.",
        at: new Date(Date.parse(f.now) - 86_400_000).toISOString(),
        orders: [{ workstreamId: "W15", title: "Orders by country", state: "done", headline: "Sent the totals as a CSV." }],
      },
    ],
  });
  // Send it: the card turns, and Ada says it went.
  const seq = messages.length + 1;
  const sent = {
    messageId: `m${String(seq)}`,
    projectRef: { ...ADA },
    seq,
    author: "lead",
    text: "Sent to Marta, with both forms. I’ll tell you when she answers.",
    attachments: [],
    createdAt: f.now,
    state: "final",
  };
  const event = (type: string, summary: string, data: JsonObject): JsonObject => ({ seq: 900, at: f.now, type, summary, ...ADA, data });
  f.answer("approval_answer", { requestId: ADA_REQUEST, decision: "approve" }, { request: { ...request, state: "approved" } });
  f.then("approval_answer", { requestId: ADA_REQUEST, decision: "approve" }, {
    hide: [row("open")],
    show: [row("approved")],
    frames: [
      { ms: 50, kind: "event", payload: event("request.updated", `${ADA_REQUEST} approved`, { requestId: ADA_REQUEST, projectRef: { ...ADA }, state: "approved" }) },
      {
        ms: SENT_MS,
        kind: "event",
        payload: event("chat.message", "Ada in the chat", { projectRef: { ...ADA }, messageId: sent.messageId, seq, author: "lead", state: "final", message: sent }),
      },
    ],
  });
  const state = { projectRef: { ...ADA }, needsYou: false, leadWorking: false, lastSeq: seq, lastMessageAt: f.now };
  f.answer("chat_history", { projectRef: { ...ADA }, after: seq - 1 }, { messages: [sent], moreBefore: true, moreAfter: false, state });
  f.answer("chat_history", { projectRef: { ...ADA }, after: seq }, { messages: [], moreBefore: true, moreAfter: false, state });
};

/** A second hub beside this one, as sidebar-hubs has it: Personal's projects, this one Acme's. */
export const hubsScene = (f: Fixture, other: Fixture): void => {
  retitle(other, { storefront: "blog", billing: "garden-sensors", checkout: "recipes" });
  other.state = { phase: "live", hub: "https://hub.home.example", protocol: f.state.phase === "live" ? f.state.protocol : 1 };
  f.label = "Acme";
  f.color = "amber";
  f.hubs = [{ label: "Personal", color: "green", fixture: other }];
};

/** What Sam asks checkout's lead, with Alice and Bob in the same chat. */
export const TEAM_REQUEST = "Can we add Apple Pay to the app’s checkout?";
/** After Sam's send: Alice's message lands, then the lead's answer to both of them streams in. */
export const TEAM_STEPS = { alice: 1400, lead: 2900, said: 3800 } as const;

/**
 * checkout's chat, which the team shares: Bob's request from earlier and the lead's answer to it. Sam's send plays the
 * rest: Alice adds hers, and the lead answers the two of them in one reply.
 */
export const teamScene = (f: Fixture): void => {
  const p = arr(f.snapshot?.["projects"]).map(obj).find((x) => x["title"] === "checkout");
  if (p === undefined) throw new Error("the showcase's hub has no checkout project");
  const ref: Ref = { machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) };
  // Its main is green here: the clip is about the chat.
  for (const row of arr(obj(f.output("status_get", {}))["rows"]).map(obj)) if (row["title"] === "checkout") delete row["warning"];
  const earlier = writeChat(f, ref, [
    { author: "human", text: "Receipts should show the store’s VAT number.", minutesAgo: 48 },
    { author: "lead", text: "Bob, done: #84 merged an hour ago, and receipts show the VAT number under the total.", minutesAgo: 47 },
  ]);
  const [bob] = earlier;
  if (bob !== undefined) bob["person"] = { ...PEOPLE.bob };
  const projectRef = { ...ref };
  const iso = (ms: number) => new Date(Date.parse(f.now) + ms).toISOString();
  let seq = earlier.length;
  const message = (n: number, author: "human" | "lead", text: string, state: "final" | "streaming", ms: number, over: JsonObject = {}): JsonObject => ({
    messageId: `m${String(n)}`,
    projectRef: { ...projectRef },
    seq: n,
    author,
    text,
    attachments: [],
    createdAt: iso(ms),
    state,
    ...over,
  });
  let events = 800;
  const event = (type: string, summary: string, data: JsonObject): JsonObject => ({ seq: ++events, at: f.now, type, summary, ...ref, data });
  const said = (m: JsonObject) => event("chat.message", "In the chat", { projectRef: { ...projectRef }, messageId: m["messageId"] ?? "", seq: m["seq"] ?? 0, author: m["author"] ?? "", state: m["state"] ?? "", message: m });
  const mine = message(++seq, "human", TEAM_REQUEST, "final", 0, { by: "laptop", clientRequestId: "showcase-team", delivery: "turn", person: { ...PEOPLE.sam } });
  const alice = message(++seq, "human", "If we do, keep card entry as the fallback: half our shoppers don’t have it set up.", "final", TEAM_STEPS.alice, { by: "ThinkPad", delivery: "steer", person: { ...PEOPLE.alice } });
  const reply = "Sam, Alice: one order for both. Apple Pay at checkout, with card entry kept as the fallback. A writer starts on it now.";
  const lead = ++seq;
  const waiting = (leadWorking: boolean): JsonObject => event("chat.waiting", "The lead's turn", { projectRef: { ...projectRef }, needsYou: false, leadWorking, lastSeq: seq, lastMessageAt: f.now });
  f.answer("chat_send", { text: TEAM_REQUEST }, { message: mine });
  f.then("chat_send", { text: TEAM_REQUEST }, {
    frames: [
      { ms: 0, kind: "event", payload: waiting(true) },
      { ms: TEAM_STEPS.alice, kind: "event", payload: said(alice) },
      { ms: TEAM_STEPS.lead, kind: "event", payload: said(message(lead, "lead", "", "streaming", TEAM_STEPS.lead)) },
      { ms: TEAM_STEPS.said, kind: "event", payload: said(message(lead, "lead", reply, "final", TEAM_STEPS.said)) },
      { ms: TEAM_STEPS.said + 100, kind: "event", payload: waiting(false) },
    ],
  });
  // Reads after the newest message, as the app makes once one lands: nothing more.
  const state = { projectRef: { ...projectRef }, needsYou: false, leadWorking: false, lastSeq: lead, lastMessageAt: f.now };
  for (let after = 0; after <= lead; after++) f.answer("chat_history", { projectRef: { ...projectRef }, after }, { messages: [], moreBefore: after > 0, moreAfter: false, state });
};
