import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// theme.ts reads the phone's scheme from React Native, which doesn't load in node: the palettes are what's tested.
let scheme: "light" | "dark" = "light";
// Increase Contrast, as iOS reports it: its listener, to turn it on and off.
let darker: ((on: boolean) => void) | undefined;
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "26.0", select: (o: { ios?: unknown }) => o.ios },
  useColorScheme: () => scheme,
  AccessibilityInfo: {
    isDarkerSystemColorsEnabled: () => Promise.resolve(false),
    addEventListener: (_: string, f: (on: boolean) => void) => {
      darker = f;
    },
  },
}));
// The palettes are read outside a render: the store's value as it is.
vi.mock("react", async (actual) => ({ ...(await actual<typeof import("react")>()), useSyncExternalStore: (_: unknown, get: () => unknown) => get() }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: { colors: {} }, DefaultTheme: { colors: {} } }));
const { useTheme } = await import("./theme");

const tokens = readFileSync(new URL("../../desktop/src/renderer/ui/tokens.css", import.meta.url), "utf8");
const shareView = readFileSync(new URL("../plugins/share-extension/ShareView.swift", import.meta.url), "utf8");

/** A desktop token's value in one theme's block of tokens.css. */
const desktop = (theme: "light" | "dark", name: string): string => {
  const block = tokens.split(`[data-theme="${theme}"] {`)[1]?.split("}")[0] ?? "";
  const value = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`).exec(block)?.[1];
  if (value === undefined) throw new Error(`no --${name} in tokens.css's ${theme} theme`);
  return value.toUpperCase();
};

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** WCAG 2's relative luminance and contrast ratio. */
const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe("the accent", () => {
  for (const s of ["light", "dark"] as const) {
    it(`is the desktop app's in ${s} mode`, () => {
      scheme = s;
      const t = useTheme();
      expect(t.accent).toBe(desktop(s, "accent"));
      expect(t.accentFill).toBe(desktop(s, "accent-fill"));
      expect(t.onAccent).toBe(desktop(s, "on-accent"));
      const [r, g, b] = rgb(t.accent);
      expect(t.accentSoft).toMatch(new RegExp(`^rgba\\(${String(r)},${String(g)},${String(b)},0\\.\\d+\\)$`));
    });

    it(`keeps words on a filled button and a sent bubble at WCAG AA in ${s} mode`, () => {
      scheme = s;
      const t = useTheme();
      expect(contrast(t.onAccent, t.accentFill)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.onAccentDeep, t.accentDeep)).toBeGreaterThanOrEqual(4.5);
    });

    it(`keeps links the desktop app's blue in ${s} mode`, () => {
      scheme = s;
      expect(useTheme().link).toBe(desktop(s, "link"));
    });
  }

  it("is the share extension's too", () => {
    const swift = (name: string): string[] =>
      /static let (\w+) = Color\(UIColor \{ \$0\.userInterfaceStyle == \.dark \? UIColor\(hex: 0x(\w{6})\) : UIColor\(hex: 0x(\w{6})\) \}\)/
        .exec(shareView.split("\n").find((l) => l.includes(`static let ${name} =`)) ?? "")
        ?.slice(2)
        .map((h) => `#${h}`) ?? [];
    expect(swift("accent")).toEqual([desktop("dark", "accent"), desktop("light", "accent")]);
    expect(swift("accentFill")).toEqual([desktop("dark", "accent-fill"), desktop("light", "accent-fill")]);
    expect(shareView).not.toContain("Color.accentColor");
  });
});

/** An rgba() or hex color laid over an opaque hex ground, as the screen shows it. */
const over = (color: string, ground: string): string => {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/u.exec(color);
  if (m === null) return color;
  const alpha = Number(m[4]);
  const mixed = [1, 2, 3].map((i, n) => Math.round(Number(m[i]) * alpha + (rgb(ground)[n] ?? 0) * (1 - alpha)));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
};

describe("an approval's risk line", () => {
  for (const s of ["light", "dark"] as const) {
    it(`reads at WCAG AA on its orange pill in a card in ${s} mode`, () => {
      scheme = s;
      const t = useTheme();
      // ApprovalCard draws the words in the label's ink on warningSoft, the card's surface under it.
      expect(contrast(t.label, over(t.warningSoft, t.surface))).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("the type scale", () => {
  it("leaves tracking to the system font, which would add ours on top of its own", async () => {
    const { type } = await import("./theme");
    for (const style of Object.values(type)) expect(style).not.toHaveProperty("letterSpacing");
  });
});

describe("Increase Contrast", () => {
  for (const s of ["light", "dark"] as const) {
    it(`strengthens the greys and keeps every pairing legible in ${s} mode`, () => {
      scheme = s;
      const normal = useTheme();
      darker?.(true);
      const strong = useTheme();
      darker?.(false);
      expect(useTheme()).toBe(normal);
      expect(strong).not.toBe(normal);
      const ground = s === "light" ? "#FFFFFF" : "#000000";
      // Secondary text reaches AA where the normal one doesn't have to; white on the accent's fill stays AA.
      expect(contrast(over(strong.secondary, ground), ground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(over(strong.secondary, ground), ground)).toBeGreaterThan(contrast(over(normal.secondary, ground), ground));
      expect(contrast(strong.onAccent, strong.accentFill)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(strong.accent, ground)).toBeGreaterThan(contrast(normal.accent, ground));
      expect(contrast(strong.label, over(strong.warningSoft, strong.surface))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
