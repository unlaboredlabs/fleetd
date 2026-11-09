import { describe, expect, it } from "vitest";
import { cardReceipt, countWords, withoutDm, logReceipt, rowState, route, withDms, type AgentMessage, type AgentMessageTo } from "./model";

const hhmm = (iso: string) => iso.slice(11, 16);

const to = (taskId: string, outcome: AgentMessageTo["outcome"], more: Partial<AgentMessageTo> = {}): AgentMessageTo => ({ taskId, title: `${taskId}'s work`, outcome, ...more });

const dm = (id: string, from: string, recipients: AgentMessageTo[], sentAt: string, text = "Use 1001 for the restart close."): AgentMessage => ({
  id,
  from: { taskId: from, title: `${from}'s work` },
  text,
  sentAt,
  to: recipients,
});

describe("a card's receipt", () => {
  it("says how a DM reached its recipient, from its side and from the sender's", () => {
    const read = to("T2577", "delivered", { at: "2026-11-08T23:02:00Z" });
    expect(cardReceipt(read, true, hhmm)).toBe("Read at its next step, 23:02.");
    expect(cardReceipt(read, false, hhmm)).toBe("Delivered at its next step, 23:02.");
    expect(cardReceipt(to("T2577", "delivered"), true, hhmm)).toBe("Reads it at its next step.");
  });

  it("says the one allowed wake and the refused one in words, and a hold", () => {
    expect(cardReceipt(to("T2577", "woke", { at: "2026-11-08T23:09:00Z", detail: "it answers what T2577 asked at 23:05" }), true, hhmm)).toBe(
      "Woke it, 23:09: it answers what T2577 asked at 23:05.",
    );
    // The hub's words as it writes them: one plain sentence, no second colon, "held" said once.
    const guard = to("T2567", "not_woken", { detail: "T2567 has finished and isn't waiting on T2584: it gets this only if a Monitor or wait_ci of its own wakes it, or its lead continues it" });
    expect(cardReceipt(guard, false, hhmm)).toBe("Didn’t wake T2567: it has finished and isn't waiting on T2584. Held for its next run.");
    expect(logReceipt(guard)).toBe("wasn’t woken: it has finished and isn't waiting on T2584. Held for its next run");
    expect(cardReceipt(to("T2567", "not_woken"), false, hhmm)).toBe("Didn’t wake T2567. Held for its next run.");
    expect(cardReceipt(to("T2574", "held"), false, hhmm)).toBe("Held: it isn’t running, and reads this when it runs again.");
    expect(cardReceipt(to("T9", "refused", { detail: "T9 was cancelled" }), false, hhmm)).toBe("Not sent: T9 was cancelled.");
  });
});

describe("the log", () => {
  it("words a row's state for one recipient and for several", () => {
    expect(rowState(dm("S1", "T1", [to("T2", "delivered")], "2026-11-08T21:12:00Z"))).toEqual({ text: "delivered", strong: false });
    expect(rowState(dm("S2", "T1", [to("T2", "woke")], "2026-11-08T21:12:00Z"))).toEqual({ text: "woke T2", strong: true });
    expect(rowState(dm("S3", "T1", [to("T2", "not_woken")], "2026-11-08T21:12:00Z"))).toEqual({ text: "didn’t wake T2", strong: true });
    expect(rowState(dm("S5", "T1", [to("T2", "refused")], "2026-11-08T21:12:00Z"))).toEqual({ text: "not sent", strong: true });
    expect(rowState(dm("S6", "T1", [to("T2", "delivered"), to("T3", "refused")], "2026-11-08T21:12:00Z"))).toEqual({ text: "not sent to T3", strong: true });
    const three = dm("S4", "T2573", [to("T2577", "delivered"), to("T2576", "delivered"), to("T2574", "held")], "2026-11-08T23:02:00Z");
    expect(rowState(three)).toEqual({ text: "2 delivered, 1 held", strong: false });
    expect(route(three)).toBe("T2573 → T2577, T2576, T2574");
  });

  it("gives each recipient its own receipt", () => {
    expect(logReceipt(to("T2577", "delivered", { at: "2026-11-08T23:02:00Z" }))).toBe("read it at its next step");
    expect(logReceipt(to("T2574", "held"))).toBe("isn’t running: held for its next run");
    expect(logReceipt(to("T9", "refused", { detail: "no agent T9 in this project" }))).toBe("not sent: no agent T9 in this project");
    expect(logReceipt(to("T2567", "not_woken", { detail: "it has finished and isn’t waiting on T2584" }))).toBe("wasn’t woken: it has finished and isn’t waiting on T2584. Held for its next run");
  });

  it("counts DMs for the lead chat's strip, and says nothing for none", () => {
    expect(countWords(8)).toBe("8 DMs between agents");
    expect(countWords(1)).toBe("1 DM between agents");
    expect(countWords(0)).toBeUndefined();
    expect(countWords(undefined)).toBeUndefined();
  });
});

