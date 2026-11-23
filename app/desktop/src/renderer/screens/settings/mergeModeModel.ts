// How a bot's PRs merge, as Settings › Bot shows it (MergeMode.tsx) next to Who merges: its two picks and their words.
// Pure: the phone app takes it too (app/mobile/src/desktop.ts).
import type { MergeMode, MergeShared, ProjectSummary } from "../../../shared/contracts";

export const MERGE_MODES: readonly { readonly value: MergeMode; readonly label: string }[] = [
  { value: "test_first", label: "Test, then merge" },
  { value: "verify_after", label: "Merge, then verify" },
];

/** How the bot's PRs merge: an older hub says nothing, and its train batches them. */
export const mergeModeOf = (summary: Pick<ProjectSummary, "mergeMode"> | undefined): MergeMode => (summary?.mergeMode === "verify_after" ? "verify_after" : "test_first");

/** "Web", "Web and Docs", "Web, Docs and Shop". */
const names = (bots: readonly string[]): string => (bots.length <= 1 ? (bots[0] ?? "") : `${bots.slice(0, -1).join(", ")} and ${bots[bots.length - 1]}`);

/** The line under How it merges while other bots share its repo: one merge train, one mode for all of them. */
export const sharedText = (shared: MergeShared): string =>
  `Shared with ${names(shared.bots)} (same repo): a change here changes it there too.`;

/** The fix after the up-to-date line where fleetd can't turn it off, and where the person can't. */
export const OFF_ON_GITHUB = 'An admin of the repo turns off "Require branches to be up to date" on GitHub.';
export const ASK_ADMIN = "Ask a hub admin to turn it off.";

/** The line under How it merges for an up-to-date rule: what it means, then the fix unless an admin has Turn off. */
export const upToDateText = (rule: { line: string; canTurnOff: boolean }, admin: boolean): string =>
  !rule.canTurnOff ? (rule.line.includes("organization") ? rule.line : `${rule.line} ${OFF_ON_GITHUB}`) : admin ? rule.line : `${rule.line} ${ASK_ADMIN}`;

/** What each pick means, in the words both apps' explanations use. */
export const MERGE_MODE_WORDS: Readonly<Record<MergeMode, string>> = {
  test_first: "Ready PRs merge in batches whose combined code passed CI first, so main stays green. One red PR in a batch sends the others through one at a time.",
  verify_after:
    "Each reviewed PR merges as soon as its own CI passes on the latest main, up to 4 at once unless the repo sets another number, so a slow or red PR holds up no other. If main then goes red, fleetd finds the PR that broke it, reverts it and sends it back to its writer. A test that passes on a rerun is never reverted.",
};
