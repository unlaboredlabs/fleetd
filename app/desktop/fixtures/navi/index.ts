// Navi in the app (screens/navi). navi-none: a hub with projects and no Navi yet (the sidebar's Meet Navi, and
// #/navi's first run). navi-two: two Navis, Ada and Home, pinned above the projects, and Taxes archived; Ada asks to
// send an email (the approval card, with its preview) and has asked storefront and billing for work (Asked work,
// navi_asks). navi-old-hub: the same on a hub that doesn't serve
// Asked work to the app yet. navi-links: Ada's Linked hubs and Sam's links to this hub (hubLinks/); navi-links-none:
// neither yet. navi-google-*: Google on Ada's Integrations, one fixture a state (google/NaviGoogle.tsx).
import { writeChat, type Ref } from "../kit/chat.ts";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at, uuid } from "../kit/ids.ts";
import { ADA, HOME, TAXES } from "./ids.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";


const CREATOR = { keyId: "k-laptop", name: "laptop" };

/** A Navi as the snapshot lists it beside the projects (the showcase's too). */
export const navi = (f: Fixture, ref: Ref, title: string, folder: string, archivedAgoMs?: number): JsonObject => ({
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

/** An email a Navi sends: who to, its subject and body, and the files it attaches. */
export interface Email {
  readonly to: string[];
  readonly cc?: string[];
  readonly subject: string;
  readonly body: string;
  readonly attachments?: JsonObject[];
}

/**
 * A Navi's send, as the hub files it: the tool's input, and the preview the integrations policy reads from it. Ada's
 * reply to Ana here; the showcase's reply with two files attached.
 */
export const sendApproval = (navi: Ref, name: string, email: Email = EMAIL, account = "sam@example.com"): JsonObject => {
  const { attachments, ...mail } = email;
  const input = { account, ...mail, ...(attachments === undefined ? {} : { attachments: attachments.map((a) => a["name"] ?? "") }) };
  const cc = mail.cc === undefined ? "" : `, cc ${mail.cc.join(", ")}`;
  return {
    kind: "command_approval",
    machineId: navi.machineId,
    state: "open",
    permission: {
      requestId: `perm-${name}-1`,
      threadId: uuid(`navi ${name} thread`),
      toolName: "mcp__google__send_message",
      summary: `Send an email to ${mail.to.join(", ")}${cc}: “${mail.subject}”`,
      input,
      preview: {
        integration: "google",
        server: "google",
        tool: "send_message",
        action: "send",
        title: "Send an email",
        account,
        ...mail,
        ...(attachments === undefined ? {} : { attachments: attachments.map((a) => ({ ...a })) }),
        input: JSON.stringify(input, null, 2),
      },
    },
  };
};

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
      { author: "lead", text: "", item: sendApproval(ADA, "ada") },
      { author: "human", text: "And ask the storefront lead to let people save their cart for later." },
      { author: "lead", text: "Asked storefront's lead (N3). Its lead opened order W12, *Saved carts*, and it's under way. I'll tell you when it lands." },
    ],
    { needsYou: true },
  );
  writeChat(f, HOME, [
    { author: "human", text: "Remind me to renew the car insurance before the 14th." },
    { author: "lead", text: "Done: a reminder on the 10th at 09:00, and I'll check the renewal email when it comes." },
  ]);
  // Taxes, archived: its chat stays, and it asked nobody for anything.
  writeChat(f, TAXES, [
    { author: "human", text: "File the quarterly estimate before the 15th." },
    { author: "lead", text: "Paid on the 12th; the receipt is in my folder." },
  ]);
  f.answer("navi_asks", { navi: { ...TAXES } }, { navi: { ...TAXES }, asks: [], next: "This Navi has asked no other project for anything yet." });
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
  f.drop("navi_asks", { navi: { ...TAXES } });
  return f;
};

/** Ada's settings page, as Settings › Projects reads it for a Navi. */
const adaSettings = (f: Fixture): void => {
  f.answer("project_settings_get", { ...ADA }, {
    settings: { ...ADA, title: "Ada", workspaceRoot: "/home/dev/.fleetd/navi/ada", keepWorktrees: false, env: [], setup: { commands: [], timeoutSec: 600, runAnyway: false, inputs: [] } },
  });
  f.answer("mcp_servers_get", undefined, { global: [], project: [], userServers: true });
};

const BOX = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const SAM = { personId: "p_aaaaaaaa", name: "Sam" };

/**
 * Hub links (hubLinks/): Ada reaches three other hubs, acme working (as Sam, only Shop and Website), personal out of
 * reach and an old job's revoked there; and Sam has made two link keys on this hub, one limited to storefront, and
 * revoked a third. A new key Sam makes is answered too.
 */
