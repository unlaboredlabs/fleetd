// Navi in the app (screens/navi). navi-none: a hub with projects and no Navi yet (the sidebar's Meet Navi, and
// #/navi's first run). navi-two: two Navis, Ada and Home, pinned above the projects, and Taxes archived; Ada asks to
// send an email (the approval card, with its preview) and has asked storefront and billing for work (Asked work,
// navi_asks). navi-old-hub: the same on a hub that doesn't serve
// Asked work to the app yet.
import { writeChat, type Ref } from "../kit/chat.ts";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at, uuid } from "../kit/ids.ts";
import { ADA, HOME, TAXES } from "./ids.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";


const CREATOR = { keyId: "k-laptop", name: "laptop" };

const navi = (f: Fixture, ref: Ref, title: string, folder: string, archivedAgoMs?: number): JsonObject => ({
  machineId: ref.machineId,
  projectId: ref.projectId,
  title,
  workspaceRoot: `/home/dev/.fleetd/navi/${folder}`,
  lastActivityAt: at(f.now, -600_000),
  threads: { failed: 0, idle: 1, running: 0, waiting: 0 },
  kind: "assistant",
  createdBy: CREATOR,
  ...(archivedAgoMs === undefined ? {} : { archivedAt: at(f.now, -archivedAgoMs) }),
});

/** A project of the snapshot by title, as a ref. */
const refOf = (f: Fixture, title: string): Ref => {
  const p = arr(f.snapshot?.["projects"]).filter(isObject).find((x) => x["title"] === title);
  if (p === undefined) throw new Error(`no project ${title}`);
  return { machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) };
};

const BODY = "Hi Ana,\n\nTuesday at 12:30 works for me. Shall we meet at the usual place? I'll book a table for two.\n\nSee you then,\nSam";

const EMAIL = {
  to: ["Ana Ruiz <ana@example.com>"],
  cc: ["bo@example.com"],
  subject: "Re: Lunch on Tuesday",
  body: BODY,
};

/** Ada's send, as the hub files it: the tool's input, and the preview the integrations policy reads from it. */
const approval = (): JsonObject => ({
  kind: "command_approval",
  machineId: ADA.machineId,
  state: "open",
  permission: {
    requestId: "perm-ada-1",
    threadId: uuid("navi ada thread"),
    toolName: "mcp__google__send_message",
    summary: `Send an email to ${EMAIL.to.join(", ")}, cc ${EMAIL.cc.join(", ")}: “${EMAIL.subject}”`,
    input: { account: "sam@example.com", ...EMAIL },
    preview: {
      integration: "google",
      server: "google",
      tool: "send_message",
      action: "send",
      title: "Send an email",
      account: "sam@example.com",
      ...EMAIL,
      input: JSON.stringify({ account: "sam@example.com", ...EMAIL }, null, 2),
    },
  },
});

const two = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "navi-two", "Navi: Ada and Home above the projects, Taxes archived; Ada asks to send an email and follows work it asked for.");
  if (f.snapshot === undefined) throw new Error("navi-two needs a snapshot");
  f.snapshot["projects"] = [...arr(f.snapshot["projects"]), navi(f, ADA, "Ada", "ada"), navi(f, HOME, "Home", "home"), navi(f, TAXES, "Taxes", "taxes", 3 * 86_400_000)];
  const storefront = refOf(f, "storefront");
  const billing = refOf(f, "billing");
  writeChat(
    f,
    ADA,
    [
      { author: "human", text: "Ana asked about lunch on Tuesday. Say yes, 12:30 at the usual place." },
      { author: "lead", text: "Tuesday 12:30 is free on your calendar. Here's the reply; it goes out once you approve it." },
      { author: "lead", text: "", item: approval() },
      { author: "human", text: "And ask the storefront lead to let people save their cart for later." },
      { author: "lead", text: "Asked storefront's lead (N3). Its lead opened order W12, *Saved carts*, and it's under way. I'll tell you when it lands." },
    ],
    { needsYou: true },
  );
  writeChat(f, HOME, [
    { author: "human", text: "Remind me to renew the car insurance before the 14th." },
    { author: "lead", text: "Done: a reminder on the 10th at 09:00, and I'll check the renewal email when it comes." },
  ]);
  // Ada's to-do list, its panel's Plan.
  f.answer("checklist_get", { projectRef: { ...ADA } }, {
    projectRef: { ...ADA },
    items: [
      { id: 1, text: "Reply to Ana about Tuesday's lunch", state: "doing", updatedAt: at(f.now, -120_000) },
      { id: 2, text: "Book a table for two at 12:30", state: "todo", updatedAt: at(f.now, -120_000) },
      { id: 3, text: "Follow storefront's saved carts until it lands", state: "todo", updatedAt: at(f.now, -1_500_000) },
    ],
    updatedAt: at(f.now, -120_000),
  });
  f.answer("requests_list", { limit: 100 }, {
    requests: [{ requestId: "Q1", projectRef: { ...ADA }, kind: "approval", state: "open", text: "Send an email to Ana Ruiz <ana@example.com>", createdAt: at(f.now, -120_000) }],
  });
  // Asked work: the hub serves navi_asks to the app (#649).
  if (f.state.phase === "live") f.state = { ...f.state, features: [...(f.state.features ?? []), "navi_asks"] };
  f.answer("navi_asks", { navi: { ...ADA } }, {
    navi: { ...ADA },
    asks: [
      { handle: "N4", to: billing, toTitle: "billing", text: "Is the October usage report ready?", at: at(f.now, -300_000), orders: [] },
      {
        handle: "N3",
        to: storefront,
        toTitle: "storefront",
        text: "Let people save their cart for later and come back to it.",
        at: at(f.now, -1_500_000),
        orders: [{ workstreamId: "W12", title: "Saved carts", state: "open", headline: "A writer adds the saved-cart table; the reviewer is on the first PR." }],
      },
      {
        handle: "N2",
        to: billing,
        toTitle: "billing",
        text: "Send me last month's invoice totals by customer.",
        at: at(f.now, -86_400_000),
        orders: [{ workstreamId: "W9", title: "Invoice totals by customer", state: "done", headline: "Sent the totals as a CSV." }],
      },
    ],
  });
  return f;
};

const oldHub = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "navi-old-hub", "Navi: navi-two on a hub that doesn't share a Navi's asks with the app yet.");
  if (f.state.phase === "live") f.state = { ...f.state, features: (f.state.features ?? []).filter((x) => x !== "navi_asks") };
  f.drop("navi_asks", { navi: { ...ADA } });
  return f;
};

const none = (base: Fixture): Fixture => Fixture.from(base, "navi-none", "Navi: projects and no Navi yet, so the sidebar offers to meet it and #/navi is its first run.");

export default defineGroup({
  fixtures: (base) => {
    const made = two(base("chat-waiting"));
    return [none(base("chat-waiting")), made, oldHub(made)];
  },
});

