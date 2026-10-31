import { describe, expect, it } from "vitest";
import type { PurchaseLogEntry } from "../../../shared/contracts";
import { NO_CARD, cardOptions, purchaseLine, purchaseState } from "./paymentsModel";

const entry = (state: PurchaseLogEntry["state"]): PurchaseLogEntry => ({
  requestId: "Q3",
  state,
  askedAt: "2026-10-31T09:00:00.000Z",
  purchase: {
    shop: { domain: "hotel.devbox.test", name: "Hotel Devbox" },
    total: { amount: "129.90", currency: "EUR" },
    items: [{ name: "Double room" }],
    card: { ref: "op://Personal/Visa" },
    sessionId: "B0123456789abcdef0123456789abcdef",
  },
});

describe("a Navi's payments", () => {
  it("offers the person's cards, the one picked even if no longer listed, and no card", () => {
    const cards = [{ ref: "op://Shared/Amex", title: "Amex", vault: "Shared" }];
    expect(cardOptions(cards, "op://Personal/Visa").map((o) => o.label)).toEqual(["Visa (Personal)", "Amex (Shared)", "No card"]);
    expect(cardOptions(cards, undefined).at(-1)?.value).toBe(NO_CARD);
  });

  it("says what became of each purchase, an expired one too", () => {
    expect(purchaseState(entry("ran"))).toBe("Approved, card filled");
    expect(purchaseState(entry("failed"))).toBe("Approved, never filled");
    expect(purchaseState(entry("denied"))).toBe("Not bought");
    const line = purchaseLine(entry("open"));
    expect(line.shop).toBe("Hotel Devbox");
    expect(line.amount).toMatch(/129\.90/u);
  });
});
