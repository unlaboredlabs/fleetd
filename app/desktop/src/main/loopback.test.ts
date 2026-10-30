import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { landing, pkce } from "./loopback";

describe("a loopback sign-in", () => {
  it("makes a PKCE pair whose challenge is the verifier's SHA-256", () => {
    const { verifier, challenge } = pkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("escapes what it shows on the landing page", () => {
    expect(landing("Not connected", "<script>x</script>")).not.toContain("<script>");
  });
});
