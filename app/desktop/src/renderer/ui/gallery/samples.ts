// Gallery content: short, long and empty versions of what the screens show. Fixture names only (acme/storefront,
// devbox, buildbox); no real people, hosts or URLs.

export const SHORT = "Fix the login redirect";
export const LONG =
  "Move the storefront checkout to the new payments service, keep the old endpoint answering for a week behind a flag, and write the migration note for your console's billing page so nobody is charged twice during the switch";
export const UNBROKEN = "acme/storefront/src/checkout/payments/providers/legacy-gateway/adapters/refund-reconciliation-worker.ts";
export const ORDER_ID = "3f6c2a9e-8b1d-4f7a-9c3e-2d5b8a1f6e04";

export const MARKDOWN = `## What changed

The checkout now calls the **payments service** instead of the legacy gateway. Refunds stay on the old path until the flag flips; see [the runbook](https://example.com/runbook) for the switch.

- Moved \`createCharge\` and \`capture\` behind the new client
- Kept the old endpoint answering, behind \`PAYMENTS_V2\`
- Left refunds alone: they reconcile overnight and a mid-run switch could double-post

1. Merge #212 after CI
2. Flip the flag on buildbox first

- [x] Unit tests for the client
- [ ] Load test on devbox

> The lead's note: ask before turning the flag on in production.

| Step | Where | Status |
| --- | --- | --- |
| Charge | payments service | done |
| Refund | legacy gateway, until the overnight reconciliation finishes and the flag flips | waiting |

\`\`\`ts
export async function createCharge(order: Order, client: PaymentsClient): Promise<Charge> {
  const amount = toMinorUnits(order.total, order.currency);
  return client.charges.create({ amount, currency: order.currency, idempotencyKey: order.id });
}
\`\`\`

A long unbroken path stays inside the column: acme/storefront/src/checkout/payments/providers/legacy-gateway/adapters/refund-reconciliation-worker.ts`;

export const CODE_TS = `import { describe, expect, it } from "vitest";

// Charges are idempotent per order, so a retried request never bills twice.
export function idempotencyKey(orderId: string, attempt: number): string {
  return \`\${orderId}:\${attempt}\`;
}

describe("idempotencyKey", () => {
  it("is stable for the same attempt", () => {
    expect(idempotencyKey("W14", 1)).toBe(idempotencyKey("W14", 1));
  });
});`;

export const CODE_LONG_LINE = `fleetd order --project acme/storefront --machine buildbox --brief "Move the checkout to the payments service and keep the old endpoint behind a flag for one week" --wait`;

export const LOG_LINES = Array.from({ length: 2000 }, (_, i) =>
  i % 7 === 0
    ? `step ${String(i)}: ${LONG}`
    : i % 3 === 0
      ? `step ${String(i)}: ran the checkout tests on buildbox, 214 passed`
      : `step ${String(i)}: ok`,
);
