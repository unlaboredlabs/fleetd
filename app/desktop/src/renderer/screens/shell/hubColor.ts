// A hub's colour (shared/hubs.ts) as the theme draws it: the chart series and role tints, which read in light and dark.
// It marks which group a row is in, never a state.
import type { HubColor } from "../../../shared/hubs";

export const HUB_COLOR: Readonly<Record<HubColor, string>> = {
  blue: "var(--series-1)",
  green: "var(--series-3)",
  amber: "var(--series-4)",
  rose: "var(--series-5)",
  violet: "var(--role-reviewer)",
  slate: "var(--faint)",
};
