import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// theme.ts reads the phone's scheme from React Native, which doesn't load in node: the palettes are what's tested.
let scheme: "light" | "dark" = "light";
vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "26.0", select: (o: { ios?: unknown }) => o.ios }, useColorScheme: () => scheme }));
vi.mock("@react-navigation/native", () => ({ DarkTheme: { colors: {} }, DefaultTheme: { colors: {} } }));
const { useTheme } = await import("./theme");

const tokens = readFileSync(new URL("../../desktop/src/renderer/ui/tokens.css", import.meta.url), "utf8");

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

    it(`keeps white on a sent bubble at WCAG AA in ${s} mode`, () => {
      scheme = s;
      const t = useTheme();
      expect(contrast(t.onAccent, t.accentFill)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
