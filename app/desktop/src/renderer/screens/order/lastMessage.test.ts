// Report B5 (order view): the lead's last message must not end mid-sentence once the lead is idle.
import { describe, expect, it } from "vitest";
import { buildConversation, completeWith } from "./conversationModel";

const base = { tail: [], workstreamId: "W1", events: [], steers: [], sending: [], lanes: [] };

describe("the lead's last message", () => {
  it("joins a cut start to the thread's latest end where they overlap", () => {
    expect(completeWith("Each PR goes to the train by", "Each PR goes to the train by itself.")).toBe("Each PR goes to the train by itself.");
    const head = `${"a".repeat(3000)} middle words that overlap`;
    const tail = `middle words that overlap, then the end.`;
    expect(completeWith(head, tail)).toBe(`${"a".repeat(3000)} middle words that overlap, then the end.`);
    expect(completeWith("short", "an unrelated message entirely, long enough to matter here")).toBeUndefined();
  });

  it("ends as the thread says once the lead is idle; while it works it is still writing", () => {
    const latest = { text: "You approved both of my asks, so T1 keeps the literal headline and builds the route by itself.", at: "2026-10-19T09:03:00.000Z" };
    const streamed = [{ messageId: "m", text: "You approved both of my asks, so T1 keeps the literal headline and builds the route by" }];
    const idle = buildConversation({ ...base, leadWorking: false, streamed, latest });
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ kind: "say", text: latest.text, at: latest.at });
    expect(idle[0]).not.toHaveProperty("streaming");
    const working = buildConversation({ ...base, leadWorking: true, streamed, latest });
    expect(working[0]).toMatchObject({ text: streamed[0]?.text, streaming: true });
  });

  it("completes a tail message the hub cut at 2,000 characters", () => {
    const full = `${Array.from({ length: 400 }, (_, i) => `word${String(i)}`).join(" ")} and the final sentence.`;
    const cut = `${full.slice(0, 1999)}…`;
    const c = buildConversation({ ...base, leadWorking: false, tail: [{ kind: "message", at: "2026-10-19T09:00:00.000Z", role: "assistant", text: cut }], latest: { text: full.slice(-4096), at: "2026-10-19T09:00:00.000Z" } });
    expect(c[0]).toMatchObject({ kind: "say", text: full });
    expect(c[0]).not.toHaveProperty("clipped");
  });

  it("ends as the thread says when the tail holds the message mid-stream and the live feed caught more of it (R2-1)", () => {
    const end = "Next: I'll wait for T1, T2 and T3 to report. Each PR goes to the train by itself, and I'll judge the results when they arrive.";
    const full = `S: W1 is running. I registered the brief.\n\n- **Writers:** T1 (alpha), T2 (beta) and T3 (gamma).\n\n${end}`;
    const tailCopy = full.slice(0, 60);
    const partial = full.slice(0, full.indexOf(" by itself"));
    const c = buildConversation({
      ...base,
      leadWorking: false,
      tail: [{ kind: "message", at: "2026-10-19T09:02:21.000Z", role: "assistant", text: tailCopy }],
      streamed: [{ messageId: "m", text: partial }],
      latest: { text: full.slice(-4096), at: "2026-10-19T09:02:21.000Z" },
    });
    expect(c).toHaveLength(1);
    expect(c[0]?.kind === "say" && c[0].text.endsWith("when they arrive.")).toBe(true);
  });

  it("keeps a long message's end the hub kept, and its start from the live feed", () => {
    const full = Array.from({ length: 500 }, (_, i) => `w${String(i)}`).join(" ");
    const kept = full.slice(-2000);
    const c = buildConversation({ ...base, leadWorking: false, tail: [{ kind: "message", at: "2026-10-19T09:00:00.000Z", role: "assistant", text: kept }], streamed: [{ messageId: "m", text: full }] });
    expect(c[0]).toMatchObject({ text: full });
    expect(c[0]).not.toHaveProperty("clipped");
  });
});
