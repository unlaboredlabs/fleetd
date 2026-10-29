import { describe, expect, it } from "vitest";
import { isPairLink, pairLinkStep, parsePairLink } from "./pairLink";

describe("parsePairLink", () => {
  it("reads the hub's origin and the code from a QR code's link", () => {
    expect(parsePairLink("fleetd://pair?hub=http%3A%2F%2Fdevbox.tail1234.ts.net%3A4790&code=abcd-2345")).toEqual({ ok: true, hub: "http://devbox.tail1234.ts.net:4790", code: "ABCD-2345" });
    expect(parsePairLink(" FLEETD://pair/?code=ABCD2345&hub=https%3A%2F%2Fhub.example.com%2F ")).toEqual({ ok: true, hub: "https://hub.example.com", code: "ABCD-2345" });
    // An address as typed: plain HTTP, and the code's look-alike letters read as digits, as when typed.
    expect(parsePairLink("fleetd://pair?hub=100.104.0.1:4790&code=abcd-234O")).toEqual({ ok: true, hub: "http://100.104.0.1:4790", code: "ABCD-2340" });
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

  it("pairs at once with a code from the app's own scanner", () => {
    expect(pairLinkStep(LINK, "scanner", null)).toEqual({ t: "pair", hub: "http://devbox.tail1234.ts.net:4790", code: "ABCD-2345" });
  });

  it("never pairs a paired phone, refuses a broken link, and ignores anything else", () => {
    expect(pairLinkStep(LINK, "outside", "devbox")).toMatchObject({ t: "paired", title: "Connected to devbox" });
    expect(pairLinkStep("fleetd://pair?code=ABCD-2345", "outside", null)).toMatchObject({ t: "refuse", failure: { message: "This pairing QR code has no hub address or no code." } });
    expect(pairLinkStep("https://example.com", "scanner", null)).toEqual({ t: "ignore" });
  });
});
