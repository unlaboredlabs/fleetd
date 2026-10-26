// The design preview's browser sessions (W46), until the hub serves them (T514 defines the contract): storefront's
// agents' sessions, live and recent, shaped like the broker's likely contract (model.ts), each step with a snapshot of
// the page it acted on. A live session plays a script, a step every couple of seconds, as the hub's stream would bring
// them; Take over, a person's clicks in the page, and Hand back change it here as the hub would. Shown only where the
// hub says it serves browser sessions (its ready frame's `browser_sessions` feature, which only the sessions-preview
// fixture claims today), and only in the QA build and in development: a real build reads none of it. QA starts a new
// session with the `fleetd:preview-session` window event.
import { useMemo, useSyncExternalStore } from "react";
import { useData } from "../../src/data/react";
import type { ProjectKey } from "../shell/routes";
import type { BrowserSession, SessionAction, SessionState } from "./model";
import * as page from "./pages";
import { snap, structure as dom } from "./pages";

export const PREVIEW = import.meta.env.VITE_FLEETD_QA === "1" || import.meta.env.DEV;

/** The hub feature that says it serves browser sessions (panel/tabs.ts gates the view on it too). */
export const FEATURE = "browser_sessions";

/** storefront, the fixtures' project (fixtures/agents/route.ts). */
const STOREFRONT = { machineId: "devbox", projectId: "dcffccea-c5a7-40a6-940d-7f70239ffa22" } as const;

/** A step still to come: the action, the page after it, and what the agent says it does meanwhile. */
interface Step {
  readonly action?: Omit<SessionAction, "at">;
  readonly image?: string;
  readonly url?: string;
  readonly now?: string;
  readonly state?: SessionState;
  readonly handoff?: string;
}

/** How long a live step takes in the preview. */
const STEP_MS = 2_200;

const agent = (laneId: string, title: string, role: BrowserSession["agent"]["role"]) => ({ laneId, title, role });
const SHOP = "https://staging.shop.example.com";
const PAY = "https://dashboard.pay.example.com";
const LIVE_SHOP = "https://shop.example.com";

const iso = (ms: number) => new Date(ms).toISOString();

/** A session made of its steps so far, each `[at, step]`. */
const played = (base: Omit<BrowserSession, "frames" | "actions">, steps: ReadonlyArray<readonly [number, Step]>): BrowserSession => {
  const frames: BrowserSession["frames"][number][] = [];
  const actions: SessionAction[] = [];
  let url = "";
  for (const [at, step] of steps) {
    if (step.action !== undefined) actions.push({ ...step.action, at });
    url = step.url ?? url;
    if (step.image !== undefined) frames.push({ at, url, image: step.image });
  }
  return { ...base, frames, actions };
};

const recording = (id: string, durationMs: number) => ({ video: `hub://sessions/${id}/video.webm`, trace: `hub://sessions/${id}/trace.zip`, durationMs });

