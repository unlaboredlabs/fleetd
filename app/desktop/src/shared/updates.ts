// The app's own update, as main's updater (src/main/updater.ts) reports it to the page, and the pure rules both
// sides share: which release notes are new to this version, and how a version reads.

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
  | { readonly kind: "available"; readonly version: string; readonly notes: readonly string[]; readonly percent: number | null; readonly restart: boolean }
  /** Downloaded: a restart installs it (and so does the next quit). */
  | { readonly kind: "ready"; readonly version: string; readonly notes: readonly string[] }
  /** The deb: found, to download and install by hand. */
  | { readonly kind: "manual"; readonly version: string; readonly notes: readonly string[] }
  /** The check or the download failed; `reason` is one plain sentence. */
  | { readonly kind: "failed"; readonly during: "check" | "download"; readonly reason: string };

export interface UpdatesState {
  /** The running app's version. */
  readonly current: string;
  readonly app: AppUpdate;
}

/** One line of release.json's `changes`: the release that first shipped it, and a plain sentence. */
export interface Change {
  readonly version: string;
  readonly text: string;
}

/** Notes shown at most; release.json keeps more. */
export const MAX_NOTES = 10;

const withoutBuild = (version: string): string => version.trim().replace(/^v/u, "").split("+", 1)[0] ?? "";

/**
 * What's new since `mine`: release.json's changes are newest first, so take them until the first one this version
 * already shipped. A version not in the list is older than all of it: everything is new then.
 */
export const notesSince = (changes: readonly Change[], mine: string): string[] => {
  const own = withoutBuild(mine);
  const out: string[] = [];
  for (const change of changes) {
    if (withoutBuild(change.version) === own) break;
    out.push(change.text);
    if (out.length === MAX_NOTES) break;
  }
  return out;
};

const NIGHTLY = /^(\d+\.\d+\.\d+)-nightly\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/u;

/**
 * A version as people read it: no build hash, and a nightly by its date ("0.6.0 nightly, Oct 22, 10:30"), since its
 * minute stamp is what tells two nightlies apart. `timeZone` is for tests; the app shows local time.
 */
export const versionLabel = (version: string, timeZone?: string): string => {
  const bare = withoutBuild(version);
  const nightly = NIGHTLY.exec(bare);
  if (nightly === null) return bare;
  const [, base, y, mo, d, h, mi] = nightly;
  const at = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  if (Number.isNaN(at.getTime())) return bare;
  const when = at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  return `${base ?? bare} nightly, ${when}`;
};
