// The agents' Mac's setup as rows, for `fleetd init` run again on it: the same node files the app's setup window reads
// (mac-link.json and mac-health.json, app/desktop/src/renderer/screens/macSetup/model.ts), so the terminal and the app
// say the same. A step only the person can do points at the app's window, where its button is.
import { readHealth, readLink } from "./common.ts";

export type Row = { title: string; state: "done" | "waiting" | "needs_you" | "failed"; detail: string; fix?: string };

/** A link still dialing after this long, or lost for this long, is said as not reached. */
export const STALL_MS = 20_000;

const IN_APP = "In the fleetd app on this Mac, press Allow next to it";

/** What only the person does, in the app's setup window: the two grants and macOS's screen capture prompt. */
const PERSON = new Set(["accessibility", "screen_recording", "screen_capture"]);

/** Each check's name as the app's setup window shows it (app/desktop/src/renderer/screens/macSetup/model.ts checkTitle). */
const TITLES: Readonly<Record<string, string>> = {
  standard_user: "Account",
  other_homes: "Other users' files",
  no_apple_id: "Apple ID",
  no_secure_token: "FileVault",
  developer: "Developer tools access",
  xcode: "Xcode",
  ios_runtime: "iOS simulator runtime",
  accessibility: "Accessibility",
  screen_recording: "Screen Recording",
  screen_capture: "Screen capture",
  gui_session: "Login on screen",
  keep_awake: "Stays awake",
  screen_lock: "Screen lock",
  tools: "Agent tools",
};

/** The rows for the node at `home`: the hub link first, then each check the node ran. */
export function setupRows(home: string, hubName: string, now = Date.now()): Row[] {
  const link = readLink(home);
  const rows: Row[] = [];
  if (link === undefined) rows.push({ title: "Node", state: "waiting", detail: "starting" });
  else if (link.state === "linked") rows.push({ title: `Linked to ${hubName}`, state: "done", detail: "linked" });
  else if (link.state === "refused") {
    rows.push({
      title: `Linked to ${hubName}`,
      state: "failed",
      detail: `${hubName} refused this Mac: ${link.why ?? "no reason given"}`,
      fix: "On your main machine, open Add machine › A Mac for agents, and type its code in the fleetd app on this Mac",
    });
  } else if (now - link.since > STALL_MS) {
    rows.push({
      title: `Linked to ${hubName}`,
      state: "failed",
      detail: `${hubName} isn't answering this Mac`,
      fix: `Check this Mac is on ${hubName}'s network and that the workspace runs`,
    });
  } else rows.push({ title: `Linked to ${hubName}`, state: "waiting", detail: "linking" });
  for (const check of readHealth(home)?.health.checks ?? []) {
    const title = TITLES[check.id] ?? check.id.replace(/_/gu, " ").replace(/^./u, (c) => c.toUpperCase());
    if (check.state === "ok") rows.push({ title, state: "done", detail: check.message });
    else if (PERSON.has(check.id)) {
      // Screen capture waits for Screen Recording until that's on: nothing to do for it yet.
      if (check.state === "unknown") rows.push({ title, state: "waiting", detail: check.message });
      else rows.push({ title, state: "needs_you", detail: check.message, fix: IN_APP });
    } else rows.push({ title, state: check.state === "fail" ? "failed" : "waiting", detail: check.message, ...(check.fix ? { fix: check.fix } : {}) });
  }
  return rows;
}
