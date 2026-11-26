import { describe, expect, it } from "vitest";
import { atDomains, domainWord, readSignin, requireChoice, requireLine, requireOf, verifiedDomains } from "./signin";

describe("a cloud workspace's sign-in", () => {
  it("reads the service's answer, and refuses one it doesn't know", () => {
    const answer = { require: "google", domainJoin: true, domains: [{ domain: "acme.com", state: "verified" }, { domain: "acme.io", state: "pending" }] };
    expect(readSignin(answer)).toEqual(answer);
    expect(readSignin({ domainJoin: false, domains: [] })).toEqual({ require: null, domainJoin: false, domains: [] });
    expect(readSignin({ ...answer, require: "sso" })).toBeNull();
    expect(readSignin({ ...answer, domains: [{ domain: "acme.com", state: "maybe" }] })).toBeNull();
    expect(readSignin({ ...answer, domainJoin: "yes" })).toBeNull();
  });

  it("words the method, the domains and the join", () => {
    const s = readSignin({ require: null, domainJoin: false, domains: [{ domain: "a.com", state: "verified" }, { domain: "b.com", state: "failed" }, { domain: "c.com", state: "verified" }] });
    if (s === null) throw new Error("not read");
    expect(verifiedDomains(s)).toEqual(["a.com", "c.com"]);
    expect(atDomains(verifiedDomains(s))).toBe("@a.com and @c.com");
    expect(s.domains.map(domainWord)).toEqual(["Verified", "Not verified", "Verified"]);
    expect([requireChoice(null), requireChoice("google"), requireOf("any"), requireOf("google")]).toEqual(["any", "google", null, "google"]);
    expect(requireLine("google")).toBe("Members sign in with their Google account only; any other way is refused.");
    expect(requireLine(null)).toContain("GitHub");
  });
});
