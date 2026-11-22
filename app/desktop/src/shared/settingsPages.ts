// The pages of Settings by the names its index shows them (renderer/screens/settings/SettingsSheet.tsx takes its
// labels from here), and a check that a "Settings › …" path written for a person (the hub's errors and fixes, the
// apps' own lines) names pages that exist. fleetd/test/settings_paths.test.ts runs it over the hub's sources and
// settingsPages.test.ts over the apps'.

/** You: each person's own pages. */
export const YOU_PAGES = { general: "General", accounts: "Accounts", vault: "Vault", memory: "Memory", hubs: "Hubs & devices" } as const;

/** The admins' group: Hub on a self-hosted hub, Team on a fleetd cloud team. */
export const HUB_PAGES = { people: "People", machines: "Machines", billing: "Billing", everyBot: "Every bot", setup: "Setup" } as const;

/** The rows of Accounts. */
export const ACCOUNT_ROWS = ["Claude", "GitHub", "1Password"] as const;

/** What may follow "Settings › ": You's pages and the groups (a bot's pages are said as "the bot's Settings › …"). */
const FIRST = [...Object.values(YOU_PAGES), "Bots", "Hub", "Team"];
const UNDER: Readonly<Record<string, readonly string[]>> = { Accounts: ACCOUNT_ROWS, Hub: Object.values(HUB_PAGES), Team: Object.values(HUB_PAGES) };

/** Another place's Settings, not fleetd's: macOS's, a GitHub organisation's, a bot's own pages. */
const ELSEWHERE = /(System|organisation's|organization's|bot's|project's|repo's)\s+$/iu;

/**
 * Each "Settings › …" path in `text` that names a page fleetd's Settings doesn't have, as written. A path's first
 * part is one of FIRST; under Accounts, Hub and Team, the next part (when there is one) is one of theirs.
 */
export function settingsPathProblems(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/Settings › /gu)) {
    const at = m.index;
    if (ELSEWHERE.test(text.slice(Math.max(0, at - 20), at))) continue;
    const rest = text.slice(at + m[0].length);
    // The phone's own Settings app (Settings › fleetd › Camera), and a page named as the code runs.
    // A path a line break cuts (its string goes on in the next line's) is read no further.
    if (rest.startsWith("fleetd › ") || rest.startsWith("${") || /^\s*["'`]/u.test(rest) || rest.trim() === "") continue;
    const first = FIRST.filter((p) => rest.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const shown = `Settings › ${rest.slice(0, 40).split(/[\n"`]/u)[0] ?? ""}`;
    if (first === undefined) {
      out.push(shown);
      continue;
    }
    const after = rest.slice(first.length);
    const under = UNDER[first];
    if (under === undefined || !after.startsWith(" › ")) continue;
    const next = after.slice(3);
    if (!next.startsWith("${") && !/^\s*["'`]/u.test(next) && next.trim() !== "" && !under.some((p) => next.startsWith(p))) out.push(shown);
  }
  return out;
}

/** The lines of a source file a person may read: comments are left out. */
export const readableLines = (source: string): string[] => source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line));