describe("an agent's thread", () => {
  const steps = [
    { kind: "action" as const, id: "a1", at: "2026-11-08T23:00:00Z", action: { summary: "cargo test -p fleetd --lib nodes::link" } },
    { kind: "message" as const, id: "m1", at: "2026-11-08T23:02:05Z", role: "user", text: "M12 · T2573 (Quiet update states) writes to you (T2577 (write) for W521): 'Verified…'" },
    { kind: "message" as const, id: "m2", at: "2026-11-08T23:03:00Z", role: "assistant", text: "Switching the restart close to 1001." },
    { kind: "action" as const, id: "a2", at: "2026-11-08T23:05:00Z", action: { summary: "mcp__fleetd__agent_message" } },
    { kind: "message" as const, id: "m3", at: "2026-11-08T23:06:00Z", role: "user", text: "S9 · your lead steers you: 'Rebase first.'" },
  ];
  const got = dm("M12", "T2573", [to("T2577", "delivered", { at: "2026-11-08T23:02:05Z" })], "2026-11-08T23:02:00Z");
  const sent = dm("M13", "T2577", [to("T2573", "delivered", { at: "2026-11-08T23:05:30Z" })], "2026-11-08T23:05:00Z");
  const elsewhere = dm("S14", "T2595", [to("T2572", "delivered")], "2026-11-08T23:04:00Z");
  const older = dm("S2", "T2573", [to("T2577", "delivered", { at: "2026-11-08T21:00:00Z" })], "2026-11-08T21:00:00Z");

  it("sets its DMs among its steps where they happened, in place of the steps they stand for", () => {
    const out = withDms(steps, [sent, elsewhere, got, older], "T2577");
    expect(out.map((x) => x.id)).toEqual(["a1", "dm:M12", "m2", "dm:M13", "m3"]);
  });

  it("keeps the lead's steers and a recipient's message it can't match", () => {
    const [, given, , , steer] = steps;
    if (given === undefined || steer === undefined) throw new Error("the steps above");
    expect(withoutDm(steer, new Set(["M12"]))).toBe(steer);
    expect(withoutDm(given, new Set())).toBe(given);
  });

  it("keeps what else a run was told when held DMs come in front of it", () => {
    const resumed = {
      kind: "message" as const,
      id: "m9",
      at: "2026-11-08T23:20:00Z",
      role: "user",
      text: "M12 · T2573 (Quiet update states) writes to you (T2577 (write) for W521): 'Verified…'\nA peer's note, not your lead's.\n\nM15 · T2576 (Tool calls) writes to you (T2577 (write) for W521): 'Same here.'\nA peer's note, not your lead's.\n\nPR #7 merged. Rebase onto main and carry on.",
    };
    expect(withoutDm(resumed, new Set(["M12", "M15"]))).toEqual({ ...resumed, text: "PR #7 merged. Rebase onto main and carry on." });
    // Only the DMs it shows as cards go: one it can't match stays in the words.
    expect(withoutDm(resumed, new Set(["M12"]))?.text).toMatch(/^M15 · T2576 [\s\S]*PR #7 merged/u);
    // DMs alone: the step goes, the cards say it.
    expect(withoutDm({ ...resumed, text: resumed.text.split("\n\nPR #7")[0] ?? "" }, new Set(["M12", "M15"]))).toBeUndefined();
  });

  it("leaves the steps alone with no DMs", () => {
    expect(withDms(steps, undefined, "T2577")).toBe(steps);
    expect(withDms(steps, [elsewhere], "T2577")).toBe(steps);
  });
});
