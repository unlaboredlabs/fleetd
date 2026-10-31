import { describe, expect, it } from "vitest";
import type { CommandApprovalItem, Purchase } from "../../../shared/contracts";
import { cardLabel, itemLines, money, payQuestion, purchaseOutcome, purchaseTitle } from "./purchase";

const purchase: Purchase = {
  shop: { domain: "hotel.devbox.test", name: "Hotel Devbox" },
  total: { amount: "259.80", currency: "EUR" },
  items: [
    { name: "Double room, 12-14 Nov", quantity: 2, amount: "129.90" },
    { name: "City tax" },
  ],
  card: { ref: "op://Personal/Visa" },
  sessionId: "B0123456789abcdef0123456789abcdef",
};

const item = (state: CommandApprovalItem["state"]): CommandApprovalItem => ({ requestId: "Q4", machineId: "devbox", state, purchase });

describe("a purchase card", () => {
  it("says the total, each thing bought and the card in the person's words", () => {
    expect(money("129.90", "EUR")).toMatch(/129\.90/u);
    expect(money("129.90", "XYZ1")).toBe("129.90 XYZ1");
    expect(cardLabel(purchase.card)).toBe("Visa (Personal)");
    const [room, tax] = itemLines(purchase);
    expect(room).toMatch(/^2 × Double room, 12-14 Nov · .*129\.90/u);
    expect(tax).toBe("City tax");
    expect(purchaseTitle(purchase)).toMatch(/259\.80 at Hotel Devbox \(hotel\.devbox\.test\)$/u);
    expect(payQuestion(purchase)).toMatch(/^Pay .*259\.80 at Hotel Devbox with Visa \(Personal\)\?$/u);
  });

  it("folds to what happened to it", () => {
    expect(purchaseOutcome(item("open"))).toBeUndefined();
    expect(purchaseOutcome(item("approved"))?.text).toBe("Approved, card not filled yet");
    expect(purchaseOutcome(item("ran"))?.text).toBe("Approved, card filled");
    expect(purchaseOutcome(item("failed"))?.tone).toBe("danger");
    expect(purchaseOutcome(item("denied"))?.text).toBe("Not bought");
  });
});
