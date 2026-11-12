import { describe, expect, it } from "vitest";
import { isPairLink, pairLinkStep, parsePairLink, pastedPair } from "./pairLink";

describe("parsePairLink", () => {
  it("reads the hub's origin and the code from a QR code's link", () => {
    expect(parsePairLink("fleetd://pair?hub=http%3A%2F%2Fdevbox.tail1234.ts.net%3A4790&code=abcd-2345")).toEqual({ ok: true, hub: "http://devbox.tail1234.ts.net:4790", code: "ABCD-2345" });
    expect(parsePairLink(" FLEETD://pair/?code=ABCD2345&hub=https%3A%2F%2Fhub.example.com%2F ")).toEqual({ ok: true, hub: "https://hub.example.com", code: "ABCD-2345" });
    // An address as typed: plain HTTP, and the code's look-alike letters read as digits, as when typed.
    expect(parsePairLink("fleetd://pair?hub=100.104.0.1:4790&code=abcd-234O")).toEqual({ ok: true, hub: "http://100.104.0.1:4790", code: "ABCD-2340" });
  });

  it("carries a long invite code of 16 or 20 characters", () => {
    expect(parsePairLink("fleetd://pair?hub=https%3A%2F%2Fhub.example.com&code=abcd-2345-wxyz-6789")).toEqual({ ok: true, hub: "https://hub.example.com", code: "ABCD-2345-WXYZ-6789" });
    expect(parsePairLink("fleetd://pair?hub=https%3A%2F%2Fhub.example.com&code=ABCD2345WXYZ6789ABCL")).toEqual({ ok: true, hub: "https://hub.example.com", code: "ABCD-2345-WXYZ-6789-ABC1" });
    expect(parsePairLink("fleetd://pair?hub=devbox&code=ABCD-2345-WXYZ-67")).toMatchObject({ ok: false, failure: { message: "This pairing QR code's code isn't a pairing code." } });
  });

  // The desktop's fleetd:// links take the same lengths (app/desktop/src/shared/app.test.ts, the same table).
  it("takes a code of 2 to 8 groups of four, with dashes or without, and neither 1 nor 9", () => {
    const groups = ["ABCD", "2345", "WXYZ", "6789", "KMNP", "QRST", "VWXY", "Z234", "ABCD"];
    for (let n = 1; n <= 9; n++) {
      for (const code of [groups.slice(0, n).join("-"), groups.slice(0, n).join("").toLowerCase()]) {
        const out = parsePairLink(`fleetd://pair?hub=https%3A%2F%2Facme.fleetd.dev&code=${code}`);
        expect(out?.ok, `${String(n)} groups: ${code}`).toBe(n >= 2 && n <= 8);
      }
    }
  });

  it("is null for anything but a pairing link", () => {
    for (const text of ["https://fleetd.sh", "fleetd://chat?key=a", "ABCD-2345", "", "fleetd://pairing?hub=x&code=y"]) {
      expect(parsePairLink(text)).toBeNull();
      expect(isPairLink(text)).toBe(false);
    }
  });

  it("says what's wrong with a broken pairing link", () => {
    expect(parsePairLink("fleetd://pair?code=ABCD-2345")).toMatchObject({ ok: false, failure: { message: "This pairing QR code has no hub address or no code." } });
    expect(parsePairLink("fleetd://pair?hub=devbox%3A4790")).toMatchObject({ ok: false, failure: { message: "This pairing QR code has no hub address or no code." } });
    expect(parsePairLink("fleetd://pair?hub=ftp%3A%2F%2Fdevbox&code=ABCD-2345")).toMatchObject({ ok: false, failure: { message: "Use an http:// or https:// address." } });
    expect(parsePairLink("fleetd://pair?hub=devbox&code=nope")).toMatchObject({ ok: false, failure: { message: "This pairing QR code's code isn't a pairing code." } });
    expect(parsePairLink("fleetd://pair?hub=%E0%A4%A&code=ABCD-2345")).toMatchObject({ ok: false, failure: { message: "This pairing QR code is damaged." } });
  });
});

