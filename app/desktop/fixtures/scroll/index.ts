// A busy bot's chat to scroll through (W733): a long history with pictures, image blocks, code and lists, its older
// pages answering after 300 ms as a hub over the network does, and, while the reader scrolls, new messages (pictures
// and blocks among them), edits to messages already shown and the agents' quiet lines arriving, and the hub
// restarting. perf/scroll.ts records where the view stands on every frame and fails on any move the wheel didn't make.
import fs from "node:fs";
import { firstProject, writeChat, type Draft, type Ref } from "../kit/chat.ts";
import { longChat } from "../kit/chatText.ts";
import { Fixture, HUB, PROTOCOL } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import { arr, obj } from "../kit/stress.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";

const shot = (name: string) => fs.readFileSync(new URL(`../sessions/media/${name}.jpg`, import.meta.url));
// Landscape, as most screenshots are: a portrait picture in an image block lets its caption's line run out sideways (a
// finding of its own, not this fixture's point).
const SHOTS = ["checkout", "shopApp", "macDesktop", "linuxDesktop", "product", "payDashboard"] as const;

/** How many messages the chat holds before anything arrives. */
const HISTORY = 600;
/** When messages start arriving, ms after the window subscribes, and how far apart. */
export const ARRIVE_FROM_MS = 2_500;
const ARRIVE_EVERY_MS = 600;
const ARRIVALS = 50;
/** When the hub restarts in scroll-busy, and for how long it is gone. */
export const RESTART_AT_MS = 30_000;
const RESTART_DOWN_MS = 1_500;
/** scroll-drop's: once QA has opened the chat and scrolled up (settled at SETTLE_MS), long enough to see. */
const SETTLE_MS = 3_000;
const DROP_AT_MS = 9_000;
const DROP_DOWN_MS = 3_000;
/** An older page's answer time. */
const OLDER_MS = 300;

/** The long diff's lines: more than a diff block shows before "Show all". */
const FOLD_LINES = 120;

const block = (id: string, caption: string) => ({ v: 1, kind: "image", attachmentId: id, caption });

/** The history: chat-long's lines, every 9th lead message with a picture and every 13th with an image block. */
const drafts = (): { drafts: Draft[]; blocks: { id: string; name: string }[] } => {
  const blocks: { id: string; name: string }[] = [];
  let lead = 0;
  const out = longChat(HISTORY).map((l, i): Draft => {
    if (l.from === "you") return { author: "human", text: l.text };
    lead++;
    const name = SHOTS[i % SHOTS.length] ?? "checkout";
    if (lead % 9 === 0) return { author: "lead", text: l.text, attachments: [{ name: `${name}.jpg`, mime: "image/jpeg", data: shot(name) }] };
    if (lead % 13 === 0) {
      const id = `F${String(500 + blocks.length + 1)}`;
      blocks.push({ id, name });
      const intro = l.text;
      const b = block(id, `The ${name} screen after the change`);
      const text = `${intro}\n\n\`\`\`fleetd-block\n${JSON.stringify(b)}\n\`\`\``;
      return { author: "lead", text, parts: [{ start: 0, end: intro.length }, { start: intro.length + 2, end: text.length, block: b }] };
    }
    if (lead % 17 === 0) return { author: "system", text: `Agent T${String(4000 + i)} opened a PR for ${l.text.slice(0, 30)}…` };
    return { author: "lead", text: l.text };
  });
  // A long diff a dozen messages from the end, its first lines shown and the rest one press away (QA's chat~fold).
  const intro = "The whole change, for the record:";
  const diff = { v: 1, kind: "diff", title: "Totals", files: [{ path: "src/receipt/totals.ts", hunks: [`@@ -0,0 +1,${String(FOLD_LINES)} @@\n${Array.from({ length: FOLD_LINES }, (_, i) => `+const line${String(i + 1)} = ${String(i + 1)};`).join("\n")}`] }] };
  const text = `${intro}\n\n\`\`\`fleetd-block\n${JSON.stringify(diff)}\n\`\`\``;
  out.splice(out.length - 12, 0, { author: "lead", text, parts: [{ start: 0, end: intro.length }, { start: intro.length + 2, end: text.length, block: diff }] });
  return { drafts: out, blocks };
};

const answerPicture = (f: Fixture, ref: Ref, id: string, name: string) => {
  const data = shot(name);
  f.answer("attachment_get", { projectRef: { ...ref }, attachmentId: id }, { attachmentId: id, name: `${name}.jpg`, mime: "image/jpeg", bytes: data.length, dataB64: data.toString("base64") });
};

const lastEvent = (f: Fixture): number =>
  Math.max(
    Number(f.snapshot?.["cursor"] ?? 0),
    ...f.events.map((e) => Number(e["seq"] ?? 0)),
    ...f.timeline.filter((t) => t.kind === "event").map((t) => Number(t.payload["seq"] ?? 0)),
  );

/** The newest page's answer, which messages that arrive join (hidden until they do), so a read after a restart has them. */
const latestPage = (f: Fixture, ref: Ref): JsonObject => obj(f.output("chat_history", { projectRef: { ...ref } }));

