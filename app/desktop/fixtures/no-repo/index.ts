// Projects with no repo in the app: a chat with a lead in a folder. no-repo-chats: Ada and Home beside the projects, and
// Taxes archived; Ada asks to book a table through its MCP server (the approval card, with its preview), has asked
// storefront and billing for work (Asked work, project_asks) and keeps skills it learned (Skills, with weekly-invoices' history). no-repo-links: Ada's Linked hubs and Sam's links to this
// hub (hubLinks/); no-repo-links-none: neither yet. no-repo-files: files both ways in Home's chat: the person sends a
// lease (.docx) and a bank export (.csv), and Home sends back the trip as a PDF and the receipts as a CSV, each a card
// that opens or saves. no-repo-pictures: pictures both ways there: the person sends two screenshots side by side, and
// Home answers with a picture of its own, each with a download button and Save image… and Copy image on right-click.
import fs from "node:fs";
import { writeChat, type Ref } from "../kit/chat.ts";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at, uuid } from "../kit/ids.ts";
import { ADA, HOME, TAXES } from "./ids.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";
import { PROJECT_TOOLS } from "../../src/renderer/screens/projects/model.ts";
import { projectSections, yourDevices } from "../kit/sections.ts";


const CREATOR = { keyId: "k-laptop", name: "laptop" };

/** A project with no repo, as the snapshot lists it beside the others (the showcase's too). */
export const ownProject = (f: Fixture, ref: Ref, title: string, folder: string, archivedAgoMs?: number): JsonObject => ({
  machineId: ref.machineId,
  projectId: ref.projectId,
  title,
  workspaceRoot: `/home/dev/projects/${folder}`,
  lastActivityAt: at(f.now, -600_000),
  threads: { failed: 0, idle: 1, running: 0, waiting: 0 },
  createdBy: CREATOR,
  ...(archivedAgoMs === undefined ? {} : { archivedAt: at(f.now, -archivedAgoMs) }),
});

/** A project of the snapshot by title, as a ref. */
const refOf = (f: Fixture, title: string): Ref => {
  const p = arr(f.snapshot?.["projects"]).filter(isObject).find((x) => x["title"] === title);
  if (p === undefined) throw new Error(`no project ${title}`);
  return { machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) };
};

/** A call a lead makes through one of its MCP servers: the server, the tool, what it says it does, and its input. */
export interface ToolCall {
  readonly server: string;
  readonly tool: string;
  readonly action: "send" | "write";
  readonly summary: string;
  readonly input: JsonObject;
}

const BOOKING: ToolCall = {
  server: "tables",
  tool: "book_table",
  action: "write",
  summary: "Book a table for two on Tuesday at 12:30",
  input: { restaurant: "Casa Lina", date: "2026-11-03", time: "12:30", people: 2, name: "Sam" },
};

/**
 * A lead's ask through one of its MCP servers, as the hub files it: the tool's input, and the card the integrations
 * policy makes of it. Ada's table for lunch here; the showcase's lease renewal.
 */
export const toolApproval = (project: Ref, name: string, call: ToolCall = BOOKING): JsonObject => ({
  kind: "command_approval",
  machineId: project.machineId,
  state: "open",
  permission: {
    requestId: `perm-${name}-1`,
    threadId: uuid(`inbox ${name} thread`),
    toolName: `mcp__${call.server}__${call.tool}`,
    summary: call.summary,
    input: call.input,
    preview: {
      server: call.server,
      tool: call.tool,
      action: call.action,
      title: `Use ${call.tool} on ${call.server}`,
      input: JSON.stringify(call.input, null, 2),
    },
  },
});

