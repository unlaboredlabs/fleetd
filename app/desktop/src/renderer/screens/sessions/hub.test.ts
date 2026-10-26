import { describe, expect, it } from "vitest";
import type { BrowserSession as HubSession } from "../../../shared/contracts";
import type { LiveAgent } from "../../src/data/selectors";
import { actionLine } from "./model";
import { agentOf, browserWords, fromHub, jsonLines, pageFor, shellWords, stepOf, stepsOf, viewState, type HubAction, type HubDom } from "./hub";

const ref = { machineId: "devbox", projectId: "storefront" };
const row = (more: Partial<HubSession> = {}): HubSession => ({
  sessionId: "B68722f97b065412024c7cda6c636fd9a",
  projectRef: ref,
  threadId: "6aacd21e-ee9a-45f1-b2d1-55ced592d265",
  taskId: "T3",
  purpose: "Check the order summary",
  state: "live",
  control: "agent",
  startedAt: "2026-10-19T10:00:00.000Z",
  ...more,
});
const act = (seq: number, tool: string, args: unknown, more: Partial<HubAction> = {}): HubAction => ({ seq, offsetMs: seq * 1000, tool, args, ok: true, ...more });

describe("a hub session's state", () => {
  it("says who drives a live one, and whether it asks for you", () => {
    expect(viewState(row())).toBe("running");
    expect(viewState(row({ takeoverReason: "a code" }))).toBe("asking");
    expect(viewState(row({ control: "human", takeoverReason: "a code" }))).toBe("yours");
    expect(viewState(row({ control: "handing_back" }))).toBe("handingBack");
  });

  it("says how an ended one stands, and reads a newer hub's state as ended", () => {
    expect(viewState(row({ state: "uploading" }))).toBe("saving");
    expect(viewState(row({ state: "recorded" }))).toBe("ended");
    expect(viewState(row({ state: "lost" }))).toBe("lost");
    expect(viewState(row({ state: "expired" }))).toBe("expired");
    expect(viewState(row({ state: "archived" }))).toBe("ended");
  });
});

describe("a hub session as the views show it", () => {
  const agent = (taskId: string, title: string): LiveAgent => ({
    id: `devbox/storefront/${taskId}`,
    project: "devbox/storefront",
    row: { laneId: taskId, taskId, role: "qa", status: "working", title, projectRef: ref, projectTitle: "storefront" },
  });

  it("names its agent by task, the lead when it has none, and no id for one that finished", () => {
    expect(agentOf([agent("T3", "Test checkout summary")], row())).toEqual({ laneId: "T3", title: "Test checkout summary", role: "qa" });
    const { taskId: _task, ...lead } = row();
    expect(agentOf([], lead)).toEqual({ laneId: "lead:devbox/storefront", title: "Lead", role: "lead" });
    expect(agentOf([], row({ taskId: "T99" }))).toEqual({ laneId: "T99", title: "Its agent" });
  });

  it("has its recording's length and files once recorded, its logins filled and its note", () => {
    const view = fromHub(
      row({
        state: "recorded",
        endedAt: "2026-10-19T10:02:41.000Z",
        files: [
          { file: "actions", bytes: 10 },
          { file: "video", bytes: 2000 },
        ],
        credentialsFilled: 1,
        note: "no video",
      }),
      { laneId: "T3", title: "x" },
    );
    expect(view).toMatchObject({ state: "ended", recording: { durationMs: 161_000, files: ["actions", "video"] }, credentialsFilled: 1, note: "no video" });
    expect(fromHub(row(), { laneId: "T3", title: "x" }).recording).toBeUndefined();
    expect(fromHub(row({ takeoverReason: "a code" }), { laneId: "T3", title: "x" }).handoff?.reason).toBe("a code");
  });
});

