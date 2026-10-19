import { describe, expect, it } from "vitest";
import { findRawText } from "./text-rules.ts";

const kinds = (text: string) => findRawText(text).map((h) => `${h.kind}:${h.match}`);

describe("findRawText", () => {
  it("finds the ids, hashes and keys from the GPUI screenshots", () => {
    expect(kinds("LEAD eac3e0fe-ec61-4954-4f78-67240a80c42b · opus · idle")).toEqual([
      "uuid:eac3e0fe-ec61-4954-4f78-67240a80c42b",
    ]);
    expect(kinds("brief 3e760f96 at lead.start@0a1b2c3d4e")).toEqual([
      "hash:3e760f96",
      "hash:0a1b2c3d4e",
      "slug:lead.start",
    ]);
    expect(kinds("share.public_link, share.pay_comparison")).toEqual([
      "slug:share.public_link",
      "slug:share.pay_comparison",
    ]);
    expect(kinds("phase waiting_on_you")).toEqual(["slug:waiting_on_you"]);
    expect(kinds("a-monthly-vs-week")).toEqual(["slug:a-monthly-vs-week"]);
  });

  it("finds markdown a renderer should have consumed", () => {
    expect(kinds("## Why you are woken")).toEqual(["markdown:## Why you are woken"]);
    expect(kinds("Decided:\n- D1 rolling window").map((k) => k.split(":")[0])).toEqual(["markdown"]);
    expect(kinds("> quoted")).toEqual(["markdown:> quoted"]);
    expect(kinds("a **bold** move")).toEqual(["markdown:**bold**"]);
    expect(kinds("run `vp i` first")).toEqual(["markdown:`vp i`"]);
    expect(kinds("see [the docs](https://fleetd.sh/docs)")).toEqual(["markdown:[the docs](https://fleetd.sh/docs)"]);
    expect(kinds("```\ncode")).toEqual(["markdown:```"]);
  });

  it("leaves ordinary UI text alone", () => {
    for (const text of [
      "Both pending asks are settled - the headline stays literal.",
      "$200/mo plan → $1,840 of usage this week, 40×",
      "08:15:17 on 2026-10-19, order W12 task T3 ask A4 steer S1",
      "e.g. fleetd.sh, app-pair.json, version v1.2.3, Node.js",
      "A follow-up for end-to-end tests that are up-to-date",
      "Usage over the last-7-days window",
      "Worked for 3s · 1 tool call",
      "defaced decade 1234567",
      "https://github.com/acme/storefront/pull/12",
    ]) {
      expect(kinds(text), text).toEqual([]);
    }
  });
});
