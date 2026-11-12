// A person's screen and the calls that start it, without the hub (screens.ts and calls.ts run them): the waits, a kind's
// host and name, a person's wait for a slot as stored and as shown, and why a machine can't host one.
import type { PersonRef, ProjectRef, ScreenPr, ScreenStage, ScreenWait, SessionHost, SessionKind } from "../../shared/contracts.ts";
import { HOST_NOUN, SCREEN_WAIT_MINUTES } from "../../shared/screens_wire.ts";
import { isoMs } from "../auth/allows.ts";
import { ready, type Runner } from "./placement.ts";

/** How long a start on another machine may take: its pool may have to launch a browser or boot a device. */
export const START_WAIT = 90_000;
/** An agent-device command for a screen elsewhere: the first in a fresh clone starts its runner there. */
export const DEVICE_WAIT = 110_000;
/** Every other call. */
export const CALL_WAIT = 45_000;
/** How long the hub gives a runner to end a start nobody will use. */
export const CANCEL_WAIT = 15_000;

/** How long a person's wait for a slot lasts. */
export const WAIT_MS = SCREEN_WAIT_MINUTES * 60_000;
/** How long a start's answer waits for the runner's report of the screen live, which races it over the link. */
export const RECORD_WAIT = 5_000;
/** How long a PR's build may take to install, the screen's runner starting first included. */
export const INSTALL_WAIT = 300_000;
/** Between tries while the screen's machine holds a command back. */
export const INSTALL_RETRY = 1_000;

export const HOSTS: Record<string, SessionHost> = {
  android: "android",
  ios: "ios",
  linux_desktop: "desktop",
  mac: "mac",
  browser: "browser",
};

export const hostOf = (kind: SessionKind): SessionHost => HOSTS[kind] ?? "browser";

export const WHAT: Record<string, string> = {
  browser: "Browser",
  android: "Android emulator",
  ios: "iOS simulator",
  linux_desktop: "Linux desktop",
  mac: "Agents' Mac",
};

/** What a person's screen is called in the list, in their name, with the PR whose build it has. */
export function purpose(kind: SessionKind, person: PersonRef, pr: ScreenPr | undefined): string {
  const what = WHAT[kind] ?? "Browser";
  return pr ? `${what} opened by ${person.name}, with PR #${pr.number}` : `${what} opened by ${person.name}`;
}

export type Wait = {
  id: string;
  person: string;
  device: string;
  project: ProjectRef;
  runner: string;
  kind: SessionKind;
  sinceMs: number;
  pr: ScreenPr | undefined;
  stage: ScreenStage;
  thread: string | undefined;
  error: string | undefined;
};

export type WaitRow = {
  wait_id: string;
  person_id: string;
  device: string;
  machine_id: string;
  project_id: string;
  runner_id: string;
  kind: string;
  since_ms: number;
  pr_repo: string | null;
  pr_number: number | null;
  stage: string;
  thread_id: string | null;
  error: string | null;
};

export const WAIT_COLUMNS =
  "wait_id, person_id, device, machine_id, project_id, runner_id, kind, since_ms, pr_repo, pr_number, stage, thread_id, error";

export const waitOf = (r: WaitRow): Wait => ({
  id: r.wait_id,
  person: r.person_id,
  device: r.device,
  project: { machineId: r.machine_id, projectId: r.project_id },
  runner: r.runner_id,
  kind: r.kind as SessionKind,
  sinceMs: r.since_ms,
  pr: r.pr_repo !== null && r.pr_number !== null ? { repo: r.pr_repo, number: r.pr_number } : undefined,
  stage: r.stage as ScreenStage,
  thread: r.thread_id ?? undefined,
  error: r.error ?? undefined,
});

export const clip = (text: string, max: number) => ([...text].length <= max ? text : `${[...text].slice(0, max - 1).join("")}…`);

export function asWait(w: Wait, all: Wait[]): ScreenWait {
  let ahead = 0;
  for (const o of all) {
    if (o.id === w.id) break;
    if (o.runner === w.runner && o.stage === "waiting") ahead += 1;
  }
  return {
    waitId: w.id,
    projectRef: w.project,
    kind: w.kind,
    machineId: w.runner,
    since: isoMs(w.sinceMs),
    ahead,
    ...(w.pr ? { pr: w.pr } : {}),
    stage: w.stage,
    ...(w.thread === undefined ? {} : { threadId: w.thread }),
    ...(w.error === undefined ? {} : { error: clip(w.error, 500) }),
  };
}

/** Why `runner` can't host a person's screen of `kind` at all, slots aside; undefined when it can. */
export function unable(r: Runner, host: SessionHost): string | undefined {
  const name = r.name;
  if (!r.sessions) return `${name} hosts no screens: its role is agents only.`;
  if (!r.online) return `${name} is offline.`;
  if (r.othersNote !== undefined) return `${name} can't host it yet. ${r.othersNote}`;
  if (ready(r, host) === true) return undefined;
  const why = r.hosts?.find((h) => h.host === host)?.detail ?? "it hasn't said what it can host";
  return `${name} can't host ${HOST_NOUN[host] ?? host} screen: ${why}.`;
}
