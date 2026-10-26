import { describe, expect, it } from "vitest";
import { snap, structure } from "./pages";
import { actionLine, durationOf, frameAt, glyphOf, isLive, nodeLine, nowLine, sessionGroups, siteOf, spans, stepAt, type BrowserSession, type SessionAction, type SessionState } from "./model";

const T0 = Date.parse("2026-10-19T10:00:00.000Z");

const session = (id: string, state: SessionState, startedMin: number, more: Partial<BrowserSession> = {}): BrowserSession => ({
  id,
  projectRef: { machineId: "devbox", projectId: "storefront" },
  agent: { laneId: "T1", title: "Test checkout summary", role: "qa" },
  purpose: id,
  state,
  startedAt: new Date(T0 + startedMin * 60_000).toISOString(),
  frames: [],
  actions: [],
  ...more,
});

const act = (at: number, kind: SessionAction["kind"], more: Partial<SessionAction> = {}): SessionAction => ({ at, by: "agent", kind, ...more });

describe("sessionGroups", () => {
  it("puts those asking for you first, then the live ones oldest first, then the ended newest first", () => {
    const groups = sessionGroups([
      session("ended-early", "ended", 0),
      session("live-late", "running", 5),
      session("asking", "asking", 3),
      session("yours", "yours", 1),
      session("failed-late", "failed", 4),
      session("starting", "starting", 6),
    ]);
    expect(groups.map((g) => [g.title, g.sessions.map((x) => x.id)])).toEqual([
      ["Needs you", ["asking"]],
      ["Live", ["yours", "live-late", "starting"]],
      ["Recent", ["failed-late", "ended-early"]],
    ]);
  });

  it("leaves out a group with nothing in it", () => {
    expect(sessionGroups([session("a", "ended", 0)]).map((g) => g.group)).toEqual(["recent"]);
    expect(sessionGroups([])).toEqual([]);
  });
});

describe("actionLine", () => {
  it("says a login was filled from 1Password, for which site, and nothing of the login itself", () => {
    const line = actionLine(act(6_000, "fill_login", { target: "Email and Password", credential: { site: "example.com", source: "1password" } }));
    expect(line).toEqual({ who: "agent", words: "Filled login for example.com from 1Password", tone: "default", login: true });
  });

  it("logs where a person typed, never what", () => {
    expect(actionLine({ at: 0, by: "person", kind: "type", target: "the code field", text: "482913" }).words).toBe("You typed in the code field");
    expect(actionLine(act(0, "type", { target: "Discount code", text: "SAVE10" })).words).toBe("Typed “SAVE10” in Discount code");
  });

  it("words each kind of step", () => {
    expect(actionLine(act(0, "open", { target: "https://shop.example.com/" }))).toMatchObject({ words: "Opened", machine: "shop.example.com" });
    expect(actionLine(act(0, "open", { target: "https://shop.example.com/checkout" })).machine).toBe("shop.example.com/checkout");
    expect(actionLine(act(0, "click", { target: "Apply" })).words).toBe("Clicked “Apply”");
    expect(actionLine(act(0, "ask", { text: "the sign-in sends a code" }))).toMatchObject({ words: "Asked you to take over: the sign-in sends a code", tone: "warning" });
    expect(actionLine({ at: 0, by: "person", kind: "take_over" })).toMatchObject({ who: "you", words: "You took over" });
    expect(actionLine({ at: 0, by: "person", kind: "hand_back" }).words).toBe("You handed back");
    expect(actionLine(act(0, "fail", { text: "the page didn’t load" }))).toMatchObject({ words: "Stopped: the page didn’t load", tone: "danger" });
  });
});

