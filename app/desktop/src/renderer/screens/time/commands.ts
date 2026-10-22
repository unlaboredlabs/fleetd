// The palette's way into the time inspector. A go-to has to exist before the screen ever mounts, so it registers
// when this module loads (the shell's screen host imports the screen). It registers at screen priority: the
// palette's plain "Time" default registers later, and among defaults the last one wins, which would hide this one.
import { registerCommands } from "../palette";
import { timeRouteFor } from "./route";

registerCommands(
  [
    {
      id: "go:time",
      title: "Open time inspector",
      detail: "Where the time went: all work, or one piece of work's timeline",
      group: "go-to",
      keywords: ["time", "timeline", "breakdown", "insights", "slow", "critical path"],
      run: () => {
        window.location.hash = timeRouteFor(window.location.hash);
      },
    },
  ],
  "screen",
);
