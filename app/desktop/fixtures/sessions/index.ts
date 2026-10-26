// The Sessions fixture (W46): many-agents' storefront with browser sessions, as a hub serving them sends them
// (contracts browser.rs, app.rs): live ones (one driving, one asking you to take over, both streaming frames), and
// ended ones recorded (with a video, without one), being saved, lost and expired. Taking over and handing back answer
// as the hub does, the row changing hands. Its pages, frames and video: pages.ts, html.ts, script.ts and media/
// (media.ts).
import fs from "node:fs";
import path from "node:path";
import { Fixture, type CallThen } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { asText, isObject, type JsonObject, type JsonValue } from "../kit/json.ts";
import { SESSION } from "./ids.ts";
import { CHECKOUT_FRAMES, PAYOUTS_FRAMES, PRICING, PRICING_MS, SHARE, SHARE_MS, type Step } from "./script.ts";

/** Every lane `laneId` in `v`, changed by `change`. */
const patchLane = (v: JsonValue, laneId: string, change: Record<string, JsonValue>): JsonValue => {
  if (Array.isArray(v)) return v.map((x) => patchLane(x, laneId, change));
  if (!isObject(v)) return v;
  const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, patchLane(x, laneId, change)]));
  return out["laneId"] === laneId && "title" in out ? { ...out, ...change } : out;
};

/** The first lane `laneId` in `v`. */
const findLane = (v: JsonValue, laneId: string): JsonObject | undefined => {
  if (Array.isArray(v)) return v.map((x) => findLane(x, laneId)).find((x) => x !== undefined);
  if (!isObject(v)) return undefined;
  if (v["laneId"] === laneId && "threadRef" in v) return v;
  return Object.values(v)
    .map((x) => findLane(x, laneId))
    .find((x) => x !== undefined);
};

const ASKS = "take over its browser; the sign-in sends a code to a phone";
const REASON = "The sign-in sends a code to a phone, and I can’t read it. Enter the code, then hand back.";
const STOREFRONT = { machineId: "devbox", projectId: "dcffccea-c5a7-40a6-940d-7f70239ffa22" };
const MEDIA = path.join(import.meta.dirname, "media");
const b64 = (name: string) => fs.readFileSync(path.join(MEDIA, name)).toString("base64");
/** What browser_recording_get returns at most per call, decoded (contracts RECORDING_PART_BYTES). */
const PART = 512 * 1024;

/** A recording's JSONL files from its steps: one action per step, and the page after each step that changed it. */
const recordingOf = (steps: readonly Step[], startMs: number) => {
  const iso = (ms: number) => new Date(startMs + ms).toISOString();
  const actions = steps.map((step, i) => ({
    seq: i + 1,
    at: iso(step.at),
    offsetMs: step.at,
    tool: step.tool,
    args: step.args,
    ok: true,
    ...(step.result === undefined ? {} : { result: step.result }),
    durationMs: 400,
    ...(step.url === undefined ? {} : { url: step.url }),
    ...(step.target === undefined ? {} : { target: step.target }),
  }));
  let url = "";
  const doms = steps.flatMap((step, i) => {
    url = step.url ?? url;
    if (step.html === undefined) return [];
    const title = /<title>([^<]*)<\/title>/u.exec(step.html)?.[1] ?? "";
    return [{ seq: i + 1, offsetMs: step.at + 400, url, title, html: step.html, ...(step.target === undefined ? {} : { target: step.target }) }];
  });
  const jsonl = (rows: readonly object[]) => Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { actions: jsonl(actions), dom: jsonl(doms) };
};

/** browser_recording_get's answers for one file, a piece at a time from each offset. */
const answerFile = (f: Fixture, sessionId: string, file: string, bytes: Buffer) => {
  for (let offset = 0; offset === 0 || offset < bytes.length; offset += PART) {
    const piece = bytes.subarray(offset, offset + PART);
    f.answer("browser_recording_get", { sessionId, file, offset }, {
      sessionId,
      file,
      mime: file === "video" ? "video/webm" : "application/x-ndjson",
      offset,
      dataB64: piece.toString("base64"),
      bytes: bytes.length,
      done: offset + piece.length >= bytes.length,
    });
  }
};

