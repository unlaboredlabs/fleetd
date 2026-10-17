import { describe, expect, it } from "vitest";
import { parseRetroArgs, renderRun } from "./retro.ts";

const base = ["run", "--hub", "http://127.0.0.1:4790", "--key-file", "/k"];

describe("fleetd retro run", () => {
  it("reads --window in days, 1d to 28d, and --advise", () => {
    expect(parseRetroArgs(base)).toEqual({ hub: "http://127.0.0.1:4790", keyFile: "/k", windowDays: 14, advise: false });
    expect(parseRetroArgs([...base, "--window", "7d", "--advise"])).toMatchObject({ windowDays: 7, advise: true });
    expect(parseRetroArgs([...base, "--window", "28"])).toMatchObject({ windowDays: 28 });
    expect(parseRetroArgs([...base, "--window", "30d"])).toEqual({ error: "--window must be 1d to 28d, got '30d'" });
    expect(parseRetroArgs(["run", "--key-file", "/k"])).toEqual({ error: "--hub is required" });
    expect(parseRetroArgs(["go"])).toEqual({ error: "unknown retro command 'go'" });
  });

  it("prints the run, each proposal, each dropped change and the turn's usage", () => {
    const text = renderRun(
      {
        run: 3,
        at: "2026-10-19T09:00:00.000Z",
        trigger: "manual",
        advise: true,
        windowDays: 14,
        incidents: 5,
        proposals: ["R4" as never],
        dropped: [{ index: 1, playbook: "feature", reason: "it cites I9, not incidents of the last 14 days" }],
        usage: { kind: "orchestrator", model: "claude-haiku-5-5", durationMs: 3200, ok: true, inputTokens: 1200, outputTokens: 300 },
      },
      [
        {
          proposalId: "R4" as never,
          run: 3,
          at: "2026-10-19T09:00:00.000Z",
          playbook: "bugfix",
          kind: "wording",
          claimedKind: "wording",
          diff: "@@",
          fields: ["leadInstructions"],
          fixesIncidents: ["I3" as never],
          metric: { class: "false_claim", op: "decrease", windowDays: 14 },
          expected: "fewer false claims",
          state: "suggested",
        },
      ],
    );
    expect(text).toBe(
      [
        "retro run 3 (manual, advise-only): 5 incidents in 14 d, 1 proposed, 1 dropped",
        "  R4 bugfix wording (leadInstructions): suggested · fixes I3 · false_claim down over 14 d",
        "  dropped #2 feature: it cites I9, not incidents of the last 14 days",
        "usage: claude-haiku-5-5, 3.2 s, 1200 in / 300 out tokens",
      ].join("\n"),
    );
  });
});
