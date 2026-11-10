// "Worked for 4s", the quiet caption under the reply a turn ended with, and the lead's side of a row it sits in: plain
// styles, which screens/Chat.tsx draws with and stamp.test.ts lays out with Yoga as React Native runs it. The caption is
// in the row's flow, so its place is the row's own: under the last bubble, inside the thread's margins at any screen
// width and text size, wrapping where it has to. Never out of the flow at a percent of its bubble's width: React Native
// resolves that against the width the bubble was offered (the row's), not the one it took, which put the stamp at the
// screen's right edge, cut off there.
import { bubble } from "./bubble";

export const lead = {
  /** The lead's side of a row: its bubbles from the left, each as wide as its own words. */
  row: { alignItems: "flex-start", paddingRight: 56, gap: bubble.gap },
  /** Under the bubble, as far from it and in from its corner as a send's note ("Not sent: …") is on the other side. */
  stamp: { marginTop: 3, marginLeft: 4 },
} as const;
