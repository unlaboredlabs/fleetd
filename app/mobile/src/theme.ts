// The app's look, as iOS draws it: Apple's system colors for light and dark (the scheme follows the phone's), its type
// scale for the system font (SF on iOS), and one accent, system blue. Text scales with Dynamic Type, as React Native's
// Text does by default.
import { DarkTheme, DefaultTheme, type Theme as NavigationTheme } from "@react-navigation/native";
import { Platform, useColorScheme, type TextStyle } from "react-native";

export interface Palette {
  readonly dark: boolean;
  /** systemBackground: a list's or a chat's ground. */
  readonly bg: string;
  /** systemGroupedBackground: behind grouped lists and cards. */
  readonly grouped: string;
  /** secondarySystemGroupedBackground: a grouped list's rows, a card. */
  readonly cell: string;
  readonly label: string;
  readonly secondary: string;
  readonly tertiary: string;
  readonly separator: string;
  /** systemFill and tertiarySystemFill: a search field, a skeleton, a quiet button. */
  readonly fill: string;
  readonly fillQuiet: string;
  readonly accent: string;
  /** The accent at a tenth: an ask's options, a selected row. */
  readonly accentSoft: string;
  readonly onAccent: string;
  /** iMessage's grey bubble. */
  readonly bubble: string;
  /** A card on a plain ground: an approval or a pull request in a chat. */
  readonly surface: string;
  readonly danger: string;
  readonly dangerSoft: string;
  readonly warning: string;
  readonly warningSoft: string;
  readonly success: string;
  /** Avatars' colors, picked by name. */
  readonly tints: readonly string[];
  /** Floating chrome where there is no glass (Android): the bar's material, nearly opaque. */
  readonly chrome: string;
  /** A muted chat's count: systemGray2, a step quieter than the accent. */
  readonly muted: string;
  /** Behind the chat's thread, where bubbles sit. */
  readonly thread: string;
}

const light: Palette = {
  dark: false,
  bg: "#FFFFFF",
  grouped: "#F2F2F7",
  cell: "#FFFFFF",
  label: "#000000",
  secondary: "rgba(60,60,67,0.6)",
  tertiary: "rgba(60,60,67,0.3)",
  separator: "rgba(60,60,67,0.29)",
  fill: "rgba(120,120,128,0.2)",
  fillQuiet: "rgba(118,118,128,0.12)",
  accent: "#007AFF",
  accentSoft: "rgba(0,122,255,0.1)",
  onAccent: "#FFFFFF",
  bubble: "#E9E9EB",
  surface: "#F2F2F7",
  danger: "#FF3B30",
  dangerSoft: "rgba(255,59,48,0.1)",
  warning: "#FF9500",
  warningSoft: "rgba(255,149,0,0.12)",
  success: "#34C759",
  tints: ["#007AFF", "#34C759", "#FF9500", "#AF52DE", "#FF2D55", "#30B0C7", "#5856D6", "#A2845E", "#00C7BE", "#FF3B30"],
  chrome: "rgba(249,249,249,0.94)",
  muted: "#AEAEB2",
  thread: "#FFFFFF",
};

const dark: Palette = {
  dark: true,
  bg: "#000000",
  grouped: "#000000",
  cell: "#1C1C1E",
  label: "#FFFFFF",
  secondary: "rgba(235,235,245,0.6)",
  tertiary: "rgba(235,235,245,0.3)",
  separator: "rgba(84,84,88,0.6)",
  fill: "rgba(120,120,128,0.36)",
  fillQuiet: "rgba(118,118,128,0.24)",
  accent: "#0A84FF",
  accentSoft: "rgba(10,132,255,0.18)",
  onAccent: "#FFFFFF",
  bubble: "#262628",
  surface: "#1C1C1E",
  danger: "#FF453A",
  dangerSoft: "rgba(255,69,58,0.18)",
  warning: "#FF9F0A",
  warningSoft: "rgba(255,159,10,0.18)",
  success: "#30D158",
  tints: ["#0A84FF", "#30D158", "#FF9F0A", "#BF5AF2", "#FF375F", "#40C8E0", "#5E5CE6", "#AC8E68", "#66D4CF", "#FF453A"],
  chrome: "rgba(22,22,24,0.94)",
  muted: "#636366",
  thread: "#000000",
};

export const useTheme = (): Palette => (useColorScheme() === "dark" ? dark : light);

/** Apple's type scale at the default size (Large), with its tracking. */
export const type = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: "700", letterSpacing: 0.4 },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: 0.38 },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.26 },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: "600", letterSpacing: -0.45 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: "600", letterSpacing: -0.43 },
  body: { fontSize: 17, lineHeight: 22, letterSpacing: -0.43 },
  callout: { fontSize: 16, lineHeight: 21, letterSpacing: -0.31 },
  subhead: { fontSize: 15, lineHeight: 20, letterSpacing: -0.23 },
  footnote: { fontSize: 13, lineHeight: 18, letterSpacing: -0.08 },
  caption: { fontSize: 12, lineHeight: 16 },
  caption2: { fontSize: 11, lineHeight: 13, letterSpacing: 0.06 },
} as const satisfies Record<string, TextStyle>;

/** The 4-point grid; 16 is a row's and a screen's inset. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Apple's minimum touch target. */
export const TOUCH = 44;

/** iOS 26 and later: rounder grouped lists and cards, taller rows, and capsule buttons, as its own apps draw them. */
const ios26 = Platform.OS === "ios" && Number.parseInt(String(Platform.Version), 10) >= 26;

/** A grouped list's (and a card's) corner, a row's height, and whether a big button is a capsule. */
export const shape = { group: ios26 ? 26 : 12, card: ios26 ? 26 : 18, row: ios26 ? 52 : TOUCH, capsule: ios26 } as const;

export const mono = Platform.select({ ios: "Menlo", default: "monospace" });

export const navigationTheme = (p: Palette): NavigationTheme => {
  const base = p.dark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: { ...base.colors, primary: p.accent, background: p.bg, card: p.bg, text: p.label, border: p.separator, notification: p.danger },
  };
};
