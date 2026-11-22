// A sentence relayed from a box or an older node (a trouble's `why`, a provider's own words) reaches a person without
// the supplier of fleetd's computers in it: no name, no address, nothing of it in brackets (shared/sandbox.ts plainWhy).
import { expect, test } from "bun:test";
import { plainWhy, troubleLine, troubleOf } from "../../src/shared/sandbox.ts";

const SUPPLIER = /boat|https?:|wss?:/iu;

test("plainWhy drops the supplier's addresses and bracketed words, and names fleetd's computers instead", () => {
  expect(plainWhy("Pay at https://boat.dev/billing (boat.dev org acme-7)")).toBe("Pay at");
  expect(plainWhy("boat.dev is down; see status.boat.dev")).toBe("fleetd's computers is down; see fleetd's computers");
  expect(plainWhy("boat's scheduler refused (HTTP 409 conflict)")).toBe("fleetd's computers' scheduler refused");
  expect(plainWhy("couldn't open wss://box-1.sandboxes.boat.dev/x?_token=… (closed)")).toBe("couldn't open (closed)");
  // Its own words otherwise stay: the id "boat" alone, or another word, is no name.
  expect(plainWhy("the box ran out of disk (exit 28)")).toBe("the box ran out of disk (exit 28)");
});

test("a trouble an older node reports with the supplier's text reads without it, in every line a person sees", () => {
  for (const what of ["start", "keep_alive"]) {
    const t = troubleOf("boat", { what, reason: "failed", why: "boat.dev refused: org acme-7 suspended (https://boat.dev/org/acme-7)" });
    expect(t.message).not.toMatch(SUPPLIER);
    expect(troubleLine(t)).not.toMatch(SUPPLIER);
    expect(t.message).toContain("fleetd's computers");
  }
});
