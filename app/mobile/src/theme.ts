// The app's look, as iOS draws it: Apple's system colors for light and dark (the scheme follows the phone's), its type
// scale for the system font (SF on iOS), and one accent, a neutral one: near-black in light and near-white in dark (the
// desktop app's --accent and --accent-fill in app/desktop/src/renderer/ui/tokens.css). Only links are blue, the desktop
// app's calmer blue rather than system blue (its --link). Text scales with Dynamic Type, as React Native's Text does by
// default. With Increase Contrast on (iOS), each scheme takes its stronger variant: darker greys and separators, and
// Apple's accessible system colors, as its own apps do.
import { DarkTheme, DefaultTheme, type Theme as NavigationTheme } from "@react-navigation/native";
import { useSyncExternalStore } from "react";
import { AccessibilityInfo, Platform, useColorScheme, type TextStyle } from "react-native";

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
  /** The accent as text and icons: unread, the header's buttons, a check mark. */
  readonly accent: string;
  /** The accent as a fill under onAccent: the selected chip, a filled button, a badge, the send button. */
  readonly accentFill: string;
  /** The accent at a tenth: an ask's options, a selected row. */
  readonly accentSoft: string;
  /** Text and icons on accentFill: white in light, near-black in dark, where the fill is near-white. */
  readonly onAccent: string;
  /** The accent as a large fill under white: the person's own bubble, an icon tile. Near-black in light; in dark a
   * quiet grey, as a near-white bubble would glare at night. */
  readonly accentDeep: string;
  readonly onAccentDeep: string;
  /** A link's blue, the one blue left. */
  readonly link: string;
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
  /** systemGray5: a swiped chat row, lifted into a card as Messages lifts it. */
  readonly lifted: string;
  /** iOS 26's systemBlue, systemOrange and systemIndigo: a swiped row's circles (read, pin, mute), as measured in
   * Messages on iOS 26 (blue and indigo; orange is Apple's published value). */
  readonly blue: string;
  readonly orange: string;
  readonly indigo: string;
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
  accent: "#1D1D1F",
  accentFill: "#1D1D1F",
  accentSoft: "rgba(29,29,31,0.07)",
  onAccent: "#FFFFFF",
  accentDeep: "#1D1D1F",
  onAccentDeep: "#FFFFFF",
  link: "#2360C4",
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
  lifted: "#E5E5EA",
  blue: "#0088FF",
  orange: "#FF8D28",
  indigo: "#6155F5",
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
  accent: "#F5F5F7",
  accentFill: "#F5F5F7",
  accentSoft: "rgba(245,245,247,0.12)",
  onAccent: "#1D1D1F",
  accentDeep: "#464648",
  onAccentDeep: "#FFFFFF",
  link: "#79ABF5",
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
  lifted: "#2C2C2E",
  blue: "#0091FF",
  orange: "#FF9230",
  indigo: "#6D7CFF",
};

/** Increase Contrast's variants: Apple's accessible system colors, and stronger greys, fills and separators. */
const lightContrast: Palette = {
  ...light,
  secondary: "rgba(60,60,67,0.8)",
  tertiary: "rgba(60,60,67,0.55)",
  separator: "rgba(60,60,67,0.55)",
  fill: "rgba(120,120,128,0.3)",
  fillQuiet: "rgba(118,118,128,0.2)",
  accent: "#000000",
  accentFill: "#000000",
  accentSoft: "rgba(0,0,0,0.12)",
  accentDeep: "#000000",
  link: "#1A4A9E",
  bubble: "#DCDCE0",
  surface: "#EBEBF0",
  danger: "#D70015",
  dangerSoft: "rgba(215,0,21,0.12)",
  warning: "#C93400",
  warningSoft: "rgba(201,52,0,0.14)",
  success: "#248A3D",
  muted: "#8E8E93",
};

const darkContrast: Palette = {
  ...dark,
  secondary: "rgba(235,235,245,0.8)",
  tertiary: "rgba(235,235,245,0.55)",
  separator: "rgba(110,110,115,0.9)",
  fill: "rgba(120,120,128,0.5)",
  fillQuiet: "rgba(118,118,128,0.36)",
  accent: "#FFFFFF",
  accentFill: "#FFFFFF",
  accentSoft: "rgba(255,255,255,0.18)",
  accentDeep: "#545456",
  link: "#A3C6FA",
  bubble: "#3A3A3C",
  surface: "#2C2C2E",
  danger: "#FF6961",
  dangerSoft: "rgba(255,105,97,0.22)",
  warning: "#FFB340",
  warningSoft: "rgba(255,179,64,0.22)",
  success: "#30DB5B",
  muted: "#8E8E93",
};

/** Whether Increase Contrast is on: read once, then kept as iOS says it changes. Android has no such setting. */
let contrast = false;
const heard = new Set<() => void>();
if (Platform.OS === "ios") {
  const set = (on: boolean) => {
    contrast = on;
    for (const f of heard) f();
  };
  void AccessibilityInfo.isDarkerSystemColorsEnabled().then(set);
  AccessibilityInfo.addEventListener("darkerSystemColorsChanged", set);
}
const listen = (f: () => void) => {
  heard.add(f);
  return () => void heard.delete(f);
};

export const useTheme = (): Palette => {
  const strong = useSyncExternalStore(listen, () => contrast);
  return useColorScheme() === "dark" ? (strong ? darkContrast : dark) : strong ? lightContrast : light;
};

/**
 * Apple's type scale at the default size (Large). No letter spacing: SF tracks itself at every size, and a letterSpacing
 * of ours would be added on top of it (Android's Roboto needs none).
 */
export const type = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: "700" },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: "700" },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: "600" },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  body: { fontSize: 17, lineHeight: 22 },
  callout: { fontSize: 16, lineHeight: 21 },
  subhead: { fontSize: 15, lineHeight: 20 },
  footnote: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  caption2: { fontSize: 11, lineHeight: 13 },
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
