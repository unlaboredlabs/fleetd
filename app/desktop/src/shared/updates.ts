// The app's own update, as main's updater (src/main/updater.ts) reports it to the page, and the pure rules both
// sides share: which versions are known, and how a version reads.
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
   * the person chose to update, so the app restarts the moment the download is in.
   */
  | { readonly kind: "available"; readonly version: string; readonly percent: number | null; readonly restart: boolean }
  /** Downloaded: a restart installs it (and so does the next quit). */
  | { readonly kind: "ready"; readonly version: string }
  /** The deb: found, to download and install by hand. */
  | { readonly kind: "manual"; readonly version: string }
  /** The check or the download failed; `reason` is one plain sentence. */
  | { readonly kind: "failed"; readonly during: "check" | "download"; readonly reason: string };

/** What main read from the channel's release files after a check; null until a check has read them. */
export interface Release {
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

/**
 * A version that says what build it is: parses, and isn't the bare 0.0.0 of a local build or of a hub from before it
 * reported its version (an untagged Edge build is 0.0.0-edge.<stamp>, which is known). Anything else is unknown,
 * and nothing is flagged on a guess.
 */
export const knownVersion = (version: string | null | undefined): version is string =>
  version !== null && version !== undefined && (compareVersions(version, "0.0.0") ?? 0) !== 0;

const withoutBuild = (version: string): string => version.trim().replace(/^v/u, "").split("+", 1)[0] ?? "";

/** An Edge build's version; `nightly` is Edge's name until D203, the same series. */
const EDGE = /^\d+\.\d+\.\d+-(?:edge|nightly)\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/u;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A version as people read it. An Edge build by when it was built (UTC), since its minute stamp is what tells two
 * apart: `0.0.0-edge.202610261056+1b563d7` reads "Edge · Oct 26, 10:56", and so does
 * `0.0.0-nightly.202610261056+1b563d7`, from before the rename.
 * Any other version is itself, without a build part. Only for showing: the updaters compare the raw version, and the
 * raw version is what gets copied.
 */
export const versionLabel = (version: string): string => {
  const bare = withoutBuild(version);
  const edge = EDGE.exec(bare);
  const month = MONTHS[Number(edge?.[2]) - 1];
  if (edge === null || month === undefined) return bare;
  const [, , , d, h, mi] = edge;
  return `Edge · ${month} ${String(Number(d))}, ${h ?? ""}:${mi ?? ""}`;
};

/** The hub's and the CLI's longer label, which adds the time zone and the build's commit. */
const LONG_LABEL = /(Edge · [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}) UTC(?: · [0-9a-f]{7})?/gu;

/** A line of the hub's with its Edge labels as this app says them: "Edge · Oct 26, 10:56", no zone and no commit. */
export const shortLabels = (text: string): string => text.replace(LONG_LABEL, "$1");

/**
 * The About panel's version fields: the label, then the raw version to copy. Without them macOS shows Info.plist's,
 * which carry only the numeric 0.0.0 Apple accepts there (build-release.yml), so an Edge build read "0.0.0 (0.0.0)".
 * macOS puts `version` in parentheses; Linux has only `applicationVersion` and gets both there.
 */
export const aboutVersions = (version: string, mac: boolean): { applicationVersion: string; version?: string } => {
  const label = versionLabel(version);
  const raw = version.trim();
  if (mac) return { applicationVersion: label, version: raw };
  return { applicationVersion: label === raw ? raw : `${label} (${raw})` };
};
