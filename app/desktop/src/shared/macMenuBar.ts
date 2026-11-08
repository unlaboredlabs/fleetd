// The agents' Mac's menu bar (src/main/menuBar.ts): on a Mac joined as the hub's agents' Mac, the app keeps an icon in
// the menu bar for as long as it runs, and its popover says what agents do on this Mac now, how the Mac is, and offers
// Update when it is behind. Main reads what only the Mac knows; the page adds the hub's own (the Mac's screen, the
// agents' and projects' names) when this app is signed in to that hub.
import type { MacFound, MacHealthRead } from "./macSetup";

/** A simulator lent to an agent, as the node writes it (node/mac_tool/activity.rs). */
export interface MacSimActivity {
  /** The agent's folder on the Mac: its task's id, else its session's. */
  readonly agent: string;
  readonly projectId: string;
  readonly device: string;
  readonly sinceMs: number;
}

/** A job an agent runs on the Mac (`mac run`): its builds and tests, most of all. */
export interface MacJobActivity {
  readonly agent: string;
  readonly projectId: string;
  readonly job: number;
  /** Masked of the agent's secrets, as its log is. */
  readonly command: string;
  readonly startedMs: number;
}

export interface MacActivity {
  readonly simulators: ReadonlyArray<MacSimActivity>;
  readonly jobs: ReadonlyArray<MacJobActivity>;
}

/** The disk this Mac's fleetd lives on. */
export interface MacDisk {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/** This Mac's fleetd runs an older build than its hub: the hub's Update brings it level. */
export interface MacBehind {
  readonly macVersion: string;
  readonly hubVersion: string;
  /** Who this app is on the hub: an admin presses Update here; anyone else is told who can. */
  readonly who: "admin" | "member" | "unknown";
}

/** What the popover shows of this Mac, read again every couple of seconds while it is open. */
export interface MacMenuBarRead {
  readonly found: MacFound;
  /** The hub this app is signed in to at the Mac's hub's address, if any: its names, its screen and its Update. */
  readonly hubId: string | null;
  readonly health: MacHealthRead;
  /** Null before the node first wrote it (an older node writes none). */
  readonly activity: MacActivity | null;
  readonly disk: MacDisk | null;
  readonly macBehind: MacBehind | null;
}
