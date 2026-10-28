// The desktop app's dark tokens (app/desktop/src/renderer/ui/tokens.css): plain and dense, one accent.
import { Platform } from "react-native";

export const color = {
  bg: "#1c1c1b",
  raised: "#2a2a29",
  bubble: "#30302e",
  hairline: "#323230",
  border: "#4a4a46",
  text: "#ededea",
  quiet: "#ababa5",
  faint: "#74746e",
  accent: "#79abf5",
  accentFill: "#2e69cc",
  onAccent: "#ffffff",
  success: "#6cc28a",
  warning: "#e3aa4a",
  danger: "#f38c88",
} as const;

/** A step up from the desktop's 11/12/13: a phone is read at arm's length. */
export const size = { xs: 12, sm: 13, md: 15, lg: 17 } as const;

export const mono = Platform.select({ ios: "Menlo", default: "monospace" });