const preview = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "sessions-preview", "Sessions: storefront's agents, one in a browser, one asking you to take over its browser.");
  const iso = (agoMs: number) => new Date(Date.parse(f.now) - agoMs).toISOString();
  // The hub says it serves browser sessions: the Agents section shows them (no other fixture's hub says so).
  if (f.state.phase !== "live") throw new Error("many-agents' hub isn't live");
  f.state = { ...f.state, features: ["presence", "browser_sessions"] };
  for (const tool of ["orders_board", "order_get"]) f.update(tool, (out) => patchLane(out, "T4", { status: "waiting", statusReason: ASKS }));
  // Its own work: the browser tools it called, the login filled from 1Password by reference, and why it asked.
  const thread = findLane(f.output("orders_board", {}) ?? f.answers("orders_board")[0]?.output ?? null, "T4")?.["threadRef"];
  if (!isObject(thread)) throw new Error("many-agents has no T4 with a thread");
  const action = (id: string, summary: string, ago: number): JsonObject => ({
    kind: "action",
    id,
    at: iso(ago),
    action: { at: iso(ago), kind: "tool_call", summary, status: "completed", failed: false },
  });
  const message = (id: string, role: string, text: string, ago: number): JsonObject => ({ kind: "message", id, at: iso(ago), role, text });
  f.answer(
    "agent_work",
    { machineId: asText(thread["machineId"]), threadId: asText(thread["threadId"]), limit: 40 },
    {
      steps: [
        message("b1", "user", "Download September's payouts report from the payments dashboard and check the export reads it.", 130_000),
        action("b2", "browser_start dashboard.pay.example.com/login", 100_000),
        action("b3", "browser_fill_login dashboard.pay.example.com from 1Password", 96_000),
        action("b4", "browser_click Continue", 93_000),
        message("b5", "assistant", "The sign-in sends a code to a phone, which I can't read. I've asked you to take over; I'll download the report once you hand back.", 90_000),
        action("b6", "browser_handoff the sign-in sends a code to a phone", 89_000),
      ],
      running: true,
    },
  );
  f.live.push({
    at: iso(0),
    full: false,
    lanes: [
      { laneId: "T3", status: "working", activity: { activity: { kind: "tool", name: "in a browser", detail: "staging.shop.example.com/checkout" }, since: iso(2_000) } },
      { laneId: "T4", status: "waiting" },
    ],
  });

  // The sessions, as browser_sessions lists them: newest first.
  const board = f.output("orders_board", {}) ?? f.answers("orders_board")[0]?.output ?? null;
  const threadOf = (task: string) => {
    const ref = findLane(board, task)?.["threadRef"];
    if (!isObject(ref)) throw new Error(`many-agents has no ${task} with a thread`);
    return asText(ref["threadId"]);
  };
  const now = Date.parse(f.now);
  const shareStart = now - 48 * 60_000;
  const pricingStart = now - 70 * 60_000;
  const share = recordingOf(SHARE, shareStart);
  const pricing = recordingOf(PRICING, pricingStart);
  const video = fs.readFileSync(path.join(MEDIA, "share.webm"));
  const row = (id: string, task: string, purpose: string, startedAgoMs: number, more: JsonObject): JsonObject => ({
    sessionId: id,
    projectRef: STOREFRONT,
    threadId: threadOf(task),
    taskId: task,
    purpose,
    state: "live",
    control: "agent",
    startedAt: iso(startedAgoMs),
    ...more,
  });
  const checkout = row(SESSION.checkout, "T3", "Check the order summary takes the SAVE10 code on staging", 52_000, {});
  const payouts = row(SESSION.payouts, "T4", "Download September’s payouts report for the export", 100_000, { takeoverReason: REASON, credentialsFilled: 1 });
  // How the live ones look once a person has them, and as they hand back: hidden until a takeover shows them.
  const yours = (r: JsonObject): JsonObject => {
    const { takeoverReason: _reason, ...rest } = r;
    return { ...rest, control: "human" };
  };
  const handing = (r: JsonObject): JsonObject => ({ ...yours(r), control: "handing_back" });
  const rows: JsonObject[] = [
    checkout,
    yours(checkout),
    payouts,
    yours(payouts),
    handing(payouts),
    row(SESSION.saving, "T7", "Check the receipt date reads in the shopper’s locale", 3 * 60_000, { state: "uploading", endedAt: iso(20_000) }),
    row(SESSION.share, "T5", "Reproduce the share link 404 on the live shop", now - shareStart, {
      state: "recorded",
      endedAt: new Date(shareStart + SHARE_MS).toISOString(),
      files: [
        { file: "actions", bytes: share.actions.length },
        { file: "dom", bytes: share.dom.length },
        { file: "video", bytes: video.length },
      ],
    }),
    row(SESSION.pricing, "T2", "Compare the home page copy with the PR’s wording", now - pricingStart, {
      state: "recorded",
      endedAt: new Date(pricingStart + PRICING_MS).toISOString(),
      files: [
        { file: "actions", bytes: pricing.actions.length },
        { file: "dom", bytes: pricing.dom.length },
      ],
      credentialsFilled: 1,
      note: "no video: this machine has no ffmpeg",
    }),
    row(SESSION.receipt, "T1", "Check the receipt email shows dates in the shopper’s locale", 2 * 3_600_000, {
      state: "lost",
      endedAt: iso(2 * 3_600_000 - 41_000),
      note: "the upload failed three times while the hub was unreachable",
    }),
    row(SESSION.expired, "T8", "Check the pricing page on staging after the copy change", 33 * 86_400_000, { state: "expired", endedAt: iso(33 * 86_400_000 - 95_000) }),
  ];
  f.answer("browser_sessions", { projectRef: STOREFRONT }, { sessions: rows, retention: { retentionDays: 30, maxGbPerProject: 20 } });
  const where = (r: JsonObject) => ({ tool: "browser_sessions", field: "sessions", where: { sessionId: asText(r["sessionId"]), control: asText(r["control"]) } });
  f.hidden.push(where(yours(checkout)), where(yours(payouts)), where(handing(payouts)));

  // Their recordings.
  answerFile(f, SESSION.share, "actions", share.actions);
  answerFile(f, SESSION.share, "dom", share.dom);
  answerFile(f, SESSION.share, "video", video);
  answerFile(f, SESSION.pricing, "actions", pricing.actions);
  answerFile(f, SESSION.pricing, "dom", pricing.dom);

  // The live ones' pages: checkout's agent goes on, a page every 2.2 s; payouts waits on its code.
  const frame = (sessionId: string, seq: number, image: string, url: string, control: string): JsonObject => ({
    sessionId,
    seq,
    jpegB64: b64(`${image}.jpg`),
    width: 960,
    height: 600,
    url,
    control,
  });
  const SHOP = "https://staging.shop.example.com";
  const urls: Readonly<Record<string, string>> = { home: `${SHOP}/`, signIn: `${SHOP}/account/sign-in`, signInFilled: `${SHOP}/account/sign-in`, product: `${SHOP}/products/linen-shirt`, productAdded: `${SHOP}/products/linen-shirt` };
  CHECKOUT_FRAMES.forEach((image, i) => f.later(i * 2_200, "browser_frame", frame(SESSION.checkout, i + 1, image, urls[image] ?? `${SHOP}/checkout`, "agent")));
  const PAY = "https://dashboard.pay.example.com";
  const [code, dashboard, downloaded] = PAYOUTS_FRAMES;
  f.later(0, "browser_frame", frame(SESSION.payouts, 1, code, `${PAY}/login/verify`, "agent"));
  // Shot once its first pages are in, not after the whole run.
  f.settleAt(2_500);

  // Taking over and handing back answer as the hub does: the row changes hands, its event says so, frames go on.
  const control = (sessionId: string, to: "human" | "agent", session: JsonObject, then: CallThen) => {
    const input = { sessionId, control: to };
    f.answer("browser_control", input, { session });
    f.then("browser_control", input, then);
  };
  const changed = (r: JsonObject, ms: number) => ({
    ms,
    kind: "event" as const,
    // Main numbers a call's events as it sends them.
    payload: { seq: 0, at: iso(0), type: "browser.session", summary: `browser session ${asText(r["control"])}`, ...STOREFRONT, data: { projectRef: STOREFRONT, sessionId: asText(r["sessionId"]), state: "live", control: asText(r["control"]), taskId: asText(r["taskId"]) } },
  });
  for (const r of [checkout, payouts]) {
    control(asText(r["sessionId"]), "human", yours(r), {
      hide: [where(r)],
      show: [where(yours(r))],
      frames: [changed(yours(r), 50)],
    });
  }
  control(SESSION.payouts, "agent", handing(payouts), {
    hide: [where(yours(payouts))],
    show: [where(handing(payouts))],
    frames: [
      changed(handing(payouts), 50),
      { ms: 900, kind: "browser_frame", payload: frame(SESSION.payouts, 2, dashboard, `${PAY}/payouts`, "handing_back") },
      { ms: 3_000, kind: "browser_frame", payload: frame(SESSION.payouts, 3, downloaded, `${PAY}/payouts`, "agent") },
    ],
  });
  control(SESSION.checkout, "agent", handing(checkout), {
    hide: [where(yours(checkout))],
    show: [where(checkout)],
    frames: [changed(checkout, 50)],
  });
  return f;
};

export default defineGroup({
  fixtures: (base) => [preview(base("many-agents"))],
});