function initial(now: number): BrowserSession[] {
  const checkoutStart = now - 52_000;
  const payStart = now - 100_000;
  return [
    played(
      {
        id: "bs-checkout",
        projectRef: STOREFRONT,
        agent: agent("T3", "Test checkout summary", "qa"),
        purpose: "Check the order summary takes the SAVE10 code on staging",
        state: "running",
        startedAt: iso(checkoutStart),
        now: "Reading the order summary",
      },
      [
        [0, { action: { by: "agent", kind: "open", target: `${SHOP}/`, snapshot: snap(dom.shopHome()) }, url: `${SHOP}/`, image: page.shopHome() }],
        [3_000, { action: { by: "agent", kind: "click", target: "Sign in", snapshot: snap(dom.shopHome(), ["link", "Sign in"]) }, url: `${SHOP}/account/sign-in`, image: page.shopSignIn(false, { x: 1066, y: 38 }) }],
        [6_000, { action: { by: "agent", kind: "fill_login", target: "Email and Password", credential: { site: "staging.shop.example.com", source: "1password" }, snapshot: snap(dom.shopSignIn(true), ["textbox", "Email"], ["textbox", "Password"]) }, image: page.shopSignIn(true) }],
        [8_000, { action: { by: "agent", kind: "click", target: "Sign in", snapshot: snap(dom.shopSignIn(true), ["button", "Sign in"]) }, url: `${SHOP}/`, image: page.shopHome({ x: 640, y: 466 }) }],
        [12_000, { action: { by: "agent", kind: "open", target: `${SHOP}/products/linen-shirt`, snapshot: snap(dom.shopProduct(0)) }, url: `${SHOP}/products/linen-shirt`, image: page.shopProduct(0) }],
        [18_000, { action: { by: "agent", kind: "click", target: "Add to cart", snapshot: snap(dom.shopProduct(0), ["button", "Add to cart"]) }, image: page.shopProduct(1, { x: 852, y: 383 }) }],
        [24_000, { action: { by: "agent", kind: "open", target: `${SHOP}/checkout`, snapshot: snap(dom.shopCheckout({})) }, url: `${SHOP}/checkout`, image: page.shopCheckout({}) }],
        [31_000, { action: { by: "agent", kind: "read", target: "the order summary", text: "subtotal $68.00, total $68.00", snapshot: snap(dom.shopCheckout({}), ["complementary", "Order summary"]) } }],
      ],
    ),
    played(
      {
        id: "bs-payouts",
        projectRef: STOREFRONT,
        agent: agent("T4", "Read export resume", "reader"),
        purpose: "Download September’s payouts report for the export",
        state: "asking",
        startedAt: iso(payStart),
        handoff: { reason: "The sign-in sends a code to a phone, and I can’t read it. Enter the code, then hand back.", at: 11_000 },
      },
      [
        [0, { action: { by: "agent", kind: "open", target: `${PAY}/login`, snapshot: snap(dom.paySignIn(false)) }, url: `${PAY}/login`, image: page.paySignIn(false) }],
        [4_000, { action: { by: "agent", kind: "fill_login", target: "Email and Password", credential: { site: "dashboard.pay.example.com", source: "1password" }, snapshot: snap(dom.paySignIn(true), ["textbox", "Email"], ["textbox", "Password"]) }, image: page.paySignIn(true) }],
        [7_000, { action: { by: "agent", kind: "click", target: "Continue", snapshot: snap(dom.paySignIn(true), ["button", "Continue"]) }, url: `${PAY}/login/verify`, image: page.payCode("") }],
        [11_000, { action: { by: "agent", kind: "ask", text: "the sign-in sends a code to a phone", snapshot: snap(dom.payCode(""), ["textbox", "6-digit code"]) } }],
      ],
    ),
    played(
      {
        id: "bs-share",
        projectRef: STOREFRONT,
        agent: agent("T5", "Write share route", "implementer"),
        purpose: "Reproduce the share link 404 on the live shop",
        state: "ended",
        startedAt: iso(now - 48 * 60_000),
        endedAt: iso(now - 48 * 60_000 + 161_000),
        recording: recording("bs-share", 161_000),
      },
      [
        [0, { action: { by: "agent", kind: "open", target: `${LIVE_SHOP}/products/linen-shirt`, snapshot: snap(dom.shopProduct(0)) }, url: `${LIVE_SHOP}/products/linen-shirt`, image: page.shopProduct(0) }],
        [12_000, { action: { by: "agent", kind: "click", target: "Share", snapshot: snap(dom.shopProduct(0), ["button", "Share"]) }, image: page.shopProduct(0, { x: 716, y: 498 }, true) }],
        [21_000, { action: { by: "agent", kind: "click", target: "Copy link", snapshot: snap(dom.shopProduct(0, true), ["menuitem", "Copy link"]) } }],
        [30_000, { action: { by: "agent", kind: "open", target: `${LIVE_SHOP}/s/linen-shirt?ref=share`, snapshot: snap(dom.shopNotFound()) }, url: `${LIVE_SHOP}/s/linen-shirt?ref=share`, image: page.shopNotFound() }],
        [46_000, { action: { by: "agent", kind: "read", target: "the page", text: "404, “This page isn’t here”", snapshot: snap(dom.shopNotFound(), ["heading", "This page isn’t here"]) } }],
        [63_000, { action: { by: "agent", kind: "open", target: `${LIVE_SHOP}/products/linen-shirt?ref=share`, snapshot: snap(dom.shopProduct(0)) }, url: `${LIVE_SHOP}/products/linen-shirt?ref=share`, image: page.shopProduct(0) }],
        [94_000, { action: { by: "agent", kind: "read", target: "the page", text: "the full path loads the shirt", snapshot: snap(dom.shopProduct(0), ["heading", "Linen shirt"]) } }],
        [121_000, { action: { by: "agent", kind: "click", target: "Add to cart", snapshot: snap(dom.shopProduct(0), ["button", "Add to cart"]) }, image: page.shopProduct(1, { x: 852, y: 383 }) }],
        [161_000, { action: { by: "agent", kind: "end", text: "the short /s/ link 404s; the full path works", snapshot: snap(dom.shopProduct(1)) } }],
      ],
    ),
    played(
      {
        id: "bs-pricing",
        projectRef: STOREFRONT,
        agent: agent("T2", "Review pricing copy", "reviewer"),
        purpose: "Compare the home page copy with the PR’s wording",
        state: "ended",
        startedAt: iso(now - 70 * 60_000),
        endedAt: iso(now - 70 * 60_000 + 72_000),
        recording: recording("bs-pricing", 72_000),
      },
      [
        [0, { action: { by: "agent", kind: "open", target: `${SHOP}/account/sign-in`, snapshot: snap(dom.shopSignIn(false)) }, url: `${SHOP}/account/sign-in`, image: page.shopSignIn(false) }],
        [5_000, { action: { by: "agent", kind: "fill_login", target: "Email and Password", credential: { site: "staging.shop.example.com", source: "1password" }, snapshot: snap(dom.shopSignIn(true), ["textbox", "Email"], ["textbox", "Password"]) }, image: page.shopSignIn(true) }],
        [9_000, { action: { by: "agent", kind: "click", target: "Sign in", snapshot: snap(dom.shopSignIn(true), ["button", "Sign in"]) }, url: `${SHOP}/`, image: page.shopHome({ x: 640, y: 466 }) }],
        [30_000, { action: { by: "agent", kind: "read", target: "the hero", text: "“Autumn linen. Washed, breathable, made to last.”", snapshot: snap(dom.shopHome(), ["heading", "Autumn linen"]) } }],
        [72_000, { action: { by: "agent", kind: "end", text: "the copy matches the PR", snapshot: snap(dom.shopHome()) } }],
      ],
    ),
    played(
      {
        id: "bs-receipt",
        projectRef: STOREFRONT,
        agent: agent("T1", "Write receipt dates", "implementer"),
        purpose: "Check the receipt email shows dates in the shopper’s locale",
        state: "failed",
        startedAt: iso(now - 2 * 3_600_000),
        endedAt: iso(now - 2 * 3_600_000 + 41_000),
        recording: recording("bs-receipt", 41_000),
      },
      [
        [0, { action: { by: "agent", kind: "open", target: "https://mail-preview.staging.shop.example.com/receipts/latest", snapshot: snap(dom.blank()) }, url: "https://mail-preview.staging.shop.example.com/receipts/latest", image: page.blank() }],
        [41_000, { action: { by: "agent", kind: "fail", text: "the page didn’t load in 30 s", snapshot: snap(dom.blank()) } }],
      ],
    ),
  ];
}