describe("pastedPair", () => {
  it("takes a pairing link, or a code of 8, 16 or 20 characters alone or in its line", () => {
    expect(pastedPair("fleetd://pair?hub=devbox%3A4790&code=abcd-2345-wxyz-6789")).toEqual({ ok: true, hub: "http://devbox:4790", code: "ABCD-2345-WXYZ-6789" });
    expect(pastedPair(" abcd-2345 ")).toEqual({ ok: true, code: "ABCD-2345" });
    expect(pastedPair("Your code: ABCD-2345 (one use, 15 minutes)")).toEqual({ ok: true, code: "ABCD-2345" });
    expect(pastedPair("Join with abcd-2345-wxyz-678o.")).toEqual({ ok: true, code: "ABCD-2345-WXYZ-6780" });
    expect(pastedPair("ABCD2345WXYZ6789ABCD")).toEqual({ ok: true, code: "ABCD-2345-WXYZ-6789-ABCD" });
  });

  it("refuses a code-shaped run that isn't a code whole, never pasting the part before it", () => {
    const shape = { ok: false, note: "A pairing code is letters and digits in two or more groups of four, like ABCD-2345." };
    expect(pastedPair("ABCD-2345-U789")).toEqual(shape);
    expect(pastedPair("ABCD-2345-WXYZ-U789")).toEqual(shape);
  });

  it("says when nothing on the clipboard can be a code", () => {
    const none = { ok: false, note: "No pairing code on the clipboard." };
    expect(pastedPair("")).toEqual(none);
    expect(pastedPair("hello there")).toEqual(none);
    expect(pastedPair("ABCD-2345-WX")).toEqual(none);
    expect(pastedPair("ABCD".repeat(9))).toEqual(none);
  });
});

describe("pairLinkStep", () => {
  const LINK = "fleetd://pair?hub=http%3A%2F%2Fdevbox.tail1234.ts.net%3A4790&code=abcd-2345";

  it("asks before pairing with a link from outside the app, naming the hub", () => {
    expect(pairLinkStep(LINK, "outside", null)).toEqual({
      t: "confirm",
      hub: "http://devbox.tail1234.ts.net:4790",
      code: "ABCD-2345",
      title: "Connect to devbox.tail1234.ts.net:4790?",
      message: "This phone pairs with the hub at http://devbox.tail1234.ts.net:4790, which then sees it and sends it notifications. Connect only to a hub you or your team run.",
    });
  });

  it("says a link to a team of fleetd cloud is one anyone can make, and only under the build's cloud domain", () => {
    const team = "fleetd://pair?hub=https%3A%2F%2Fsecurity.fleetd.dev&code=ABCD-2345-WXYZ-6789";
    expect(pairLinkStep(team, "outside", null, "fleetd.dev")).toMatchObject({
      t: "confirm",
      title: "Connect to security.fleetd.dev?",
      message: "This is a fleetd cloud team. Anyone can make one, so join only if you know who sent you this link. This phone then gets its notifications.",
    });
    // A build with no cloud, and a hub elsewhere, ask as before.
    expect(pairLinkStep(team, "outside", null, null)).toMatchObject({ message: expect.stringContaining("Connect only to a hub you or your team run.") });
    expect(pairLinkStep(LINK, "outside", null, "fleetd.dev")).toMatchObject({ message: expect.stringContaining("Connect only to a hub you or your team run.") });
  });

  it("pairs at once with a code from the app's own scanner", () => {
    expect(pairLinkStep(LINK, "scanner", null)).toEqual({ t: "pair", hub: "http://devbox.tail1234.ts.net:4790", code: "ABCD-2345" });
  });

  it("never pairs a paired phone, refuses a broken link, and ignores anything else", () => {
    expect(pairLinkStep(LINK, "outside", "devbox")).toMatchObject({ t: "paired", title: "Connected to devbox" });
    expect(pairLinkStep("fleetd://pair?code=ABCD-2345", "outside", null)).toMatchObject({ t: "refuse", failure: { message: "This pairing QR code has no hub address or no code." } });
    expect(pairLinkStep("https://example.com", "scanner", null)).toEqual({ t: "ignore" });
  });
});
