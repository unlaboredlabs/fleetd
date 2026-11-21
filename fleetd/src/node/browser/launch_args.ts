// How a session's Chrome is launched and what a launch gives, with nothing of the machine's: its flags (DevTools pipe
// on fds 3 and 4, no debugging port), a kept profile's preferences and what it doesn't keep. The node's launch and
// pool are ./chrome.ts; a hosted box's Chrome is ../place/box_chrome.ts.
import type { Cdp } from "./cdp.ts";
import { HEIGHT, WIDTH } from "./session.ts";

/** Chrome's flags for a session on `profile`: its pipe, no first-run, background or sync work, `extra`, then a blank page. */
export function args(chrome: string, profile: string, sandboxed: boolean, extra: string[] = []): string[] {
  const out = [
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=Translate,AutofillServerCommunication,PasswordManagerOnboarding",
    "--password-store=basic",
    "--use-mock-keychain",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
    `--window-size=${WIDTH},${HEIGHT}`,
    `--user-data-dir=${profile}`,
  ];
  if (!chrome.includes("headless-shell")) out.push("--headless=new");
  if (!sandboxed) out.push("--no-sandbox");
  out.push(...extra, "about:blank");
  return out;
}

/** What a session's browser is: the node's Chrome, or a test's, with its close. */
export type Launched = {
  cdp: Cdp;
  close?: () => Promise<void>;
  alive?: () => boolean;
  lease?: KeptLease;
  /** Where a box's Chrome is, to dial it again after its connection dropped (../place/box_chrome.ts): plain JSON. */
  handle?: ChromeHandle;
};

/** A box's Chrome by its folder, the port on the box's loopback its pipe is reached at, and the bot's kept profile it
 * runs on, if it does. */
export type ChromeHandle = { dir: string; port: number; profile?: string };

/** A project's profile, held by the one browser running on it (or a wipe) until it lets go. */
export type KeptLease = { dir: string; release(): void };

/** What a kept profile doesn't keep, in its `Default` dir: the HTTP and code caches (a page as a site showed it, a
 * filled value it echoed too), history, the session to restore, and the stores of saved passwords and form entries.
 * Sign-ins live in its cookies and site storage, which stay. */
export const NOT_KEPT = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Sessions",
  "Current Session",
  "Current Tabs",
  "Last Session",
  "Last Tabs",
  "History",
  "History-journal",
  "Visited Links",
  "Top Sites",
  "Top Sites-journal",
  "Favicons",
  "Favicons-journal",
  "Shortcuts",
  "Shortcuts-journal",
  "Network Action Predictor",
  "Network Action Predictor-journal",
  "Web Data",
  "Web Data-journal",
  "Login Data",
  "Login Data-journal",
  "Login Data For Account",
  "Login Data For Account-journal",
];

/** Chrome's preferences for a kept profile: it saves no password or form entry, so a value `fill_credential` typed
 * stays only in the session that typed it, which refuses reading it back (credentials.ts). */
export const KEPT_PREFS = {
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
  profile: { password_manager_enabled: false },
  autofill: { enabled: false, profile_enabled: false, credit_card_enabled: false },
};

/** `over` written into `into`, object by object. */
export function merge(into: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(over)) {
    const was = into[k];
    into[k] =
      v && typeof v === "object" && !Array.isArray(v) && was && typeof was === "object" && !Array.isArray(was)
        ? merge(was as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return into;
}