const links = (from: Fixture): Fixture => {
  const f = Fixture.from(from, "navi-links", "Hub links: Ada's Linked hubs (working, can't reach, revoked there), and Sam's links to this hub.");
  adaSettings(f);
  const storefront = refOf(f, "storefront");
  f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: false, url: "https://hub.devbox.example", me: { ...SAM, role: "member", createdAt: at(f.now, -30 * 86_400_000) } });
  const kept = (label: string, url: string, extra: JsonObject): JsonObject => ({
    linkId: `hl_${label.replace(/[^a-z]/gu, "").slice(0, 4).padEnd(8, "a")}`,
    navi: { ...ADA },
    label,
    url,
    createdAt: at(f.now, -5 * 86_400_000),
    checkedAt: at(f.now, -60_000),
    ...extra,
  });
  f.answer("hub_links_get", { navi: { ...ADA } }, {
    boxPubKey: BOX,
    issued: [],
    links: [
      kept("acme", "https://hub.acme.example", {
        state: "ok",
        who: "Sam",
        projects: [
          { projectRef: { machineId: "build-1", projectId: "shop" }, title: "Shop" },
          { projectRef: { machineId: "build-1", projectId: "website" }, title: "Website" },
        ],
      }),
      kept("personal", "https://hub.home.example", {
        state: "unreachable",
        who: "Sam",
        error: "Can't reach personal at https://hub.home.example: connection refused.",
      }),
      kept("old job", "https://fleet.oldjob.example", { state: "revoked", who: "Sam Rivera", error: "The person who made link hl_ccfmqd4e was removed from this hub, and the link with them." }),
    ],
  });
  const issued = (linkId: string, label: string, extra: JsonObject): JsonObject => ({
    linkId,
    label,
    prefix: `flk_${linkId.slice(3, 9)}`,
    keyId: "k-laptop",
    device: "laptop",
    person: { ...SAM },
    createdAt: at(f.now, -9 * 86_400_000),
    ...extra,
  });
  f.answer("hub_links_get", undefined, {
    boxPubKey: BOX,
    links: [],
    issued: [
      issued("hl_homeaaaa", "home", { lastUsedAt: at(f.now, -25_000) }),
      issued("hl_workaaaa", "work", { projects: [storefront], createdAt: at(f.now, -2 * 86_400_000) }),
      issued("hl_tripaaaa", "travel laptop", { revokedAt: at(f.now, -86_400_000) }),
    ],
  });
  f.answer("hub_link_mint", undefined, { key: `flk_${"q7m2xk4v".repeat(6)}abcd`, link: issued("hl_newaaaaa", "home", { createdAt: f.now }) });
  return f;
};

const linksNone = (from: Fixture): Fixture => {
  const f = Fixture.from(from, "navi-links-none", "Hub links: no linked hubs for Ada and no links to this hub yet.");
  for (const input of [{ navi: { ...ADA } }, undefined]) f.answer("hub_links_get", input, { boxPubKey: BOX, links: [], issued: [] });
  return f;
};

/**
 * Google on Ada's Integrations (google/NaviGoogle.tsx), one fixture a state: no client yet as a member and as an
 * admin; ready to connect; connected (and Home without Drive); lapsed at Google; and devbox not holding the client.
 */
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
];
const GOOGLE_CLIENT = "418559210337-q8fj2v0c6m1k3s5t7u9w.apps.googleusercontent.com";
const SAM_GOOGLE = "sam@example.com";

const googleClient = (f: Fixture, machines: ReadonlyArray<string>, realtime = false): JsonObject => ({
  clientId: GOOGLE_CLIENT,
  sealedOn: machines.map((machineId) => ({ machineId, fingerprint: "9c41e0b2" })),
  updatedAt: at(f.now, -2 * 86_400_000),
  ...(realtime
    ? { pubsub: { topic: "projects/fleetd-devbox/topics/fleetd-gmail", subscription: "projects/fleetd-devbox/subscriptions/fleetd-gmail-hub", machineId: "devbox", fingerprint: "71d03a5e" } }
    : {}),
});

const googleAccount = (f: Fixture, ref: Ref, scopes: ReadonlyArray<string>, lapsed?: string, mail?: JsonObject): JsonObject => ({
  projectRef: { ...ref },
  email: SAM_GOOGLE,
  // Google names `email` as userinfo.email in what it grants.
  scopes: scopes.map((x) => (x === "email" ? "https://www.googleapis.com/auth/userinfo.email" : x)),
  connectedAt: at(f.now, -86_400_000),
  ...(lapsed === undefined ? {} : { lapsed }),
  ...(mail === undefined ? {} : { mail }),
});

