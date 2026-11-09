// The sidebar's reasons (status-rows' eight projects): a lead waiting on a reply, two commands to approve, a secret
// to enter, Status's blocked projects, agents at work, and a reply that arrives after the app opened (docs), which
// shows bold until you look. And the same projects' bots, each in a color of its own; and three of them pinned (W580):
// a name too long for its place, one that waits on you, one with a new reply. And your own sections of them: two
// pinned, one chat in no section, Clients and Later under their labels, alone and beside another hub's.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { asText, isObject, type JsonObject, type JsonValue } from "../kit/json.ts";
import { projectSections } from "../kit/sections.ts";
import { arr, obj } from "../kit/stress.ts";
import { PROJECT_TOOLS } from "../../src/renderer/screens/projects/model.ts";

const reasons = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "sidebar-reasons", "Sidebar: reply, approve · 2, secret, blocked, CI red, working, and a new reply in docs.");
  const projects = arr(f.snapshot?.["projects"]).filter(isObject);
  const ref = (title: string): JsonObject => {
    const p = projects.find((x) => x["title"] === title);
    if (p === undefined) throw new Error(`status-rows has no ${title}`);
    return { machineId: p["machineId"] ?? "", projectId: p["projectId"] ?? "" };
  };
  const at = (ago: number) => new Date(Date.parse(f.now) - ago).toISOString();
  const request = (id: string, title: string, kind: "secret" | "approval", text: string): JsonObject => ({
    requestId: id,
    projectRef: ref(title),
    kind,
    state: "open",
    text,
    createdAt: at(120_000),
    ...(kind === "secret" ? { secret: { key: "appstore.connect-key", sink: "env:devbox:/srv/mobile/.env" } } : {}),
  });
  f.answer("requests_list", { limit: 100 }, {
    requests: [
      request("Q1", "inventory", "approval", "Install the barcode scanner package"),
      request("Q2", "inventory", "approval", "Run the stock migration on staging"),
      request("Q3", "mobile", "secret", "The App Store Connect key, to upload the build"),
    ],
  });
  // The chat states agree: a lead with an open request waits on you.
  const mobile = JSON.stringify(ref("mobile"));
  if (f.snapshot !== undefined) {
    f.snapshot["chats"] = arr(f.snapshot["chats"]).map((c) => (JSON.stringify(obj(c)["projectRef"]) === mobile ? { ...obj(c), needsYou: true } : c));
  }
  // docs' lead replies once the app is open: newer than anything seen there.
  const docs = obj(arr(f.snapshot?.["chats"]).find((c) => JSON.stringify(obj(c)["projectRef"]) === JSON.stringify(ref("docs"))));
  const seq = (typeof docs["lastSeq"] === "number" ? docs["lastSeq"] : 0) + 1;
  f.later(1500, "event", {
    seq: 100_000,
    at: at(0),
    type: "chat.message",
    summary: "The lead replied",
    machineId: ref("docs")["machineId"] ?? "",
    projectId: ref("docs")["projectId"] ?? "",
    data: { projectRef: ref("docs"), messageId: "m-docs-reply", seq, author: "lead", state: "final" },
  });
  return f;
};

/** The bots' colors (shared/bot.ts BOT_PAINT): status-rows' eight projects, one in each color, mobile in slate, the
 * default, which the hub names by no color at all. */
export const BOT_COLORED: Readonly<Record<string, string>> = {
  storefront: "sage",
  billing: "blue",
  checkout: "coral",
  docs: "mono",
  inventory: "amber",
  search: "lilac",
  "Rewrite the pricing": "teal",
};

/** `f`'s projects, each bot in its color (BOT_COLORED). */
const colored = (f: Fixture): Fixture => {
  if (f.snapshot !== undefined) {
    f.snapshot["projects"] = arr(f.snapshot["projects"]).map((p) => {
      const title = asText(obj(p)["title"]);
      const color = Object.entries(BOT_COLORED).find(([t]) => title.startsWith(t))?.[1];
      return color === undefined ? p : { ...obj(p), avatarColor: color };
    });
  }
  return f;
};

const colors = (base: Fixture): Fixture => {
  const f = colored(Fixture.from(base, "sidebar-colors", "Sidebar: each project's bot in a color of its own, mobile in slate, the default."));
  // storefront's settings, where its color is picked.
  const storefront = obj(arr(f.snapshot?.["projects"]).find((p) => obj(p)["title"] === "storefront"));
  const ref = { machineId: asText(storefront["machineId"]), projectId: asText(storefront["projectId"]) };
  f.answer("project_settings_get", ref, {
    settings: { ...ref, title: "storefront", workspaceRoot: "/home/dev/src/storefront", setup: { commands: [], timeoutSec: 600, runAnyway: false, inputs: [] }, env: [] },
  });
  f.answer(PROJECT_TOOLS.approvals, ref, { approvals: { mode: "checker", model: "claude-sonnet-5-5", effort: "medium", defaults: true }, log: [] });
  f.answer(PROJECT_TOOLS.purchases, ref, { purchases: [] });
  projectSections(f, ref);
  return f;
};

