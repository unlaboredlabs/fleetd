// Where Xcode is on the Mac (docs: agents-mac.md#xcode), from what
// `xcode-select -p` says and the Xcodes in /Applications: setup's Xcode check (checks.ts) and the doctor's iOS one
// both say it plainly, with the one command that fixes it, never xcode-select's own error.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { shQuote } from "../../cli/mac_tool.ts";

/** Xcode's page in the App Store app. */
export const APP_STORE = "macappstore://apps.apple.com/app/id497799835";

export type Located =
  /** A full Xcode is selected: its developer directory. */
  | { kind: "selected"; path: string }
  /** An Xcode is in /Applications (its bundle), but `why` it isn't the one selected. */
  | { kind: "unselected"; found: string; why: string }
  /** No Xcode is selected, and none is in /Applications. */
  | { kind: "missing" };

/** From `xcode-select -p` (undefined when it failed), the Xcodes in /Applications (`inApplications`) and whether a path
 * is a directory: a path selected but since removed is no Xcode. */
export function locate(selected: string | undefined, found: string[], isDir: (p: string) => boolean): Located {
  const path = selected?.trim() || undefined;
  let why: string;
  if (path === undefined) why = "no Xcode is selected";
  else if (path.includes("CommandLineTools")) why = "only the Command Line Tools are selected";
  else if (!isDir(path)) why = `xcode-select points at ${path}, which isn't there`;
  else if (path.includes(".app/Contents/Developer")) return { kind: "selected", path };
  else why = `xcode-select points at ${path}, which isn't an Xcode`;
  return found[0] !== undefined ? { kind: "unselected", found: found[0], why } : { kind: "missing" };
}

/** The Xcode bundles in `dir` (`Xcode.app`, `Xcode-beta.app`, `Xcode 26.app`) with a developer directory in them,
 * `Xcode.app` first, then by name. */
export function inApplications(dir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  const found = names
    .filter((n) => n.startsWith("Xcode") && n.endsWith(".app"))
    .map((n) => join(dir, n))
    .filter((p) => {
      try {
        return statSync(join(p, "Contents/Developer")).isDirectory();
      } catch {
        return false;
      }
    });
  return found.sort((a, b) => {
    const [ka, kb] = [!a.endsWith("/Xcode.app"), !b.endsWith("/Xcode.app")];
    return ka !== kb ? Number(ka) - Number(kb) : a < b ? -1 : a > b ? 1 : 0;
  });
}

/** The bundle's name: `Xcode-beta.app`. */
export const name = (bundle: string) => bundle.split("/").pop() ?? bundle;

/** The one command that selects `bundle`, quoted for a name with a space in it. */
export const switchTo = (bundle: string) => `sudo xcode-select -s ${shQuote(`${bundle}/Contents/Developer`)}`;

/** Xcode's licence, then its system components: after a licence, xcodebuild can't say whether the first launch ran. */
export const ACCEPT = "sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch";
export const FIRST_LAUNCH = "sudo xcodebuild -runFirstLaunch";
