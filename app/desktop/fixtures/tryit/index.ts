// Try it yourself (W58): storefront as the typical fixture has it, with #14 (the checkout's buttons in German and
// Dutch) written by an agent, as a hub that runs previews answers previews_list, preview_start, preview_end and
// preview_feedback, and sends preview.state as a preview moves. `tryit-fresh` starts with nothing running: #14's writer
// suggests trying it (in its overview and the chat), the lead proposes how the project runs previews (an approval
// card), and Try it plays a start through its steps to a ready page the person drives (pages.ts, media/). The others
// hold one state: starting, ready, failed, ended, and a key that may only open running previews (D162).
import fs from "node:fs";
import path from "node:path";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { firstProject, setChatState } from "../kit/chat.ts";
import { isObject, type JsonObject, type JsonValue } from "../kit/json.ts";

const REPO = "acme/storefront";
const BRANCH = "fleetd/T14-checkout-buttons-de-nl";
const HEAD = "3f2a91c";
const URL = "http://devbox:8414";
const LOCAL = "http://127.0.0.1:4173";
const PREVIEW = `P${"3f2a91c08b6d4e17".repeat(2)}`;
const SESSION = `B${"9c4e2a71d05f3b68".repeat(2)}`;
const OF = { kind: "pr", repo: REPO, number: 14 };
const WRITER = "#14’s writer";
const MEDIA = path.join(import.meta.dirname, "media");
const jpeg = (name: string) => fs.readFileSync(path.join(MEDIA, `${name}.jpg`)).toString("base64");

/** #14's row and detail, wherever they are in `v`, as an agent's PR on its fleetd branch. */
const agents14 = (v: JsonValue): JsonValue => {
  if (Array.isArray(v)) return v.map(agents14);
  if (!isObject(v)) return v;
  const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, agents14(x)]));
  if (out["number"] !== 14 || !("title" in out)) return out;
  return { ...out, branch: BRANCH, author: { role: "implementer", title: "Checkout buttons in German and Dutch", profile: "high", login: "acme-fleet" } };
};

/** How #14 starts, as devbox reports it: each step's words, what it reused or where, and how long it took. */
const STEPS: readonly JsonObject[] = [
  { words: `Check out ${BRANCH}`, detail: "the PR’s head, in a worktree of its own on devbox", state: "done", tookMs: 1_200 },
  { words: "Setup: pnpm install --frozen-lockfile", detail: "pnpm-lock.yaml hasn’t changed", state: "reused" },
  { words: "Build: pnpm build", detail: "the build cache had 212 of 230 modules", state: "done", tookMs: 41_000 },
  { words: "Start: pnpm preview --port $PORT --host 127.0.0.1", detail: "on 127.0.0.1:4173; it answered at /", state: "done", tookMs: 2_100 },
  { words: "Open to your devices", detail: URL, state: "done", tookMs: 300 },
];

/** The steps while step `at` runs: those before it as they ended, it running, the rest queued. */
const stepsAt = (at: number): JsonObject[] => STEPS.map((x, i) => (i < at ? x : { words: x["words"] ?? "", state: i === at ? "running" : "queued" }));

const BUILD_FAILED = [
  "> storefront@1.8.0 build",
  "> vite build",
  "",
  "src/checkout/PayButton.tsx:41:7 - error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
  "41       label={t(\"checkout.pay\", lang)}",
  "         ~~~~~",
  "Found 1 error in src/checkout/PayButton.tsx:41",
  " ELIFECYCLE  Command failed with exit code 2.",
].join("\n");

const iso = (f: Fixture, offsetMs: number) => new Date(Date.parse(f.now) + offsetMs).toISOString();

/** #14's preview in one of its states, as previews_list lists it. */
const previewOf = (f: Fixture, state: string, more: JsonObject = {}): JsonObject => ({
  previewId: PREVIEW,
  projectRef: firstProject(f),
  of: OF,
  target: "web",
  machineId: "devbox",
  state,
  askedBy: { words: "you" },
  head: HEAD,
  steps: STEPS.map((x) => ({ ...x })),
  startedAt: iso(f, -52_000),
  ...more,
});

const starting = (f: Fixture, at: number): JsonObject => {
  const { head: _head, ...rest } = previewOf(f, "starting", { steps: stepsAt(at), startedAt: iso(f, 0) });
  return at === 0 ? rest : { ...rest, head: HEAD };
};
/** Ready `tookMs` after it started, `startedAgoMs` before now (negative: it starts that long from now). */
const ready = (f: Fixture, startedAgoMs = 52_000, tookMs = 46_000): JsonObject =>
  previewOf(f, "ready", {
    startedAt: iso(f, -startedAgoMs),
    readyAt: iso(f, -startedAgoMs + tookMs),
    url: URL,
    sessionId: SESSION,
    idleUntil: iso(f, -startedAgoMs + tookMs + 30 * 60_000),
  });