/**
 * The sidebar's reasons with three chats pinned: "Rewrite the pricing…", whose name is cut short under its picture
 * (whole in its tooltip), inventory, which waits on you, and docs, whose reply arrives once the app is open.
 */
const pins = (base: Fixture): Fixture => {
  const f = colored(Fixture.from(reasons(base), "sidebar-pins", "Sidebar: three pinned, a long name, one that waits on you and one with a new reply."));
  const ref = (title: string): JsonObject => {
    const p = arr(f.snapshot?.["projects"])
      .filter(isObject)
      .find((x) => asText(x["title"]).startsWith(title));
    if (p === undefined) throw new Error(`status-rows has no ${title}`);
    return { machineId: p["machineId"] ?? "", projectId: p["projectId"] ?? "" };
  };
  return f.answer("chat_pins_get", {}, { pins: [ref("Rewrite the pricing"), ref("inventory"), ref("docs")], set: true });
};

/** `f`'s chat by the start of its title, as the hub names it. */
const chatRef = (f: Fixture, title: string): JsonObject => {
  const p = arr(f.snapshot?.["projects"])
    .filter(isObject)
    .find((x) => asText(x["title"]).startsWith(title));
  if (p === undefined) throw new Error(`${f.name} has no ${title}`);
  return { machineId: p["machineId"] ?? "", projectId: p["projectId"] ?? "" };
};

/** `f` with these chats pinned and these sections, each a name over its chats' titles; a change to them is taken. */
const sectioned = (f: Fixture, pinned: readonly string[], sections: Readonly<Record<string, readonly string[]>>): Fixture =>
  f
    .answer("chat_pins_get", {}, { pins: pinned.map((t) => chatRef(f, t)), set: true })
    .answer("chat_sections_get", {}, { sections: Object.entries(sections).map(([name, chats], i) => ({ id: `s${String(i + 1)}`, name, chats: chats.map((t) => chatRef(f, t)) })) })
    .answer("chat_sections_set", undefined, { sections: [] });

const ACME_SECTIONS = { Clients: ["billing", "checkout", "inventory", "mobile"], Later: ["docs", "search"] } as const;

/**
 * The sidebar's reasons in your sections: storefront and billing pinned (billing is one of Clients' too, and shows
 * among the pins only), "Rewrite the pricing…" in no section, on top; Clients, then Later, where search waits on you.
 */
const sections = (base: Fixture): Fixture =>
  sectioned(colored(Fixture.from(reasons(base), "sidebar-sections", "Sidebar: your sections, Clients and Later, under two pinned and a chat in none.")), ["storefront", "billing"], ACME_SECTIONS);

/** Every project's title in `f` renamed by `titles`, wherever a row names it beside its project (the showcase's too). */
export const retitle = (f: Fixture, titles: Readonly<Record<string, string>>): void => {
  const walk = (v: JsonValue | undefined): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isObject(v)) return;
    const title = v["title"];
    if (typeof title === "string" && titles[title] !== undefined && ("projectId" in v || "projectRef" in v)) v["title"] = titles[title];
    Object.values(v).forEach(walk);
  };
  walk(f.snapshot);
  for (const c of f.calls) walk(c.output);
};

/**
 * Two hubs under the names the person gave them: Personal's few projects, then Acme's, with
 * its leads waiting on you; `offline`, Acme can't be reached and Personal works on beside it.
 */
const hubs = (base: (name: "typical" | "status-rows") => Fixture, offline: boolean): Fixture => {
  const f = Fixture.from(
    base("typical"),
    offline ? "sidebar-hubs-offline" : "sidebar-hubs",
    offline ? "Two hubs, Personal and Acme; Acme can't be reached, Personal works on." : "Two hubs, Personal and Acme, each under its name in one sidebar.",
  );
  retitle(f, { storefront: "blog", billing: "garden-sensors", checkout: "recipes" });
  f.label = "Personal";
  f.color = "green";
  const acme = reasons(base("status-rows"));
  acme.state = offline
    ? { phase: "retrying", hub: "https://hub.acme.example", reason: "The hub didn't answer: connection refused", fix: "Check you're on Acme's network or VPN.", retryAt: Date.parse(f.now) + 25_000 }
    : { phase: "live", hub: "https://hub.acme.example", protocol: f.state.phase === "live" ? f.state.protocol : 1 };
  f.hubs = [{ label: "Acme", color: "amber", fixture: acme }];
  return f;
};

/** The two hubs, each with pins and sections of its own: Personal's Home, and Acme's Clients and Later. */
const sectionHubs = (base: (name: "typical" | "status-rows") => Fixture): Fixture => {
  const f = Fixture.from(hubs(base, false), "sidebar-sections-hubs", "Two hubs, each with its own pins and sections: Personal's Home, Acme's Clients and Later.");
  sectioned(f, ["blog"], { Home: ["garden-sensors"] });
  for (const hub of f.hubs) sectioned(colored(hub.fixture), ["storefront", "billing"], ACME_SECTIONS);
  return f;
};

export default defineGroup({
  fixtures: (base) => [reasons(base("status-rows")), colors(base("status-rows")), pins(base("status-rows")), sections(base("status-rows")), hubs(base, false), hubs(base, true), sectionHubs(base)],
});
