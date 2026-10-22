// The sidebar's reasons (status-rows' eight projects): a lead waiting on a reply, two commands to approve, a secret
// to enter, Status's blocked projects, agents at work, and a reply that arrives after the app opened (docs), which
// shows bold until you look.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { isObject, type JsonObject } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";

const reasons = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "sidebar-reasons", "Sidebar: reply, approve · 2, secret, blocked, working, and a new reply in docs.");
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

export default defineGroup({
  fixtures: (base) => [reasons(base("status-rows"))],
});