const ended = (f: Fixture, reason: string, startedAgoMs = 52_000, tookMs = 46_000): JsonObject => ({
  ...previewOf(f, "ended", { startedAt: iso(f, -startedAgoMs), readyAt: iso(f, -startedAgoMs + tookMs), endedAt: iso(f, -startedAgoMs + tookMs + 30 * 60_000) }),
  endReason: reason,
});
const failed = (f: Fixture): JsonObject =>
  previewOf(f, "failed", {
    steps: [STEPS[0] ?? {}, STEPS[1] ?? {}, { words: "Build: pnpm build", state: "failed", tookMs: 9_400, outputTail: BUILD_FAILED }, { words: STEPS[3]?.["words"] ?? "", state: "queued" }, { words: STEPS[4]?.["words"] ?? "", state: "queued" }],
    endedAt: iso(f, -40_000),
    note: "pnpm build exited with 2.",
  });

const suggestion = (f: Fixture): JsonObject => ({
  projectRef: firstProject(f),
  of: OF,
  by: WRITER,
  why: "the checkout’s buttons read differently in German and Dutch; worth a look in both.",
  at: iso(f, -14 * 60_000),
});

/** The preview's page: the checkout in Dutch or German, as the session it shows in streams it. */
const frame = (seq: number, lang: "de" | "nl"): JsonObject => ({
  sessionId: SESSION,
  seq,
  jpegB64: jpeg(lang === "de" ? "checkoutDe" : "checkoutNl"),
  width: 960,
  height: 600,
  url: `${LOCAL}/checkout?lang=${lang}`,
  control: "human",
});

/** preview.state, as the hub sends it when the preview moves. */
const stateEvent = (f: Fixture, state: string): JsonObject => {
  const ref = firstProject(f);
  return { seq: 0, at: f.now, type: "preview.state", summary: `preview ${state}`, ...ref, data: { projectRef: ref, previewId: PREVIEW, of: OF, state } };
};

const rowsOf = (row: JsonObject) => ({ tool: "previews_list", field: "previews", where: { previewId: PREVIEW, state: row["state"] ?? "", steps: row["steps"] ?? [] } });

/** previews_list's answer, `rows` hidden until a frame shows them; and what Try it's other tools answer. */
const answerPreviews = (f: Fixture, rows: readonly JsonObject[], opts: { readonly hidden?: readonly JsonObject[]; readonly suggest?: boolean; readonly canStart?: boolean } = {}): void => {
  const projectRef = firstProject(f);
  f.answer("previews_list", { projectRef }, { previews: [...rows], suggestions: opts.suggest === true ? [suggestion(f)] : [], ...(opts.canStart === undefined ? {} : { canStart: opts.canStart }) });
  for (const r of opts.hidden ?? []) f.hidden.push(rowsOf(r));
  // Feedback: the screenshot goes up first, then the pins; the hub says where it went.
  f.answer("attachment_put", undefined, { attachmentId: "F41", bytes: 84_213, sha256: "4f1c9e2a7b3d5e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f" });
  f.answer("preview_feedback", undefined, { deliveredTo: `${WRITER}, at its next step` });
};

const base14 = (base: Fixture, name: string, note: string): Fixture => {
  const f = Fixture.from(base, name, note);
  for (const tool of ["pr_list", "pr_get"]) f.update(tool, agents14);
  f.update("pr_get", (out, input) =>
    input?.["number"] === 14 && isObject(out)
      ? { ...out, body: "The pay and back buttons read naturally in German, and checkout gets its Dutch copy.\n\n- `src/i18n/checkout.json`: de and nl strings for the checkout's three buttons." }
      : out,
  );
  return f;
};

/** End: the ready one goes, the ended one shows, and its event says so. */
const answerEnd = (f: Fixture, from: JsonObject, to: JsonObject): void => {
  f.answer("preview_end", { previewId: PREVIEW }, { preview: to });
  f.then("preview_end", { previewId: PREVIEW }, { hide: [rowsOf(from)], show: [rowsOf(to)], frames: [{ ms: 60, kind: "event", payload: stateEvent(f, "ended") }] });
};