const two = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "no-repo-chats", "No repo: Ada and Home beside the projects, Taxes archived; Ada asks to book a table and follows work it asked for.");
  if (f.snapshot === undefined) throw new Error("no-repo-chats needs a snapshot");
  f.snapshot["projects"] = [...arr(f.snapshot["projects"]), ownProject(f, ADA, "Ada", "ada"), ownProject(f, HOME, "Home", "home"), ownProject(f, TAXES, "Taxes", "taxes", 3 * 86_400_000)];
  const storefront = refOf(f, "storefront");
  const billing = refOf(f, "billing");
  writeChat(
    f,
    ADA,
    [
      { author: "human", text: "Book lunch with Ana on Tuesday, 12:30 at the usual place." },
      { author: "lead", text: "Casa Lina has a table for two at 12:30. The booking goes in once you approve it." },
      { author: "lead", text: "", item: toolApproval(ADA, "ada") },
      { author: "human", text: "And ask the storefront lead to let people save their cart for later." },
      { author: "lead", text: "Asked storefront's lead (N3). Its lead opened order W12, *Saved carts*, and it's under way. I'll tell you when it lands." },
      {
        author: "system",
        text: `Updated the skill weekly-invoices: ${INVOICES_WHY}`,
        extra: { skillSaved: { name: "weekly-invoices", version: 3, created: false, why: INVOICES_WHY } },
      },
    ],
    { needsYou: true },
  );
  writeChat(f, HOME, [
    { author: "human", text: "Remind me to renew the car insurance before the 14th." },
    { author: "lead", text: "Done: a reminder on the 10th at 09:00." },
  ]);
  // Taxes, archived: its chat stays, and it asked nobody for anything.
  writeChat(f, TAXES, [
    { author: "human", text: "File the quarterly estimate before the 15th." },
    { author: "lead", text: "Paid on the 12th; the receipt is in my folder." },
  ]);
  f.answer(PROJECT_TOOLS.asks, { project: { ...TAXES } }, { project: { ...TAXES }, asks: [], next: "This project has asked no other project for anything yet." });
  // Ada's to-do list, its panel's Plan.
  f.answer("checklist_get", { projectRef: { ...ADA } }, {
    projectRef: { ...ADA },
    items: [
      { id: 1, text: "Lunch with Ana on Tuesday", state: "doing", updatedAt: at(f.now, -120_000) },
      { id: 2, text: "Book a table for two at 12:30", state: "todo", updatedAt: at(f.now, -120_000) },
      { id: 3, text: "Follow storefront's saved carts until it lands", state: "todo", updatedAt: at(f.now, -1_500_000) },
    ],
    updatedAt: at(f.now, -120_000),
  });
  f.answer("requests_list", { limit: 100 }, {
    requests: [{ requestId: "Q1", projectRef: { ...ADA }, kind: "approval", state: "open", text: "Book a table for two on Tuesday at 12:30", createdAt: at(f.now, -120_000) }],
  });
  // Asked work (#649).
  f.answer(PROJECT_TOOLS.asks, { project: { ...ADA } }, {
    project: { ...ADA },
    asks: [
      {
        handle: "N8",
        to: storefront,
        toTitle: "storefront",
        text: "Follow-up to my last message (the Machines setup page): please don't take my guess at the cause at face value. Check the hub's logs and the node's reported version first, and if part of my report is wrong, say so.",
        at: at(f.now, -600_000),
        // Folded into the order opened for N7.
        orders: [{ workstreamId: "W14", title: "Machines setup gives exact commands, and the update notice clears", state: "open", headline: "A writer is on the copyable commands; the stale version is next." }],
      },
      {
        handle: "N7",
        to: storefront,
        toTitle: "storefront",
        text: 'From the person, relayed by their lead (their words: "machines setup is not good ux enough. user doesnt know what to do, so make it automatic or provide commands. also it keeps saying its fleetd is too old right after i updated.") Two things on the Machines setup page in the app:\n\n1. UX: a user doesn\'t know what to do next during machine setup. Make the steps automatic where possible, and where a step needs the person, show the exact command to run (copyable), not a vague instruction.\n2. Bug: the page keeps saying "Its fleetd is too old to change these from here" right after the person updated. Verify the cause from the code and logs rather than assuming, fix the real cause, and make the message clear about what to do if it is ever genuinely stale.',
        at: at(f.now, -1_200_000),
        orders: [{ workstreamId: "W14", title: "Machines setup gives exact commands, and the update notice clears", state: "open", headline: "A writer is on the copyable commands; the stale version is next." }],
      },
      { handle: "N4", to: billing, toTitle: "billing", text: "Is the October usage report ready?", at: at(f.now, -7_200_000), orders: [] },
      {
        handle: "N3",
        to: storefront,
        toTitle: "storefront",
        text: "Let people save their cart for later and come back to it.",
        at: at(f.now, -18_000_000),
        orders: [{ workstreamId: "W12", title: "Saved carts", state: "open", headline: "A writer adds the saved-cart table; the reviewer is on the first PR." }],
      },
      {
        handle: "N2",
        to: billing,
        toTitle: "billing",
        text: "Send me last month's invoice totals by customer.",
        at: at(f.now, -86_400_000),
        orders: [{ workstreamId: "W9", title: "Invoice totals by customer", state: "done", headline: "Sent the totals as a CSV.", merged: true }],
      },
      {
        handle: "N1",
        to: storefront,
        toTitle: "storefront",
        text: "Try a dark theme for the storefront.",
        at: at(f.now, -3 * 86_400_000),
        orders: [{ workstreamId: "W5", title: "Storefront dark theme", state: "stopped" }],
      },
    ],
  });
  adaSkills(f);
  return f;
};

