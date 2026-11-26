// Who merges a bot's PRs, as Settings › Bot shows it (WhoMerges.tsx): its two picks, and its risk rules as the text a
// person edits, one rule a line. Pure: the phone app takes it too (app/mobile/src/desktop.ts).
import type { Merger, ProjectSummary } from "../../../shared/contracts";

export const WHO_MERGES: readonly { readonly value: Merger; readonly label: string }[] = [
  { value: "people", label: "You" },
  { value: "fleetd", label: "fleetd" },
];

/** Who merges the bot's PRs: an older hub says nothing, and its train merges them all. */
export const mergesOf = (summary: Pick<ProjectSummary, "merges"> | undefined): Merger => (summary?.merges === "people" ? "people" : "fleetd");

/** What You and fleetd mean, in the words both apps' explanations use. */
export const WHO_MERGES_WORDS: Readonly<Record<Merger, string>> = {
  people: "fleetd reviews its PRs and keeps them up to date, merges only those its rules let merge themselves, and tells you when each other one is ready; you merge it on GitHub.",
  fleetd: "The merge train merges each PR once it is reviewed and green. A PR with the hold label waits for you either way.",
};

/** The picked choice's one line, shown under the choice (D786); the hover keeps the longer words. */
export const WHO_MERGES_LINE: Readonly<Record<Merger, string>> = {
  people: "You: fleetd reviews each PR and keeps it ready; you merge it on GitHub.",
  fleetd: "fleetd: the merge train merges each PR once it's reviewed and green.",
};

/** The rules' explanation: what a rule may be. */
export const RULES_WORDS =
  "One a line: a path such as docs/** or *.sql, or a kind. Merges itself: docs, tests, lockfile-bumps (lockfile-only patch or minor bumps), formatting (blank lines and spaces at a line's end only). Always a person: auth, billing, migrations, infra, ci, secrets.";

/** The rules as lines of text. */
export const rulesText = (rules: readonly string[]) => rules.join("\n");

/** A text's rules: one a line, trimmed, the empty lines dropped. */
export const linesOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
