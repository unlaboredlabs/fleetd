// The showcase's scenes past the storefront's request (qa/showcase.spec.ts moves through them as the batch merges),
// each made of another group's fixture rather than data of its own: Try it on #230 (fixtures/tryit), Navi with Ada and
// Home above the projects, Ada woken by Gmail with a reply to approve that attaches two files and the order it asked
// storefront for (fixtures/navi), and a second hub, Personal, beside this one in the sidebar (fixtures/sidebar).
// Administration's people and invites are admin-owner's (fixtures/admin); the nightly memory refresh's line is in
// storefront's chat (index.ts), and its built-in row on the Automations page comes with every fixture (fixtures/settings).
import type { Fixture } from "../kit/fixture.ts";
import { writeChat, type Ref } from "../kit/chat.ts";
import { isObject, type JsonObject } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";
import { navi, sendApproval } from "../navi/index.ts";
import { ADA, HOME } from "../navi/ids.ts";
import { retitle } from "../sidebar/index.ts";
import { answerPreviews, frame as previewFrame, ready } from "../tryit/index.ts";

/** Ada's send: the request the card answers. */
export const ADA_REQUEST = "Q71";
/** How long after Send it Ada says it sent. */
const SENT_MS = 600;

const LEASE = {
  to: ["Marta Klein <marta@example.com>"],
  subject: "Re: Lease renewal: two forms by Friday",
  body: "Hi Marta,\n\nHere are both forms for the renewal: the signed tenant form and my October payslip.\n\nBest,\nSam",
  attachments: [
    { name: "tenant-form-signed.pdf", mime: "application/pdf", bytes: 184_320, from: "from Drive" },
    { name: "payslip-2026-10.pdf", mime: "application/pdf", bytes: 92_160, from: "from Drive" },
  ],
};

/**
 * Ada and Home above the projects. Ada asked storefront for W18 earlier; Marta's mail woke it just now, and its reply
 * waits on you with both files listed. Send it answers, and Ada says so.
 */
export const naviScene = (f: Fixture, storefront: Ref): void => {
  if (f.snapshot === undefined) throw new Error("the showcase needs a snapshot");
  f.snapshot["projects"] = [...arr(f.snapshot["projects"]), navi(f, ADA, "Ada", "ada"), navi(f, HOME, "Home", "home")];
  if (f.state.phase === "live") f.state = { ...f.state, features: [...(f.state.features ?? []), "navi_asks"] };
  const item = { ...sendApproval(ADA, "ada", LEASE), requestId: ADA_REQUEST };
  const messages = writeChat(
    f,
    ADA,
    [
      { author: "human", text: "Ask the storefront lead to apply gift cards before tax; customers keep asking.", minutesAgo: 52 },
      { author: "lead", text: "Asked storefront’s lead (N3). It opened order W18, *Gift cards apply before tax*, and two writers are on it. I’ll tell you when it lands.", minutesAgo: 51 },
      { author: "human", text: "Marta sends the lease renewal today. When it comes, fill in the forms and draft the reply.", minutesAgo: 30 },
      { author: "lead", text: "New mail from Marta Klein, “Lease renewal: two forms by Friday”. I filled in the tenant form, found your October payslip in Drive and drafted the reply with both attached. It goes out once you approve it.", minutesAgo: 1 },
      { author: "lead", text: "", item, minutesAgo: 1 },
    ],
    { needsYou: true },
  );
  // Its request, open until Send it answers it.
  const request = { requestId: ADA_REQUEST, projectRef: { ...ADA }, kind: "approval", text: `Send an email to ${LEASE.to.join(", ")}`, createdAt: new Date(Date.parse(f.now) - 60_000).toISOString() };
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
    text: "Sent to Marta, with both forms attached. I’ll put Friday’s viewing in your calendar.",
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

/** #230 ready to try on the web, started a few minutes ago: its page in Dutch, which the person flips to German. */
export const tryItScene = (f: Fixture, repo: string, n: number): { first: JsonObject; flipped: JsonObject } => {
  answerPreviews(f, [{ ...ready(f, 6 * 60_000), of: { kind: "pr", repo, number: n }, head: "e41c7a2" }], { canStart: true });
  return { first: previewFrame(1, "nl"), flipped: previewFrame(2, "de") };
};

/** A second hub beside this one, as sidebar-hubs has it: Personal's projects, this one Acme's. */
export const hubsScene = (f: Fixture, other: Fixture): void => {
  retitle(other, { storefront: "blog", billing: "garden-sensors", checkout: "recipes" });
  other.state = { phase: "live", hub: "https://hub.home.example", protocol: f.state.phase === "live" ? f.state.protocol : 1 };
  f.label = "Acme";
  f.color = "amber";
  f.hubs = [{ label: "Personal", color: "green", fixture: other }];
};
