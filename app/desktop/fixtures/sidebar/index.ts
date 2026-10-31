// The sidebar's reasons (status-rows' eight projects): a lead waiting on a reply, two commands to approve, a secret
// to enter, Status's blocked projects, agents at work, and a reply that arrives after the app opened (docs), which
// shows bold until you look.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { isObject, type JsonObject, type JsonValue } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";

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

export default defineGroup({
  fixtures: (base) => [reasons(base("status-rows")), hubs(base, false), hubs(base, true)],
});