/** What each live session does next: the agent's steps, and (for `bs-payouts`) a person's while in control. */
function scripts(): Map<string, Step[]> {
  return new Map<string, Step[]>([
    [
      "bs-checkout",
      [
        { action: { by: "agent", kind: "type", target: "Discount code", text: "SAVE10", snapshot: snap(dom.shopCheckout({ code: "SAVE10" }), ["textbox", "Discount code"]) }, image: page.shopCheckout({ code: "SAVE10" }, { x: 900, y: 312 }), now: "Typing “SAVE10” in Discount code" },
        { action: { by: "agent", kind: "click", target: "Apply", snapshot: snap(dom.shopCheckout({ code: "SAVE10" }), ["button", "Apply"]) }, image: page.shopCheckout({ code: "SAVE10", applied: true }, { x: 1138, y: 312 }), now: "Clicking “Apply”" },
        { action: { by: "agent", kind: "read", target: "the order summary", text: "discount −$6.80, total $61.20", snapshot: snap(dom.shopCheckout({ code: "SAVE10", applied: true }), ["row", "Total"]) }, now: "Reading the order summary" },
        { action: { by: "agent", kind: "end", text: "the total takes the code", snapshot: snap(dom.shopCheckout({ code: "SAVE10", applied: true })) }, state: "ended" },
      ],
    ],
    [
      "bs-payouts:after",
      [
        { action: { by: "agent", kind: "resume", text: "signed in, on Payouts", snapshot: snap(dom.payDashboard({})) }, now: "Looking at the page again" },
        { action: { by: "agent", kind: "click", target: "Download CSV", snapshot: snap(dom.payDashboard({}), ["button", "Download CSV"]) }, image: page.payDashboard({ downloaded: true }, { x: 1142, y: 86 }), now: "Clicking “Download CSV”" },
        { action: { by: "agent", kind: "read", target: "payouts-2026-09.csv", text: "5 payouts, $82,366.35" }, now: "Reading payouts-2026-09.csv" },
        { action: { by: "agent", kind: "end", text: "saved September’s payouts", snapshot: snap(dom.payDashboard({ downloaded: true })) }, state: "ended" },
      ],
    ],
    [
      "bs-payouts:person",
      [
        { action: { by: "person", kind: "type", target: "the code field", snapshot: snap(dom.payCode("482913"), ["textbox", "6-digit code"]) }, image: page.payCode("482913") },
        { action: { by: "person", kind: "click", target: "Verify", snapshot: snap(dom.payCode("482913"), ["button", "Verify"]) }, url: `${PAY}/payouts`, image: page.payDashboard({}) },
      ],
    ],
    [
      "bs-locale",
      [
        { action: { by: "agent", kind: "open", target: `${SHOP}/?locale=pt-PT` }, url: `${SHOP}/?locale=pt-PT`, image: page.shopHome(), now: "Opening the shop as a Portuguese shopper", state: "running" },
        { action: { by: "agent", kind: "open", target: `${SHOP}/products/linen-shirt?locale=pt-PT` }, url: `${SHOP}/products/linen-shirt?locale=pt-PT`, image: page.shopProduct(0), now: "Opening the shirt" },
        { action: { by: "agent", kind: "read", target: "the price", text: "“$68.00”, not euros" }, now: "Reading the price" },
        { action: { by: "agent", kind: "click", target: "Add to cart" }, image: page.shopProduct(1, { x: 852, y: 383 }), now: "Clicking “Add to cart”" },
      ],
    ],
  ]);
}