describe("a replay's position", () => {
  const frames = [
    { at: 0, url: "https://a.example.com/", image: "a" },
    { at: 5_000, url: "https://a.example.com/b", image: "b" },
  ];
  const actions = [act(0, "open"), act(5_000, "click"), act(9_000, "end")];

  it("shows the last frame taken by then, and the first before any", () => {
    expect(frameAt(frames, 0)?.image).toBe("a");
    expect(frameAt(frames, 4_999)?.image).toBe("a");
    expect(frameAt(frames, 5_000)?.image).toBe("b");
    expect(frameAt([], 100)).toBeUndefined();
  });

  it("is on the last step taken by then", () => {
    expect(stepAt(actions, 0)).toBe(0);
    expect(stepAt(actions, 8_999)).toBe(1);
    expect(stepAt(actions, 60_000)).toBe(2);
    expect(stepAt([act(1_000, "open")], 0)).toBe(-1);
  });

  it("marks the stretches a person had the page, to its end when never handed back", () => {
    const taken = [act(0, "open"), { at: 2_000, by: "person", kind: "take_over" } as const, { at: 6_000, by: "person", kind: "hand_back" } as const, { at: 8_000, by: "person", kind: "take_over" } as const];
    expect(spans(taken, 10_000)).toEqual([
      [2_000, 6_000],
      [8_000, 10_000],
    ]);
  });
});

describe("a session's words", () => {
  it("counts a live one up to now, and an ended one to its recording's length", () => {
    const live = session("live", "running", 0);
    expect(durationOf(live, T0 + 52_000)).toBe(52_000);
    expect(durationOf(session("done", "ended", 0, { recording: { video: "v", trace: "t", durationMs: 161_000 } }), T0 + 3_600_000)).toBe(161_000);
  });

  it("names the site it is on, from its last frame or the first page it opened", () => {
    expect(siteOf(session("a", "running", 0, { frames: [{ at: 0, url: "https://staging.shop.example.com/checkout", image: "" }] }))).toBe("staging.shop.example.com");
    expect(siteOf(session("b", "starting", 0, { actions: [act(0, "open", { target: "https://pay.example.com/login" })] }))).toBe("pay.example.com");
  });

  it("says what the agent does while a person has the page, and why it waits when it asks", () => {
    expect(nowLine(session("y", "yours", 0))).toBe("Waits, and sees the page as you leave it");
    expect(nowLine(session("a", "asking", 0, { handoff: { reason: "a code", at: 0 } }))).toBe("Waiting for you to take over");
    expect(isLive(session("y", "yours", 0))).toBe(true);
    expect(isLive(session("e", "ended", 0))).toBe(false);
  });

  it("holds the agent paused while you have the page, and asking is the solid block", () => {
    expect(glyphOf("yours")).toBe("paused");
    expect(glyphOf("asking")).toBe("waiting");
    expect(glyphOf("running")).toBe("working");
  });
});

describe("a step's page snapshot", () => {
  it("says where a secret came from and never shows it", () => {
    expect(nodeLine({ depth: 2, role: "textbox", name: "Password", secret: "vault" })).toEqual({ role: "textbox", name: "“Password”", hidden: "filled from 1Password, hidden" });
    expect(nodeLine({ depth: 1, role: "textbox", name: "6-digit code", secret: "person" })).toEqual({ role: "textbox", name: "“6-digit code”", hidden: "typed by you, hidden" });
    expect(nodeLine({ depth: 2, role: "textbox", name: "Email", value: "qa@acme.test" })).toEqual({ role: "textbox", name: "“Email”", value: "qa@acme.test" });
  });

  it("holds no secret value at all, filled or typed", () => {
    const json = JSON.stringify([structure.shopSignIn(true), structure.paySignIn(true), structure.payCode("482913")]);
    expect(json).not.toContain("482913");
    expect(json).not.toMatch(/"secret":"(vault|person)","value"|"value":[^}]*"secret"/u);
    for (const n of [...structure.shopSignIn(true), ...structure.payCode("482913")].filter((x) => x.secret !== undefined)) expect(n.value).toBeUndefined();
  });

  it("finds what the step acted on by role and name", () => {
    const page = snap(structure.shopSignIn(true), ["textbox", "Email"], ["textbox", "Password"]);
    expect(page.targets.map((i) => page.nodes[i]?.name)).toEqual(["Email", "Password"]);
    const click = snap(structure.shopSignIn(true), ["button", "Sign in"]);
    expect(click.targets.map((i) => page.nodes[i]?.role)).toEqual(["button"]);
    expect(snap(structure.shopHome()).targets).toEqual([]);
  });
});
