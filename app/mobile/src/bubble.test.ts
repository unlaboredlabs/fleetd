import { describe, expect, it } from "vitest";
import { bubble, bubbleMax, fitWidth, jumbo, photoSize } from "./bubble";

describe("bubble", () => {
  // Measured from Messages in the iOS 26 simulator (iPhone 17 Pro, 402 pt wide, 3x shots); change them only against it.
  it("keeps iMessage's geometry", () => {
    expect(bubble).toEqual({
      fontSize: 17,
      lineHeight: 20,
      padX: 14,
      padY: 10,
      radius: 20,
      gap: 4,
      burstGap: 10,
      margin: 16,
      maxShare: 0.7,
      tail: { width: 16, height: 9, angle: 32, tipRadius: 1.5, inset: 5.7, drop: 4.05, notch: 11.6, notchInset: 1.1, notchDrop: 6.2 },
      photo: { share: 0.6285, tallest: 4 / 3 },
      jumbo: { one: 72, oneLineHeight: 86, few: 48, fewLineHeight: 57, most: 3 },
    });
  });

  it("makes a one-line bubble a 40 pt capsule, a three-line one 80 pt", () => {
    expect(bubble.lineHeight + 2 * bubble.padY).toBe(40);
    expect(bubble.lineHeight + 2 * bubble.padY).toBe(2 * bubble.radius);
    expect(3 * bubble.lineHeight + 2 * bubble.padY).toBe(80);
  });

  it("hangs the tail's tip under the bubble's corner, 9.3 pt in and 7.6 pt down", () => {
    // The bar turns about its middle; its tip is its outer bottom corner.
    const { width, height, angle, inset, drop } = bubble.tail;
    const a = (angle * Math.PI) / 180;
    const middle = { x: -(inset + width / 2), y: drop - height / 2 };
    const tip = { x: middle.x + (width / 2) * Math.cos(a) - (height / 2) * Math.sin(a), y: middle.y + (width / 2) * Math.sin(a) + (height / 2) * Math.cos(a) };
    expect(tip.x).toBeCloseTo(-9.3, 1);
    expect(tip.y).toBeCloseTo(7.6, 1);
    // Its rounded tip stays inside the gap to the next burst.
    expect(tip.y - bubble.tail.tipRadius).toBeLessThan(bubble.burstGap);
  });

  it("caps a bubble's width at a share of the screen", () => {
    // Messages' widest on a 402 pt screen measured between 279.3 and 283.2.
    expect(bubbleMax(402)).toBe(281);
    expect(bubbleMax(375)).toBe(263);
  });
});

describe("photoSize", () => {
  // Messages' pictures on a 402 pt screen: 252.67 wide; 4:3 189.67 tall, 3:2 168.67, 3:4 337.
  it("sizes a picture as Messages does", () => {
    const wide = photoSize(402, 4 / 3);
    expect(wide.width).toBeCloseTo(252.67, 1);
    expect(wide.height).toBeCloseTo(189.5, 0);
    expect(photoSize(402, 3 / 2).height).toBeCloseTo(168.67, 0);
    expect(photoSize(402, 3 / 4).height).toBeCloseTo(337, 0);
  });

  it("crops a taller picture at 3:4", () => {
    expect(photoSize(402, 9 / 16).height).toBeCloseTo(photoSize(402, 3 / 4).height, 5);
  });
});

describe("fitWidth", () => {
  it("is the longest line, rounded up to the screen's pixel", () => {
    expect(fitWidth([120.4, 244.2, 98], 3)).toBeCloseTo(244.333, 3);
    expect(fitWidth([60], 3)).toBe(60);
    expect(fitWidth([60.2], 2)).toBe(60.5);
    expect(fitWidth([], 3)).toBe(0);
  });
});

describe("jumbo", () => {
  it("counts one to three emoji alone", () => {
    expect(jumbo("👍")).toBe(1);
    expect(jumbo("🎉🎉")).toBe(2);
    expect(jumbo(" 😀 😀 😀 ")).toBe(3);
  });

  it("counts joined, toned and flag emoji as one each", () => {
    expect(jumbo("👩\u{200D}👩\u{200D}👧\u{200D}👦")).toBe(1);
    expect(jumbo("👍🏽")).toBe(1);
    expect(jumbo("🇫🇮")).toBe(1);
    expect(jumbo("\u{2764}\u{FE0F}")).toBe(1);
    expect(jumbo("1\u{FE0F}\u{20E3}")).toBe(1);
  });

  it("is 0 for symbols iOS draws as text: ©, ®, ™, ‼ and a bare heart", () => {
    for (const text of ["\u{A9}", "\u{AE}", "\u{2122}", "\u{203C}", "\u{2764}"]) expect(jumbo(text)).toBe(0);
    expect(jumbo("\u{2764}\u{FE0F}")).toBe(1);
  });

  it("is 0 for words, four or more emoji, or nothing", () => {
    expect(jumbo("ok 👍")).toBe(0);
    expect(jumbo("😀😀😀😀")).toBe(0);
    expect(jumbo("")).toBe(0);
    expect(jumbo("123")).toBe(0);
  });
});
