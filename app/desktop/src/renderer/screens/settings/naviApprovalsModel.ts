// A Navi's approvals (navi_approvals, W239), as pure functions: the three modes in the person's words, the checker's
// model and effort as the picker shows them, and each auto-approved action as a log row.
import type { AutoApproved, NaviApprovalMode, NaviApprovals, ProfileModel } from "../../../shared/contracts";
import { EFFORT_WORD } from "./profilesModel";

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
    description:
      "No checker runs and nothing asks: not for a recipient or site only an email or a page named, a public share, a forwarding rule or a link carrying data. The limits below still hold. Each action still shows in the chat and in the log below.",
  },
];

/** What every mode keeps, YOLO included. */
export const FLOORS =
  "In every mode, YOLO too: moving money, trading and placing orders are refused, and so is a password, key or token in anything it sends or any link it opens; payments, and a site whose link says money or trading, always ask you; and a command that would wipe the computer never runs.";

/** The models to pick from: the hub's list, and the checker's current one when the list lacks it. */
export const checkerModels = (models: ReadonlyArray<ProfileModel>, current: string): ReadonlyArray<ProfileModel> =>
  models.some((m) => m.id === current) ? models : [...models, { id: current, fast: false }];

/** "Opus 5.5 · high effort", for the line under the mode. */
export const checkerLine = (models: ReadonlyArray<ProfileModel>, a: NaviApprovals): string =>
  `${models.find((m) => m.id === a.model)?.displayName ?? a.model} · ${EFFORT_WORD[a.effort].toLowerCase()} effort${a.defaults ? " (the default)" : ""}`;

/** Why one action ran without asking: the checker's reason, or YOLO. */
export const logWhy = (e: AutoApproved): string => (e.by === "yolo" ? "YOLO: nothing asks" : e.reason === undefined ? "The checker let it through" : `Checker: ${e.reason}`);
