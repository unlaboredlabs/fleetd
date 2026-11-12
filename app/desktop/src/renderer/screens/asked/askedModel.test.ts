import { describe, expect, it } from "vitest";
import { ASK_STATE, askRows, askState, askSummary, orderState, type Ask, type AskedOrder } from "./askedModel";

const order = (workstreamId: string, state: AskedOrder["state"], extra: Partial<AskedOrder> = {}): AskedOrder => ({ workstreamId, title: `Order ${workstreamId}`, state, ...extra });

const ask = (handle: string, orders: AskedOrder[] = [], text = `Ask ${handle}`): Ask => ({
  handle,
  to: { machineId: "devbox", projectId: "storefront" },
  toTitle: "Storefront",
  text,
  at: "2026-11-01T11:50:00.000Z",
  orders,
});

describe("an asked order's state", () => {
  it("is Working while open, Merged once done with a merged PR, Done without one, and Stopped", () => {
    expect(orderState(order("W1", "open"))).toBe("working");
    // A PR merging doesn't end an open order.
    expect(orderState(order("W1", "open", { merged: true }))).toBe("working");
    expect(orderState(order("W1", "done", { merged: true }))).toBe("merged");
    expect(orderState(order("W1", "done"))).toBe("done");
    expect(orderState(order("W1", "stopped"))).toBe("stopped");
  });

  it("says each state in one word, as the chip shows it", () => {
    expect(Object.values(ASK_STATE).map((s) => s.word)).toEqual(["Waiting", "Working", "Merged", "Done", "Stopped"]);
    for (const s of Object.values(ASK_STATE)) expect(s.word).not.toMatch(/\s/u);
  });
});

describe("an ask's state", () => {
  it("waits with no order, works while any is open, and else says the furthest any got", () => {
    expect(askState([])).toBe("waiting");
    expect(askState([order("W1", "done", { merged: true }), order("W2", "open")])).toBe("working");
    expect(askState([order("W1", "stopped"), order("W2", "done")])).toBe("done");
    expect(askState([order("W1", "done"), order("W2", "done", { merged: true })])).toBe("merged");
    expect(askState([order("W1", "stopped")])).toBe("stopped");
  });
});

describe("an ask in a line", () => {
  it("is its first line, past a relay preamble, and the person's words when it quotes them", () => {
    expect(askSummary("Let people save their cart.\n\nDone when: a cart survives a reload.")).toBe("Let people save their cart.");
    expect(askSummary("\n  Gift cards at checkout  \nmore")).toBe("Gift cards at checkout");
    expect(askSummary('From the person, relayed by their lead (their words: "machines setup is not good ux enough. also it says \'too old\'.") Two things')).toBe(
      "Machines setup is not good ux enough. also it says 'too old'.",
    );
    expect(askSummary("From the person, relayed by their lead: “dark mode please” and soon")).toBe("Dark mode please");
    expect(askSummary("From the person, relayed by their lead: two things on the Machines page.")).toBe("Two things on the Machines page.");
    // A quote of its own, without the preamble, is the ask's words as they are.
    expect(askSummary('"Saved carts" broke after the update.')).toBe('"Saved carts" broke after the update.');
    expect(askSummary("Follow-up to my last message (the two automation bugs): please check the logs.")).toBe(
      "Follow-up to my last message (the two automation bugs): please check the logs.",
    );
  });

  it("keeps the preamble when nothing follows it", () => {
    expect(askSummary("From the person, relayed by their lead:")).toBe("From the person, relayed by their lead:");
    expect(askSummary("")).toBe("");
  });
});

describe("the Asked rows", () => {
  it("marks an ask folded into an earlier ask's order, and not the earlier one", () => {
    const shared = order("W280", "done", { merged: true });
    // Newest first, as project_asks lists them.
    const rows = askRows([ask("N3", [shared], "Follow-up: check the logs too."), ask("N2"), ask("N1", [shared])]);
    expect(rows.map((r) => [r.ask.handle, r.state, r.folded])).toEqual([
      ["N3", "merged", true],
      ["N2", "waiting", false],
      ["N1", "merged", false],
    ]);
    expect(rows[0]?.summary).toBe("Follow-up: check the logs too.");
  });

  it("isn't folded when it has an order of its own as well", () => {
    const rows = askRows([ask("N2", [order("W1", "open"), order("W2", "open")]), ask("N1", [order("W1", "open")])]);
    expect(rows[0]?.folded).toBe(false);
  });
});
