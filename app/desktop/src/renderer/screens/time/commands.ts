// The palette's way into the time inspector. A go-to has to exist before the screen ever mounts, so it registers
// when this module loads (the shell's screen host imports the screen); it replaces the palette's plain "Time".
import { registerCommands } from "../palette";
import { timeRouteFor } from "./route";

registerCommands(
  [
    {
      id: "go:time",
      title: "Open time inspector",
      detail: "Where the time went: an order's timeline from its order, else the fleet",
      group: "go-to",
      keywords: ["time", "timeline", "breakdown", "insights", "slow", "critical path"],
      run: () => {
        window.location.hash = timeRouteFor(window.location.hash);
      },
    },
  ],
  "default",
);