/** The chat's two new lines: the writer's suggestion, and the lead's proposed Try it setting, still open. */
const chatLines = (f: Fixture): void => {
  const projectRef = firstProject(f);
  const out = f.output("chat_history", { projectRef });
  if (!isObject(out) || !Array.isArray(out["messages"])) throw new Error("tryit: typical has no storefront chat");
  const messages = out["messages"].filter(isObject);
  const last = messages.at(-1);
  const seq = typeof last?.["seq"] === "number" ? last["seq"] : 0;
  const s = suggestion(f);
  const config = {
    web: { setup: ["pnpm install --frozen-lockfile"], build: "pnpm build", start: "pnpm preview --port $PORT --host 127.0.0.1", ready: "/", inputs: ["pnpm-lock.yaml"] },
    idleMinutes: 30,
  };
  const why = "storefront has no Try it setting yet; this is how its README runs the shop locally.";
  const added: JsonObject[] = [
    { messageId: `m${String(seq + 1)}`, projectRef, seq: seq + 1, author: "agent", by: "T14", text: `${WRITER} suggests trying it: ${asLine(s["why"])}`, attachments: [], createdAt: iso(f, -14 * 60_000), state: "final", previewSuggestion: s },
    {
      messageId: `m${String(seq + 2)}`,
      projectRef,
      seq: seq + 2,
      author: "lead",
      text: "",
      attachments: [],
      createdAt: iso(f, -13 * 60_000),
      state: "final",
      item: { kind: "command_approval", requestId: "Q58", machineId: "devbox", state: "open", previewConfig: { config, why } },
    },
  ];
  const all = [...messages, ...added];
  const state = setChatState(f, projectRef, { needsYou: true, leadWorking: false, lastSeq: seq + 2, lastMessageAt: iso(f, -13 * 60_000) });
  f.answer("chat_history", { projectRef }, { ...out, messages: all.slice(-50), state });
  f.answer("chat_history", { projectRef, after: seq + 2 }, { messages: [], moreBefore: true, moreAfter: false, state });
  const request: JsonObject = { requestId: "Q58", projectRef, kind: "approval", text: why, state: "open", createdAt: iso(f, -13 * 60_000) };
  f.update("requests_list", (old) => (isObject(old) && Array.isArray(old["requests"]) ? { ...old, requests: [...old["requests"], request] } : { requests: [request] }));
  for (const decision of ["approve", "deny"] as const) {
    f.answer("approval_answer", { requestId: "Q58", decision }, { request: { ...request, state: decision === "approve" ? "approved" : "denied" } });
  }
};

const asLine = (v: JsonValue | undefined): string => (typeof v === "string" ? v : "");

/** Nothing running: the suggestion, the proposal, and Try it playing a start through to the page. */
const fresh = (base: Fixture): Fixture => {
  const f = base14(base, "tryit-fresh", "Try it yourself: #14's writer suggests trying it, the lead proposes the Try it setting, and Try it starts #14 on the web.");
  chatLines(f);
  const steps = [0, 1, 2, 3, 4].map((at) => starting(f, at));
  const on = ready(f, 0, 5 * 900);
  const off = ended(f, "ended", 0, 5 * 900);
  answerPreviews(f, [...steps, on, off], { hidden: [...steps, on, off], suggest: true, canStart: true });
  const input = { projectRef: firstProject(f), of: OF, target: "web" };
  f.answer("preview_start", input, { preview: steps[0] ?? {} });
  const hideSuggestion = { tool: "previews_list", field: "suggestions", where: { by: WRITER } };
  const STEP_MS = 900;
  f.then("preview_start", input, {
    hide: [hideSuggestion],
    show: [rowsOf(steps[0] ?? {})],
    frames: [
      { ms: 40, kind: "event", payload: stateEvent(f, "starting") },
      ...steps.slice(1).flatMap((row, i) => [
        { ms: (i + 1) * STEP_MS, kind: "rows" as const, payload: { hide: [rowsOf(steps[i] ?? {})], show: [rowsOf(row)] } },
        { ms: (i + 1) * STEP_MS + 20, kind: "event" as const, payload: stateEvent(f, "starting") },
      ]),
      { ms: steps.length * STEP_MS, kind: "rows", payload: { hide: [rowsOf(steps.at(-1) ?? {})], show: [rowsOf(on)] } },
      { ms: steps.length * STEP_MS + 20, kind: "event", payload: stateEvent(f, "ready") },
      { ms: steps.length * STEP_MS + 200, kind: "browser_frame", payload: frame(1, "de") },
      // The person flips the shop to Dutch.
      { ms: steps.length * STEP_MS + 4_200, kind: "browser_frame", payload: frame(2, "nl") },
    ],
  });
  answerEnd(f, on, off);
  return f;
};

/** Ready: the Dutch checkout in the frame, its address for the person's devices, feedback to send. */
const readyNow = (base: Fixture): Fixture => {
  const f = base14(base, "tryit-ready", "Try it yourself: #14 ready on the web, the Dutch checkout in the frame, its pay button wrapping.");
  const on = ready(f);
  const off = ended(f, "ended");
  answerPreviews(f, [on, off], { hidden: [off], canStart: true });
  f.later(0, "browser_frame", frame(1, "nl"));
  answerEnd(f, on, off);
  return f;
};

const held = (base: Fixture, name: string, note: string, row: (f: Fixture) => JsonObject, canStart = true): Fixture => {
  const f = base14(base, name, note);
  answerPreviews(f, [row(f)], { canStart });
  return f;
};

export default defineGroup({
  fixtures: (base) => [
    fresh(base("typical")),
    readyNow(base("typical")),
    held(base("typical"), "tryit-starting", "Try it yourself: #14 starting on devbox, at its build.", (f) => starting(f, 2)),
    held(base("typical"), "tryit-failed", "Try it yourself: #14's build failed, with the end of its output.", failed),
    held(base("typical"), "tryit-ended", "Try it yourself: #14's preview ended after no one used it for its idle time.", (f) => ended(f, "idle")),
    (() => {
      // A read key: Try it isn't offered, and nothing is running to open.
      const f = base14(base("typical"), "tryit-read", "Try it yourself from a read key: nothing running, so no Try it to press; #14's writer still suggests it.");
      answerPreviews(f, [], { suggest: true, canStart: false });
      return f;
    })(),
  ],
});