// The store: the sessions, what each does next, and when its next step is due.
let sessions: readonly BrowserSession[] | undefined;
let todo = new Map<string, Step[]>();
const due = new Map<string, number>();
const listeners = new Set<() => void>();
let timer: number | undefined;

const emit = () => {
  for (const l of listeners) l();
};

const update = (id: string, change: (s: BrowserSession) => BrowserSession) => {
  sessions = sessions?.map((s) => (s.id === id ? change(s) : s));
  emit();
};

/** Plays `step` on the session, `at` now. */
const apply = (s: BrowserSession, step: Step): BrowserSession => {
  const at = Date.now() - Date.parse(s.startedAt);
  const url = step.url ?? s.frames.at(-1)?.url ?? "";
  const state = step.state ?? s.state;
  return {
    ...s,
    state,
    ...(step.now === undefined ? {} : { now: step.now }),
    frames: step.image === undefined ? s.frames : [...s.frames, { at, url, image: step.image }],
    actions: step.action === undefined ? s.actions : [...s.actions, { ...step.action, at }],
    ...(state === "ended" ? { endedAt: new Date().toISOString(), recording: { video: `hub://sessions/${s.id}/video.webm`, trace: `hub://sessions/${s.id}/trace.zip`, durationMs: at } } : {}),
  };
};