const googleNavi = (
  from: Fixture,
  name: string,
  note: string,
  opts: { admin: boolean; client?: JsonObject; ada?: JsonObject; home?: JsonObject; mailMode?: "push" | "polling"; mailProblem?: string },
): Fixture => {
  const f = Fixture.from(from, name, note);
  adaSettings(f);
  if (f.snapshot !== undefined) f.snapshot["machines"] = arr(f.snapshot["machines"]).map((m) => (isObject(m) ? { ...m, boxPubKey: BOX } : m));
  const role = opts.admin ? "owner" : "member";
  f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: opts.admin, me: { ...SAM, role, createdAt: at(f.now, -30 * 86_400_000) } });
  const get = (account?: JsonObject): JsonObject => ({
    ...(opts.client === undefined ? {} : { client: opts.client }),
    ...(account === undefined ? {} : { account }),
    scopes: GOOGLE_SCOPES,
    redirect: "http://127.0.0.1",
    mailMode: opts.mailMode ?? "polling",
    ...(opts.mailProblem === undefined ? {} : { mailProblem: opts.mailProblem }),
  });
  // Answered only where Ada has an account to set it on.
  for (const rule of opts.ada === undefined ? [] : ["off", "all", "query"]) {
    f.answer("google_mail_set", { project: { ...ADA }, rule }, {
      account: { ...(opts.ada ?? {}), mail: { rule } },
      next: rule === "off" ? "New mail no longer wakes the Navi." : rule === "all" ? "Each new message in the inbox wakes the Navi." : "New mail matching the query wakes the Navi.",
    });
  }
  f.answer("google_get", { project: { ...HOME } }, get(opts.home));
  f.answer("google_get", { project: { ...ADA } }, get(opts.ada));
  for (const input of [{ navi: { ...ADA } }, undefined]) f.answer("hub_links_get", input, { boxPubKey: BOX, links: [], issued: [] });
  f.answer("google_disconnect", undefined, { revoked: true, next: "Google revoked the Navi's access. It goes without its Google tools from its next start." });
  return f;
};

const google = (from: Fixture): Fixture[] => {
  const client = googleClient(from, ["devbox", "buildbox"]);
  return [
    googleNavi(from, "navi-google-none", "Google on a hub with no OAuth client yet, seen by a member: ask an admin.", { admin: false }),
    googleNavi(from, "navi-google-setup", "Google on a hub with no OAuth client yet, seen by its owner: a link to Administration › Google.", { admin: true }),
    googleNavi(from, "navi-google-ready", "The hub has a Google client; Ada isn't connected yet.", { admin: false, client }),
    googleNavi(from, "navi-google-connected", "Ada is connected to sam@example.com with every scope, and all new mail wakes it, by push; Home without Drive.", {
      admin: false,
      client: googleClient(from, ["devbox", "buildbox"], true),
      mailMode: "push",
      ada: googleAccount(from, ADA, GOOGLE_SCOPES, undefined, { rule: "all", watchExpiresMs: Date.parse(from.now) + 6 * 86_400_000 }),
      home: googleAccount(from, HOME, GOOGLE_SCOPES.filter((x) => !x.endsWith("/drive"))),
    }),
    googleNavi(from, "navi-google-mail-query", "New mail from Ana or marked important wakes Ada; the hub polls, because the subscription can't be read.", {
      admin: false,
      client: googleClient(from, ["devbox", "buildbox"], true),
      mailProblem: "Google refused the service account's key: give it the Pub/Sub Subscriber role on the subscription",
      ada: googleAccount(from, ADA, GOOGLE_SCOPES, undefined, { rule: "query", query: "from:ana@example.com OR is:important" }),
    }),
    googleNavi(from, "navi-google-mail-off", "Ada is connected and its mail doesn't wake it, on a hub without real-time mail.", {
      admin: false,
      client,
      ada: googleAccount(from, ADA, GOOGLE_SCOPES),
    }),
    googleNavi(from, "navi-google-lapsed", "Google stopped taking Ada's connection: Reconnect.", {
      admin: false,
      client,
      ada: googleAccount(from, ADA, GOOGLE_SCOPES, "Google refused the refresh: the access was revoked, or a Testing app's 7 days ran out"),
    }),
    googleNavi(from, "navi-google-not-held", "devbox was offline when the admin saved the Google client: it can't connect until it's saved again.", {
      admin: false,
      client: googleClient(from, ["buildbox"]),
    }),
  ];
};

const none = (base: Fixture): Fixture => Fixture.from(base, "navi-none", "Navi: projects and no Navi yet, so the sidebar offers to meet it and #/navi is its first run.");

export default defineGroup({
  fixtures: (base) => {
    const made = two(base("chat-waiting"));
    const linked = links(made);
    return [none(base("chat-waiting")), made, oldHub(made), linked, linksNone(linked), ...google(made)];
  },
});

