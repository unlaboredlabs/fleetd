// The app's own update, as main's updater (src/main/updater.ts) reports it to the page, and the pure rules both
// sides share: what's new since a version, and how a version reads.
import { compareVersions } from "./pairing";

/** The deb's asset name: it can't update itself (dpkg needs root), so the app offers it and the command. */
export const DEB = "fleetd-desktop-linux-amd64.deb";
export const DEB_INSTALL = `sudo apt install ./${DEB}`;

export type AppUpdate =
  /** A development or test build: nothing to update to. */
  | { readonly kind: "unsupported" }
  /** Not checked yet. */
  | { readonly kind: "idle" }
  /** A check someone asked for (the menu, the palette); background checks never show this. */
  | { readonly kind: "checking" }
  | { readonly kind: "current" }
  /**
   * Found and downloading in the background. `percent` is null until the download reports; `restart` is set once
   * the person chose "Update and restart", so the app restarts the moment the download is in.
   */
  | { readonly kind: "available"; readonly version: string; readonly percent: number | null; readonly restart: boolean }
  /** Downloaded: a restart installs it (and so does the next quit). */
  | { readonly kind: "ready"; readonly version: string }
  /** The deb: found, to download and install by hand. */
  | { readonly kind: "manual"; readonly version: string }
  /** The check or the download failed; `reason` is one plain sentence. */
  | { readonly kind: "failed"; readonly during: "check" | "download"; readonly reason: string };

/** One entry of the channel's changes.json (.github/release/changes.sh): a first-parent commit on main. */
export interface Change {
  readonly commit: string;
  readonly date: string;
  /** A merged PR's title and number, or `batch: a (#1); b (#2)` for several. */
  readonly subject: string;
  /** "app", "hub" or "other", by the paths it touched. */
  readonly areas: readonly string[];
}

/** What main read from the channel's release files after a check; null until a check has read them. */
export interface Release {
  /** changes.json, newest first, as many as main keeps (MAX_CHANGES). */
  readonly changes: readonly Change[];
  /** release.json's `cliVersion`: the newest fleetd CLI and hub on the channel. */
  readonly cli: string | null;
  /** release.json's `appVersion`: the newest desktop app on the channel. */
  readonly app: string | null;
}

export interface UpdatesState {
  /** The running app's version. */
  readonly current: string;
  readonly app: AppUpdate;
  readonly release: Release | null;
}

/** changes.json entries main keeps: enough to find a version a few days old, small enough to push to the page. */
export const MAX_CHANGES = 100;
/** Lines shown at most. */
export const MAX_NOTES = 10;

export interface Notes {
  /** Plain lines, newest first. */
  readonly lines: readonly string[];
  /** There is more than the lines: cut at MAX_NOTES, or `mine` isn't in the list, which may go further back. */
  readonly more: boolean;
}

/** The `+sha7` build part of a version, lower case; null for a version without one (a development build). */
export const buildCommit = (version: string): string | null => {
  const sha = /\+([0-9a-f]{7,40})$/iu.exec(version.trim())?.[1];
  return sha === undefined ? null : sha.toLowerCase();
};

/**
 * A subject as people read it, one line per PR: `batch: a (#1); b (#2)` splits, and each loses its conventional
 * prefix ("fix(cli): ") and PR number. Merge commits say nothing to a person and give no line.
 */
export const subjectLines = (subject: string): string[] => {
  const batch = /^batch:\s*/u.test(subject);
  const parts = batch ? subject.replace(/^batch:\s*/u, "").split(/;\s+/u) : [subject];
  return parts
    .filter((part) => !/^merge\b/iu.test(part))
    .map((part) =>
      part
        .replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/u, "")
        .replace(/\s*\(#\d+\)$/u, "")
        .trim(),
    )
    .filter((line) => line !== "")
    // "fleetd" stays lower case, as the product's name.
    .map((line) => (/^fleetd\b/u.test(line) ? line : line.charAt(0).toUpperCase() + line.slice(1)));
};

/**
 * What's new since `mine` in `area` ("app" or "hub"): the changes newer than the commit `mine` was built from
 * (its `+sha7`). A version without one, or one older than the list, gets the newest lines and `more`.
 */
export const notesSince = (changes: readonly Change[], mine: string, area: string): Notes => {
  const sha = buildCommit(mine);
  const lines: string[] = [];
  for (const change of changes) {
    if (sha !== null && change.commit.toLowerCase().startsWith(sha)) return { lines, more: false };
    if (!change.areas.includes(area)) continue;
    for (const line of subjectLines(change.subject)) {
      if (lines.length === MAX_NOTES) return { lines, more: true };
      lines.push(line);
    }
  }
  return { lines, more: lines.length > 0 };
};

/**
 * A version that says what build it is: parses, and isn't the bare 0.0.0 of a local build or of a hub from before it
 * reported its version (an untagged nightly is 0.0.0-nightly.<stamp>, which is known). Anything else is unknown,
 * and nothing is flagged on a guess.
 */
export const knownVersion = (version: string | null | undefined): version is string =>
  version !== null && version !== undefined && (compareVersions(version, "0.0.0") ?? 0) !== 0;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** A hub on this computer: its URL's host is loopback. Only such a hub gets "Run in Terminal". */
export const localHub = (hubUrl: string): boolean => URL.canParse(hubUrl) && LOOPBACK.has(new URL(hubUrl).hostname);

const withoutBuild = (version: string): string => version.trim().replace(/^v/u, "").split("+", 1)[0] ?? "";

const NIGHTLY = /^\d+\.\d+\.\d+-nightly\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/u;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A version as people read it. A nightly by when it was built and from which commit, since its minute stamp is what
 * tells two nightlies apart: `0.0.0-nightly.202610261056+1b563d7` reads "Nightly · Oct 26, 10:56 UTC · 1b563d7".
 * Any other version is itself, without a build part. Only for showing: the updaters compare the raw version, and the
 * raw version is what gets copied. The CLI's twin is `crate::version_label` (crates/fleetd/src/lib.rs).
 */
export const versionLabel = (version: string): string => {
  const bare = withoutBuild(version);
  const nightly = NIGHTLY.exec(bare);
  const month = MONTHS[Number(nightly?.[2]) - 1];
  if (nightly === null || month === undefined) return bare;
  const [, , , d, h, mi] = nightly;
  const sha = buildCommit(version);
  return ["Nightly", `${month} ${String(Number(d))}, ${h ?? ""}:${mi ?? ""} UTC`, ...(sha === null ? [] : [sha.slice(0, 7)])].join(" · ");
};

/**
 * The About panel's version fields: the label, then the raw version to copy. Without them macOS shows Info.plist's,
 * which carry only the numeric 0.0.0 Apple accepts there (build-release.yml), so a nightly read "0.0.0 (0.0.0)".
 * macOS puts `version` in parentheses; Linux has only `applicationVersion` and gets both there.
 */
export const aboutVersions = (version: string, mac: boolean): { applicationVersion: string; version?: string } => {
  const label = versionLabel(version);
  const raw = version.trim();
  if (mac) return { applicationVersion: label, version: raw };
  return { applicationVersion: label === raw ? raw : `${label} (${raw})` };
};