const tick = () => {
  const now = Date.now();
  for (const s of sessions ?? []) {
    if (s.state !== "running" && s.state !== "starting") continue;
    const key = todo.has(`${s.id}:after`) && s.actions.some((a) => a.kind === "hand_back") ? `${s.id}:after` : s.id;
    const next = todo.get(key)?.[0];
    if (next === undefined || (due.get(s.id) ?? 0) > now) continue;
    todo.get(key)?.shift();
    due.set(s.id, now + STEP_MS);
    update(s.id, (x) => apply(x, next));
  }
};

const ensure = () => {
  if (sessions !== undefined) return;
  const now = Date.now();
  sessions = initial(now);
  todo = scripts();
  due.set("bs-checkout", now + STEP_MS);
};

const subscribe = (l: () => void) => {
  ensure();
  listeners.add(l);
  timer ??= window.setInterval(tick, 250);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
};

const NONE: readonly BrowserSession[] = [];
const read = () => sessions ?? NONE;
const none = () => NONE;
const noop = () => () => undefined;

/** The project's browser sessions: none from a hub that doesn't serve them, and none outside the preview. */
export function useBrowserSessions(project: ProjectKey): readonly BrowserSession[] {
  const on = useData((st) => PREVIEW && st.features.includes(FEATURE));
  const all = useSyncExternalStore(on ? subscribe : noop, on ? read : none);
  const { machineId, projectId } = project;
  return useMemo(() => all.filter((s) => s.projectRef.machineId === machineId && s.projectRef.projectId === projectId), [all, machineId, projectId]);
}

/** You take the page: the agent waits, and sees the page as you leave it. */
export const takeOver = (id: string): void =>
  update(id, (s) => (s.state === "running" || s.state === "asking" ? apply({ ...s, state: "yours" }, { action: { by: "person", kind: "take_over" } }) : s));

/** A click or a key in the page while you have it: the preview plays the next of your steps, if it has one. */
export const actInPage = (id: string): void => {
  const next = todo.get(`${id}:person`)?.shift();
  if (next !== undefined) update(id, (s) => (s.state === "yours" ? apply(s, next) : s));
};

/** You hand the page back: the agent looks at it again and goes on. */
export const handBack = (id: string): void => {
  due.set(id, Date.now() + STEP_MS / 2);
  update(id, (s) => (s.state === "yours" ? apply({ ...s, state: "running" }, { action: { by: "person", kind: "hand_back" }, now: "Looking at the page again" }) : s));
};

/** A new session starts (QA's `fleetd:preview-session`): an agent opens a fresh browser. */
const start = () => {
  ensure();
  if (sessions?.some((s) => s.id === "bs-locale") === true) return;
  sessions = [
    ...(sessions ?? []),
    { id: "bs-locale", projectRef: STOREFRONT, agent: agent("T6", "Review locale tests", "reviewer"), purpose: "Check prices show in euros for a Portuguese shopper", state: "starting", startedAt: new Date().toISOString(), frames: [], actions: [] },
  ];
  due.set("bs-locale", Date.now() + 1_200);
  emit();
};

if (PREVIEW && typeof window !== "undefined") window.addEventListener("fleetd:preview-session", start);