const INVOICES_WHY = "The supplier moved the PDF download under Billing › Documents.";

const invoices = (step: string, folder: string) =>
  `---\nname: weekly-invoices\ndescription: Download the week's supplier invoices as PDFs. Use on Mondays, or when Sam asks for invoices.\n---\n\n# Weekly invoices\n\n1. Open the supplier portal; the login is in 1Password as *Acme Supplies*.\n2. ${step}\n3. Filter to the last 7 days and download each invoice as a PDF.\n4. Save them in \`${folder}\`, named by date and number: \`2026-10-27 INV-4471.pdf\`.\n5. Tell Sam the count and the total; flag any over 500.\n`;

/** Ada's skills (skills/SkillsPane): what it learned, one of them off, one installed, and weekly-invoices' history. */
const adaSkills = (f: Fixture): void => {
  const projectRef = { ...ADA };
  const hour = 3_600_000;
  const newest = { version: 3, author: "agent", by: "Ada", at: at(f.now, -2 * hour), why: INVOICES_WHY };
  const versions = [
    newest,
    { version: 2, author: "person", by: "Sam", at: at(f.now, -26 * hour), why: "Keep them by year." },
    { version: 1, author: "agent", by: "Ada", at: at(f.now, -6 * 24 * hour), why: "Worked out where the portal keeps the invoices." },
  ];
  const texts = [
    invoices("Go to Invoices in the top menu.", "invoices/"),
    invoices("Go to Invoices in the top menu.", "invoices/2026/"),
    invoices("Go to Billing › Documents; Invoices in the top menu shows only the last one.", "invoices/2026/"),
  ];
  const summary = {
    name: "weekly-invoices",
    origin: "project",
    description: "Download the week's supplier invoices as PDFs. Use on Mondays, or when Sam asks for invoices.",
    changed: newest,
    lastUsedAt: at(f.now, -2 * hour - 120_000),
    updatedAt: at(f.now, -2 * hour),
  };
  f.answer("skills_list", { projectRef }, {
    skills: [
      summary,
      {
        name: "lunch-booking",
        origin: "project",
        description: "Book lunch at Sam's usual places: Casa Lina first, a table for two by the window.",
        changed: { version: 1, author: "agent", by: "Ada", at: at(f.now, -3 * 24 * hour), why: "Sam books the same few places." },
        lastUsedAt: at(f.now, -300_000),
      },
      {
        name: "car-insurance",
        origin: "project",
        description: "Compare the renewal quote with two others before the policy ends.",
        changed: { version: 2, author: "person", by: "Sam", at: at(f.now, -9 * 24 * hour), why: "Only the comprehensive cover." },
        off: true,
        lastUsedAt: at(f.now, -40 * 24 * hour),
      },
      {
        name: "pdf",
        origin: "project",
        description: "Fill in, merge and split PDF forms.",
        install: { source: "acme/agent-skills@pdf", url: "https://github.com/acme/agent-skills.git", ref: "HEAD", commit: "4f1c2a9e8b7d6c5f4e3a2b1c0d9e8f7a6b5c4d3e", path: "pdf", installedAt: at(f.now, -14 * 24 * hour) },
        changed: { version: 1, author: "person", by: "Sam", at: at(f.now, -14 * 24 * hour), why: "Installed from acme/agent-skills@pdf at 4f1c2a9e8b7d" },
      },
      { name: "standup", origin: "global", description: "Write the morning standup from yesterday's merges and today's orders." },
    ],
  });
  const base = { origin: "project", projectRef, name: "weekly-invoices" };
  f.answer("skill_get", base, { skill: summary, text: texts[2] ?? "", versions });
  texts.forEach((text, i) => f.answer("skill_get", { ...base, version: i + 1 }, { skill: summary, text, versions }));
};

