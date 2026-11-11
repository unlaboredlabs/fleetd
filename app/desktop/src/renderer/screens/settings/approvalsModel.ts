// A project's approvals (project_approvals, W239), as pure functions: the three modes in the person's words (a new
// project starts in YOLO, W588; one made before keeps the mode it had), and each auto-approved action as a log row.
import type { AutoApproved, NaviApprovalMode } from "../../../shared/contracts";

export const MODES: ReadonlyArray<{ readonly mode: NaviApprovalMode; readonly label: string; readonly description: string }> = [
  {
    mode: "checker",
    label: "Checker decides",
    description: "A fresh model judges each risky action first. What you asked for runs and shows as one line in the chat; it asks you when unsure, and blocks what looks injected.",
  },
  { mode: "ask", label: "Ask me about everything", description: "Every send, share, first visit to a site and final confirm waits for you on a card." },
  {
    mode: "yolo",
    label: "YOLO",
    description: "Nothing asks. A new project starts in this mode; pick one of the others to be asked. The limits below still hold, and each action shows in the log.",
  },
];

/** What every mode keeps, YOLO included. */
export const FLOORS = "In every mode: no moving money or trading, no passwords or keys sent out, spending always asks you, and nothing that would wipe the computer.";

/** Why one action ran without asking: the checker's reason, or YOLO. */
export const logWhy = (e: AutoApproved): string => (e.by === "yolo" ? "YOLO: nothing asks" : e.reason === undefined ? "The checker let it through" : `Checker: ${e.reason}`);
