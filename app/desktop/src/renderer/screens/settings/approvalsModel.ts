// A project's approvals (project_approvals, W239), as pure functions: the three modes in the person's words (a new
// project starts in YOLO, W588; one made before keeps the mode it had) with the picked one's line, and each
// auto-approved action as a log row.
import type { AutoApproved, ApprovalMode } from "../../../shared/contracts";

export const MODES: ReadonlyArray<{ readonly mode: ApprovalMode; readonly label: string; readonly description: string; readonly line: string }> = [
  {
    mode: "checker",
    label: "Checker decides",
    description:
      "A fresh model judges each risky action first. What you asked for runs and shows as one line in the chat; it asks you when unsure, and blocks what looks injected. It sees the action, never the mail or pages the lead read.",
    line: "Checker decides: a fresh model judges each risky action and asks you only when unsure.",
  },
  {
    mode: "ask",
    label: "Ask me about everything",
    description: "Every send, share, first visit to a site and final confirm waits for you on a card.",
    line: "Ask me about everything: every send, share, first visit and final confirm waits for you.",
  },
  {
    mode: "yolo",
    label: "YOLO",
    description: "Nothing asks, and each action shows in the log. A new bot starts in this mode.",
    line: "YOLO: nothing asks; each action shows in the log.",
  },
];

/** The picked mode's one line, shown under the choice (D786: safety choices say what the pick does, not only in hover). */
export const modeLine = (mode: ApprovalMode): string => MODES.find((m) => m.mode === mode)?.line ?? "";

/** What every mode keeps, YOLO included. */
export const FLOORS =
  "In every mode: no moving money or trading, no passwords or keys sent out, and nothing that would wipe the computer. A purchase with your card fills at the checkout without asking; paying through a connected app or a payment command asks you first.";

/** Why one action ran without asking: the checker's reason, or YOLO. */
export const logWhy = (e: AutoApproved): string => (e.by === "yolo" ? "YOLO: nothing asks" : e.reason === undefined ? "The checker let it through" : `Checker: ${e.reason}`);