/** Ada's settings page, as Settings › Projects reads it. */
const adaSettings = (f: Fixture): void => {
  f.answer("project_settings_get", { ...ADA }, {
    settings: { ...ADA, title: "Ada", workspaceRoot: "/home/dev/projects/ada", env: [], setup: { commands: [], inputs: [] } },
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
  const f = Fixture.from(from, "no-repo-links", "Hub links: Ada's Linked hubs (working, can't reach, revoked there), and Sam's links to this hub.");
  adaSettings(f);
  projectSections(f, ADA);
  const storefront = refOf(f, "storefront");
  f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: false, url: "https://hub.devbox.example", me: { ...SAM, role: "member", createdAt: at(f.now, -30 * 86_400_000) } });
  const kept = (label: string, url: string, extra: JsonObject): JsonObject => ({
    linkId: `hl_${label.replace(/[^a-z]/gu, "").slice(0, 4).padEnd(8, "a")}`,
    project: { ...ADA },
    label,
    url,
    createdAt: at(f.now, -5 * 86_400_000),
    checkedAt: at(f.now, -60_000),
    ...extra,
  });
  f.answer("hub_links_get", { project: { ...ADA } }, {
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
  // The page these links are on (Settings › Hubs & devices) lists Sam's devices over them.
  yourDevices(f);
  return f;
};

const linksNone = (from: Fixture): Fixture => {
  const f = Fixture.from(from, "no-repo-links-none", "Hub links: no linked hubs for Ada and no links to this hub yet.");
  for (const input of [{ project: { ...ADA } }, undefined]) f.answer("hub_links_get", input, { boxPubKey: BOX, links: [], issued: [] });
  return f;
};

/** A file block as the hub fills it in (`file`, its name, type and size), and attachment_get's answer for it. */
const madeFile = (f: Fixture, ref: Ref, attachmentId: string, name: string, mime: string, data: Buffer, caption?: string): JsonObject => {
  f.answer("attachment_get", { projectRef: { ...ref }, attachmentId }, { attachmentId, name, mime, bytes: data.length, dataB64: data.toString("base64") });
  return { v: 1, kind: "file", attachmentId, name, mime, bytes: data.length, ...(caption === undefined ? {} : { caption }) };
};

const files = (from: Fixture): Fixture => {
  const f = Fixture.from(from, "no-repo-files", "No repo: files both ways in Home's chat, a lease and a bank export in, a trip PDF and a receipts CSV out as cards.");
  const docx = { name: "lease-2027.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: Buffer.alloc(48_640, "PK") };
  const csv = { name: "bank-october.csv", mime: "text/csv", data: Buffer.from("date,description,amount\n2026-10-01,Rent,-1450.00\n".repeat(120)) };
  const blocks = [
    madeFile(f, HOME, "F11", "lisbon-itinerary.pdf", "application/pdf", Buffer.alloc(184_320, "%PDF-1.7 ")),
    madeFile(f, HOME, "F12", "receipts-october.csv", "text/csv", Buffer.from("date,merchant,amount\n2026-10-03,Casa Lina,42.50\n".repeat(60))),
  ];
  const intro = "Here's the trip, with every booking and check-in time, and October's receipts for your expenses.";
  let text = intro;
  const parts: JsonObject[] = [{ start: 0, end: intro.length }];
  for (const block of blocks) {
    text += "\n\n";
    const start = text.length;
    text += `\`\`\`fleetd-block\n${JSON.stringify(block)}\n\`\`\``;
    parts.push({ start, end: text.length, block });
  }
  writeChat(f, HOME, [
    { author: "human", text: "Here's the new lease and last month's bank export. Anything I should know?", attachments: [docx, csv], minutesAgo: 34 },
    {
      author: "lead",
      text: "Two things in the lease: rent goes up 3% in March, and notice is now 60 days, not 30. The bank export matches your budget except a €89 gym charge you said you'd cancelled.",
      minutesAgo: 33,
    },
    { author: "human", text: "Can you put the Lisbon trip together as a PDF I can keep offline? And the receipts as a spreadsheet.", minutesAgo: 6 },
    { author: "lead", text, parts, minutesAgo: 1 },
  ]);
  f.answer(PROJECT_TOOLS.asks, { project: { ...HOME } }, { project: { ...HOME }, asks: [], next: "This project has asked no other project for anything yet." });
  return f;
};

const shot = (name: string) => fs.readFileSync(new URL(`../sessions/media/${name}.jpg`, import.meta.url));

const pictures = (from: Fixture): Fixture => {
  const f = Fixture.from(from, "no-repo-pictures", "No repo: pictures both ways in Home's chat, two screenshots in and a picture out, each one saved in a click.");
  const applied = shot("checkoutApplied");
  const block = { v: 1, kind: "image", attachmentId: "F21", caption: "The checkout with the code applied" };
  const intro = "The code works on the lamp. Here's the checkout with it applied.";
  const text = `${intro}\n\n\`\`\`fleetd-block\n${JSON.stringify(block)}\n\`\`\``;
  writeChat(f, HOME, [
    {
      author: "human",
      text: "The lamp and what the shop wants at checkout. Does the autumn code still work on it?",
      attachments: [
        { name: "lamp.jpg", mime: "image/jpeg", data: shot("product") },
        { name: "checkout.jpg", mime: "image/jpeg", data: shot("checkout") },
      ],
      minutesAgo: 9,
    },
    { author: "lead", text, parts: [{ start: 0, end: intro.length }, { start: intro.length + 2, end: text.length, block }], minutesAgo: 2 },
  ]);
  // After the chat, which drops the project's earlier files as it is written.
  f.answer("attachment_get", { projectRef: { ...HOME }, attachmentId: "F21" }, { attachmentId: "F21", name: "checkout-with-code.jpg", mime: "image/jpeg", bytes: applied.length, dataB64: applied.toString("base64") });
  f.answer(PROJECT_TOOLS.asks, { project: { ...HOME } }, { project: { ...HOME }, asks: [], next: "This project has asked no other project for anything yet." });
  return f;
};

export default defineGroup({
  fixtures: (base) => {
    const made = two(base("chat-waiting"));
    const linked = links(made);
    return [made, linked, linksNone(linked), files(made), pictures(made)];
  },
});