describe("an agent-browser command", () => {
  it("splits as a shell would", () => {
    expect(shellWords(`agent-browser fill "#q" 'linen shirt' && echo "a \\"b\\""`)).toEqual(["agent-browser", "fill", "#q", "linen shirt", "&", "&", "echo", 'a "b"']);
  });

  it("is what follows agent-browser and its flags, up to a pipe", () => {
    expect(browserWords("/home/a/.fleetd/browser/agent-browser --session s1 --json click @e3 | head")).toEqual(["click", "@e3"]);
    expect(browserWords("ls -la")).toEqual([]);
  });

  it("words each step, a selector or ref in mono and a failure in red", () => {
    const line = (command: string, more: Partial<HubAction> = {}) => actionLine(stepOf(act(2, "agent-browser", { command }, more)));
    expect(line("agent-browser open https://shop.example.com/products/linen-shirt")).toMatchObject({ words: "Opened", machine: "shop.example.com/products/linen-shirt" });
    expect(line("agent-browser click @e14")).toMatchObject({ words: "Clicked", machine: "@e14" });
    expect(line("agent-browser click '#add-to-cart'")).toMatchObject({ words: "Clicked", machine: "#add-to-cart" });
    expect(line("agent-browser fill '#q' 'linen'")).toMatchObject({ words: "Typed “linen” in", machine: "#q" });
    expect(line("agent-browser press Enter")).toMatchObject({ words: "Pressed Enter" });
    expect(line("agent-browser get text h1", { result: "This page isn’t here\n" })).toMatchObject({ words: "Read h1: This page isn’t here" });
    expect(line("agent-browser snapshot -i")).toMatchObject({ words: "Read the page" });
    expect(line("agent-browser click @e2", { ok: false })).toMatchObject({ words: "Clicked · failed", tone: "danger" });
  });
});

describe("fleetd's own steps", () => {
  it("says a login was filled from 1Password for the page's site, and never names the reference", () => {
    const step = stepOf(act(3, "fill_credential", { ref: "op://Team/Staging shop/password", target: "#password" }, { url: "https://staging.shop.example.com/account/sign-in" }));
    const line = actionLine(step);
    expect(line).toMatchObject({ words: "Filled login for staging.shop.example.com from 1Password", login: true });
    expect(JSON.stringify(line)).not.toContain("op://");
    expect(JSON.stringify(step)).not.toContain("op://");
  });

  it("words the start, an ask, a takeover and the end", () => {
    expect(actionLine(stepOf(act(1, "session_start", { purpose: "x" }))).words).toBe("Started a fresh browser");
    expect(actionLine(stepOf(act(4, "request_takeover", { reason: "a code" }))).words).toBe("Asked you to take over: a code");
    expect(actionLine(stepOf(act(5, "takeover", {}))).words).toBe("You took over");
    expect(actionLine(stepOf(act(6, "hand_back", {}))).words).toBe("You handed back");
    expect(actionLine(stepOf(act(7, "session_end", {}))).words).toBe("Ended the session");
  });
});

describe("a recording's steps and pages", () => {
  const dom = (seq: number): HubDom => ({ seq, offsetMs: seq * 1000, url: `https://x.example.com/${String(seq)}`, title: "", html: `<p>${String(seq)}</p>` });

  it("gives each step the page it found: after the step before it, or after itself when it opened one", () => {
    const doms = [dom(2), dom(4)];
    expect(pageFor(doms, 3, false)?.seq).toBe(2);
    expect(pageFor(doms, 4, true)?.seq).toBe(4);
    expect(pageFor(doms, 4, false)?.seq).toBe(2);
    expect(pageFor(doms, 1, true)).toBeUndefined();
  });

  it("reads JSONL, a broken line left out, the steps in order", () => {
    const lines = `${JSON.stringify(act(2, "agent-browser", { command: "agent-browser click @e1" }))}\nnot json\n${JSON.stringify(act(1, "session_start", {}))}\n`;
    const steps = stepsOf(jsonLines<HubAction>(lines), [dom(1)]);
    expect(steps.map((x) => x.kind)).toEqual(["start", "click"]);
    expect(steps[1]?.page?.url).toBe("https://x.example.com/1");
  });
});