const busy = (base: Fixture, name: string, note: string, opts: { arrive: boolean; restart?: { at: number; down: number } }): Fixture => {
  const f = Fixture.from(base, name, note);
  const ref = firstProject(f);
  const projectRef = { ...ref };
  const { drafts: history, blocks } = drafts();
  writeChat(f, ref, history);
  for (const b of blocks) answerPicture(f, ref, b.id, b.name);
  // Older pages take a moment, as over the network.
  for (const a of f.answers("chat_history")) if (a.input?.["before"] !== undefined) f.answer("chat_history", a.input, a.output, OLDER_MS);
  const page = latestPage(f, ref);
  const shown = arr(page["messages"]).filter(isObject);
  const last = Number(shown.at(-1)?.["seq"] ?? HISTORY);
  let event = lastEvent(f) + 1;
  const chatEvent = (ms: number, message: JsonObject) =>
    f.later(ms, "event", {
      seq: event++,
      at: at(f.now, ms),
      type: "chat.message",
      summary: "The lead in the chat",
      machineId: ref.machineId,
      projectId: ref.projectId,
      data: { projectRef, messageId: asText(message["messageId"]), seq: Number(message["seq"]), author: asText(message["author"]), state: asText(message["state"]), message },
    });
  if (opts.arrive) {
    let file = 1000;
    for (let i = 0; i < ARRIVALS; i++) {
      const ms = ARRIVE_FROM_MS + i * ARRIVE_EVERY_MS;
      const seq = last + 1 + i;
      const messageId = `m${String(seq)}`;
      const kind = i % 6;
      const pic = SHOTS[i % SHOTS.length] ?? "checkout";
      let message: JsonObject = { messageId, projectRef, seq, author: "lead", text: `Arrival ${String(i)}: writer pushed a fix.`, attachments: [], createdAt: at(f.now, ms), state: "final" };
      if (kind === 1) message = { ...message, author: "human", text: `how is arrival ${String(i)} going?`, delivery: "turn", by: "laptop" };
      if (kind === 2) message = { ...message, text: `Review on arrival ${String(i)}:\n\n\`\`\`ts\nexport const total = (lines: number[]) =>\n  lines.reduce((a, b) => a + b, 0);\n\`\`\`\n\n- tests first\n- then the change` };
      if (kind === 3) {
        const id = `F${String(++file)}`;
        answerPicture(f, ref, id, pic);
        message = { ...message, text: `The ${pic} screen now:`, attachments: [{ attachmentId: id, name: `${pic}.jpg`, mime: "image/jpeg", bytes: shot(pic).length }] };
      }
      if (kind === 4) {
        const id = `F${String(++file)}`;
        answerPicture(f, ref, id, pic);
        const intro = `The ${pic} screen after arrival ${String(i)}.`;
        const b = block(id, `The ${pic} screen`);
        const text = `${intro}\n\n\`\`\`fleetd-block\n${JSON.stringify(b)}\n\`\`\``;
        message = { ...message, text, parts: [{ start: 0, end: intro.length }, { start: intro.length + 2, end: text.length, block: b }] };
      }
      if (kind === 5) message = { ...message, author: "system", text: `Agent T${String(5000 + i)} finished: PR opened.` };
      arr(page["messages"]).push(message);
      f.hidden.push({ tool: "chat_history", field: "messages", where: { messageId } });
      f.later(ms - 1, "rows", { hide: [], show: [{ tool: "chat_history", field: "messages", where: { messageId } }] });
      chatEvent(ms, message);
      // Every other arrival, a message already shown is edited longer: one in the newest page, read or not.
      if (i % 2 === 0) {
        const old = shown[(i * 7) % shown.length];
        if (old !== undefined) {
          const text = `${asText(old["text"])}\n\nEdited: one more line after the review, long enough to wrap onto a second line at the window's width.`;
          old["text"] = text;
          chatEvent(ms + 200, { ...old, text, updatedAt: at(f.now, ms + 200) });
        }
      }
    }
  }
  if (opts.restart !== undefined) {
    // The link drops (not a planned restart, which says nothing for its first 30 s) and comes back unable to resume.
    const { at: from, down } = opts.restart;
    f.later(from, "state", { phase: "retrying", hub: HUB, reason: "The workspace closed the connection", retryAt: Date.parse(at(f.now, from + down)) });
    f.later(from + down - 200, "state", { phase: "connecting", hub: HUB, attempt: 1 });
    f.later(from + down, "state", { phase: "live", hub: HUB, protocol: PROTOCOL });
    f.later(from + down, "snapshot", { ...f.snapshot, cursor: event++ });
  }
  f.settleAt(SETTLE_MS);
  return f;
};

export default defineGroup({
  fixtures: (base) => [
    busy(base("chat-long"), "scroll-busy", "A busy bot's long chat: pictures, image blocks and code in its history, older pages answering after 300 ms; new messages, edits and agents' lines arrive, and the workspace restarts at 30 s.", { arrive: true, restart: { at: RESTART_AT_MS, down: RESTART_DOWN_MS } }),
    busy(base("chat-long"), "scroll-still", "The busy chat's history alone: pictures, image blocks and code, older pages answering after 300 ms, nothing arriving.", { arrive: false }),
    busy(base("chat-long"), "scroll-drop", "The busy chat's history; the link drops 9 s in and comes back 3 s later unable to resume, every read made again.", { arrive: false, restart: { at: DROP_AT_MS, down: DROP_DOWN_MS } }),
  ],
});
