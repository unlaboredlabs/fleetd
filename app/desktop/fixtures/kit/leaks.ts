// What must never be in a fixture file, recorded or generated. `pnpm fixtures` and CI check every file against
// LEAKS; the recording person's own names (private repos, hosts) are a local list in FLEETD_FIXTURE_DENYLIST, kept
// outside the repo since the list itself would say what it hides.
import fs from "node:fs";
import os from "node:os";

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Patterns no fixture may contain, whoever built it. */
export const LEAKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u],
  ["an Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{10,}/u],
  ["a Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/u],
  ["a JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u],
  ["a fleetd key", /\bfld_(?!redacted)[a-z2-7]{20,}/u],
  // git@github.com:owner/repo is a remote, not someone's address.
  ["an email address", /(?<![A-Za-z0-9._%+-])(?!git@github\.com\b)[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}\b/u],
  ["a tailnet IPv4 address", /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/u],
  ["a tailnet IPv6 address", /\bfd7a:115c:a1e0:/iu],
  ["a tailnet host", /\.ts\.net\b/iu],
  ["a home directory other than /home/dev", /\/(?:home|Users)\/(?!dev\b)[A-Za-z0-9._-]+/u],
  ["a GitHub repo outside acme", /github\.com[/:](?!acme\/)[A-Za-z0-9-]+\/[A-Za-z0-9._-]+/iu],
  ["a repo outside acme", /"(?:repo|fullName|nameWithOwner)": ?"(?!acme\/)[A-Za-z0-9-]+\/[A-Za-z0-9._-]+"/u],
  ["the lab", /fleetd-lab|fleetd-testbed|unlaboredlabs/iu],
];

/** This machine's user and host, and FLEETD_FIXTURE_DENYLIST's words: local, so only checked where they are set. */
export const localWords = (): Array<readonly [string, RegExp]> => {
  // A CI runner's user and host are generic words ("runner") that fixtures may well contain.
  const words = process.env["CI"] === undefined ? [os.userInfo().username, os.hostname()] : [];
  const file = process.env["FLEETD_FIXTURE_DENYLIST"];
  if (file !== undefined) words.push(...fs.readFileSync(file, "utf8").split("\n"));
  return words
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && w !== "dev")
    .map((w) => ["a denylisted word", new RegExp(`(?<![A-Za-z0-9])${escape(w)}(?![A-Za-z0-9])`, "iu")] as const);
};

/** Every leak in `text`, as "<what>: …context…", using LEAKS plus the local words. */
export const findLeaks = (text: string): Array<string> =>
  [...LEAKS, ...localWords()].flatMap(([what, pattern]) => {
    const hit = pattern.exec(text);
    return hit === null ? [] : [`${what}: "${text.slice(Math.max(0, hit.index - 40), hit.index + 40).replaceAll("\n", " ")}"`];
  });

export const assertClean = (name: string, text: string): void => {
  const leaks = findLeaks(text);
  if (leaks.length > 0) throw new Error(`${name} leaks ${leaks.join("; ")}`);
};
