import { describe, expect, it } from "vitest";
import { hasRefs, refOf, refWord, splitRefs, type Ref } from "./refs";

const ids = (text: string): string[] => splitRefs(text).flatMap((r) => (typeof r === "string" ? [] : [r.id]));

describe("splitRefs", () => {
  it("finds agents and orders in prose, with the words between them", () => {
    expect(splitRefs("T5945 finished (W890), see T12's PR.")).toEqual([
      { id: "T5945", kind: "agent", opens: true },
      " finished (",
      { id: "W890", kind: "order", opens: false },
      "), see ",
      { id: "T12", kind: "agent", opens: false },
      "'s PR.",
    ]);
  });

  it("leaves text with no id as one run", () => {
    expect(splitRefs("Nothing here.")).toEqual(["Nothing here."]);
    expect(splitRefs("")).toEqual([""]);
  });

  it("knows the hub's other numbered things", () => {
    expect(splitRefs("D742, Q73, N12, M40, S19, X12, C30 and F12x F31").flatMap((r) => (typeof r === "string" ? [] : [r.kind]))).toEqual([
      "decision",
      "request",
      "ask",
      "message",
      "steer",
      "change",
      "claim",
      "file",
    ]);
  });

  it("skips what only looks like one", () => {
    // Branches, paths, hashes, versions, longer words, everyday one-digit names and the X11 and F-key names.
    expect(ids("fleetd/T5957-the-apps a/W3 #T4 T12-x W3C v1.T2 T12.ts T0 an M1 Mac, Q4, S3, R2, X11 and F12")).toEqual([]);
  });

  it("capitalizes the plain word where it opens a sentence or a line", () => {
    const refs = splitRefs("T1 started. Then T2 and\nW3 too").filter((r): r is Ref => typeof r !== "string");
    expect(refs.map(refWord)).toEqual(["An agent", "an agent", "An order"]);
  });
});

it("refOf reads one id alone, as an inline code span holds it", () => {
  expect(refOf("T5957")).toBe("agent");
  expect(refOf(" W9 ")).toBe("order");
  expect(refOf("T5957 done")).toBeUndefined();
  expect(refOf("M1")).toBeUndefined();
});

it("hasRefs", () => {
  expect(hasRefs("see W12")).toBe(true);
  expect(hasRefs("see fleetd/W12-x")).toBe(false);
});
