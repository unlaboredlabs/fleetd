import { describe, expect, it } from "vitest";
import type { BrowserSession as HubSession } from "../../../shared/contracts";
import { fromHub } from "../sessions/hub";
import { placeLine } from "./data";

const row = (over: Partial<HubSession>): HubSession => ({
  sessionId: "B1",
  projectRef: { machineId: "devbox", projectId: "shop" },
  threadId: "t1",
  purpose: "Check the sign-in",
  startedAt: "2026-10-26T10:00:00.000Z",
  state: "live",
  control: "agent",
  kind: "ios",
  machineId: "devbox",
  ...over,
});

describe("where a screen runs", () => {
  it("names its machine, and a screen on the team's Revyl account as Revyl's, quietly", () => {
    const agent = { laneId: "", title: "T12" };
    expect(placeLine({ kind: "ios", machine: "devbox", x: fromHub(row({}), agent) })).toBe("iOS simulator · devbox");
    expect(placeLine({ kind: "ios", machine: "devbox", x: fromHub(row({ source: "revyl" }), agent) })).toBe("iOS simulator · Revyl");
    expect(placeLine({ kind: "android", machine: "devbox", x: fromHub(row({ kind: "android", source: "revyl" }), agent) })).toBe("Android · Revyl");
  });
});
