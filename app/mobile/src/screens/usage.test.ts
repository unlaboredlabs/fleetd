// Settings › Usage on the phone: its No one row shows exactly when the shared `idle` says it holds something, so on
// fleetd cloud a No one with only the leads' time on fleetd's computers and its spend is listed, as on the desktop,
// and the people add up to the Spend figure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceUsageCounts } from "../../../desktop/src/shared/contracts";
import { idle } from "../desktop";

const usage = readFileSync(join(import.meta.dirname, "Usage.tsx"), "utf8");
const none: WorkspaceUsageCounts = { agents: 0, agentMs: 0, approvals: 0, failed: 0, merged: 0, messages: 0, orders: 0 };

describe("the phone's Usage page", () => {
  it("lists No one when the shared idle says it holds something", () => {
    expect(usage).toMatch(/\{!idle\(usage\.unattributed\) \? \(\s*<ListRow\s+key="none"\s+title="No one"/u);
  });

  it("counts time on fleetd's computers and its spend as something: the leads' own boxes", () => {
    expect(idle(none)).toBe(true);
    expect(idle({ ...none, computerMs: 11 * 60_000 + 40_000, spendCents: 1 })).toBe(false);
    expect(idle({ ...none, computerMs: 40_000, spendCents: 0 })).toBe(false);
  });
});
