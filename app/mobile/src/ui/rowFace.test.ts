import { beforeEach, describe, expect, it, vi } from "vitest";
import { alphaOf, over, rowFace } from "./rowFace";

// theme.ts reads the phone's scheme from React Native, which doesn't load in node: the palettes are what's tested.
let scheme: "light" | "dark" = "light";
vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "26.0", select: (o: { ios?: unknown }) => o.ios }, useColorScheme: () => scheme }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: { colors: {} }, DefaultTheme: { colors: {} } }));
const { useTheme } = await import("../theme");

describe("a swiping row's face", () => {
  beforeEach(() => {
    scheme = "light";
  });

  // The swipe actions sit under the row at rest: a face with any see-through shows them on top of the row, as the
  // pressed fill (iOS's quiet fill, 12% grey) did.
  for (const s of ["light", "dark"] as const) {
    it(`hides the actions under it, pressed or not, in ${s}`, () => {
      scheme = s;
      const t = useTheme();
      expect(alphaOf(t.fillQuiet)).toBeLessThan(1);
      expect(alphaOf(rowFace(t, false))).toBe(1);
      expect(alphaOf(rowFace(t, true))).toBe(1);
    });
  }

  it("looks as the quiet fill did over the screen", () => {
    expect(over("rgba(118,118,128,0.12)", "#FFFFFF")).toBe("rgb(239,239,240)");
    expect(over("rgba(118,118,128,0.24)", "#000000")).toBe("rgb(28,28,31)");
    expect(over("#2360C4", "#FFFFFF")).toBe("rgb(35,96,196)");
    expect(rowFace({ bg: "#FFFFFF", fillQuiet: "rgba(118,118,128,0.12)" }, false)).toBe("#FFFFFF");
  });
});
