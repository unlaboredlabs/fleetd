// The app's look: the desktop app's neutrals (app/desktop/src/renderer/ui/tokens.css), cool greys with a breath of
// blue-black in them, laid on iOS's own structure (the scheme follows the phone's, grouped lists on a tinted ground,
// true black at night as iOS draws it), Apple's type scale for the system font (SF on iOS), and one accent, a neutral
// one: near-black in light and near-white in dark (the desktop's --accent and --accent-fill). Only links are blue, the
// desktop's blue rather than system blue (its --link); colour is otherwise kept for what it means (a status, a switch
// that's on, a bot's own tint), never to decorate. Text scales with Dynamic Type, as React Native's Text does by
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
  grouped: "#F4F5F7",
  cell: "#FFFFFF",
  label: "#0B0D10",
  secondary: "#5C626B",
  tertiary: "#ABB0B7",
  separator: "rgba(15,23,32,0.14)",
  fill: "rgba(15,23,32,0.12)",
  fillQuiet: "rgba(15,23,32,0.06)",
  accent: "#0B0D10",
  accentFill: "#0B0D10",
  accentSoft: "rgba(11,13,16,0.07)",
  onAccent: "#FFFFFF",
  accentDeep: "#0B0D10",
  onAccentDeep: "#FFFFFF",
  link: "#1D5FD3",
  bubble: "#EDEFF2",
  surface: "#F4F5F7",
  danger: "#FF3B30",
  dangerSoft: "rgba(255,59,48,0.1)",
  warning: "#FF9500",
  warningSoft: "rgba(255,149,0,0.12)",
  success: "#34C759",
  tints: ["#007AFF", "#34C759", "#FF9500", "#AF52DE", "#FF2D55", "#30B0C7", "#5856D6", "#A2845E", "#00C7BE", "#FF3B30"],
  chrome: "rgba(250,250,251,0.94)",
  muted: "#ABB0B7",
  thread: "#FFFFFF",
  lifted: "#E9EBEE",
  blue: "#0088FF",
  orange: "#FF8D28",
  indigo: "#6155F5",
};

const dark: Palette = {
  dark: true,
  bg: "#000000",
  grouped: "#000000",
  cell: "#1A1B1F",
  label: "#ECEDF0",
  secondary: "#9A9FA8",
  tertiary: "#5A5F67",
  separator: "#2A2C31",
  fill: "rgba(255,255,255,0.14)",
  fillQuiet: "rgba(255,255,255,0.08)",
  accent: "#F3F4F6",
  accentFill: "#F3F4F6",
  accentSoft: "rgba(243,244,246,0.12)",
  onAccent: "#0C0E11",
  accentDeep: "#3E4148",
  onAccentDeep: "#FFFFFF",
  link: "#74A6FF",
  bubble: "#222429",
  surface: "#1A1B1F",
  danger: "#FF453A",
  dangerSoft: "rgba(255,69,58,0.18)",
  warning: "#FF9F0A",
  warningSoft: "rgba(255,159,10,0.18)",
  success: "#30D158",
  tints: ["#0A84FF", "#30D158", "#FF9F0A", "#BF5AF2", "#FF375F", "#40C8E0", "#5E5CE6", "#AC8E68", "#66D4CF", "#FF453A"],
  chrome: "rgba(18,19,22,0.94)",
  muted: "#5F646C",
  thread: "#000000",
  lifted: "#2A2C31",
  blue: "#0091FF",
  orange: "#FF9230",
  indigo: "#6D7CFF",
};

/** Increase Contrast's variants: Apple's accessible system colors, and stronger greys, fills and separators. */
const lightContrast: Palette = {
  ...light,
  secondary: "#41464E",
  tertiary: "#7A8089",
  separator: "rgba(15,23,32,0.32)",
  fill: "rgba(15,23,32,0.2)",
  fillQuiet: "rgba(15,23,32,0.12)",
  accent: "#000000",
  accentFill: "#000000",
  accentSoft: "rgba(0,0,0,0.12)",
  accentDeep: "#000000",
  link: "#1A4A9E",
  bubble: "#DFE2E6",
  surface: "#E9EBEE",
  danger: "#D70015",
  dangerSoft: "rgba(215,0,21,0.12)",
  warning: "#C93400",
  warningSoft: "rgba(201,52,0,0.14)",
  success: "#248A3D",
  muted: "#80868F",
};

const darkContrast: Palette = {
  ...dark,
  secondary: "#BDC1C8",
  tertiary: "#868B93",
  separator: "#46494F",
  fill: "rgba(255,255,255,0.24)",
  fillQuiet: "rgba(255,255,255,0.16)",
  accent: "#FFFFFF",
  accentFill: "#FFFFFF",
  accentSoft: "rgba(255,255,255,0.18)",
  accentDeep: "#4D5058",
  link: "#A3C6FA",
  bubble: "#33363C",
  surface: "#2A2C31",
  danger: "#FF6961",
  dangerSoft: "rgba(255,105,97,0.22)",
  warning: "#FFB340",
  warningSoft: "rgba(255,179,64,0.22)",
  success: "#30DB5B",
  muted: "#868B93",
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
 * Apple's type scale at the default size (Large), at the desktop's weights: regular for words, semibold for a title or
 * a name, bold only for the large title iOS draws in its own bars. No letter spacing: SF tracks itself at every size,
 * and a letterSpacing of ours would be added on top of it (Android's Roboto needs none).
 */
export const type = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: "700" },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: "600" },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: "600" },
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
