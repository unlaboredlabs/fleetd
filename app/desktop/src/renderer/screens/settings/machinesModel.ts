// The words of Hub › Machines' roles, pure so they are tested on their own: a machine's roles as one
// choice, and its session slots as a line.
import type { MachineRole, MachineRolesEntry } from "../../../shared/contracts";

export type RolesChoice = "agents" | "sessions" | "both";

export const ROLE_CHOICES: ReadonlyArray<{ value: RolesChoice; label: string }> = [
  { value: "agents", label: "Agents" },
  { value: "sessions", label: "Screens" },
  { value: "both", label: "Both" },
];

export const choiceOf = (roles: readonly MachineRole[]): RolesChoice =>
  roles.includes("agents") && roles.includes("sessions") ? "both" : roles.includes("sessions") ? "sessions" : "agents";

export const rolesOf = (choice: RolesChoice): MachineRole[] => (choice === "both" ? ["agents", "sessions"] : [choice]);

/** What the machine does as chosen, the row's title, and the rest of it under that. */
export const ROLE_TITLE: Readonly<Record<RolesChoice, string>> = {
  agents: "Runs agents",
  sessions: "Hosts screens",
  both: "Runs agents and hosts screens",
};
export const ROLE_HELP: Readonly<Record<RolesChoice, string>> = {
  agents: "Their browser and device screens open on a machine that hosts screens.",
  sessions: "Browser and device screens for agents on any machine. It runs no agents.",
  both: "Its own agents' screens come first.",
};

/** A machine's role as a quiet word beside its name in the list, only where it isn't the usual both. */
export const roleWord = (m: Pick<MachineRolesEntry, "roles" | "mac"> | undefined): string | undefined => {
  if (m === undefined) return undefined;
  if (m.mac !== undefined) return "Agents’ Mac";
  const choice = choiceOf(m.roles);
  return choice === "both" ? undefined : choice === "agents" ? "Agents only" : "Screens only";
};

/** "2 of 4 screens now (auto: 8 CPUs, 16 GB)"; "set" reads as "you set it". */
export const sessionsLine = (m: MachineRolesEntry): string => {
  const why = m.maxSessionsWhy === "set" ? "you set it" : m.maxSessionsWhy;
  return `${m.sessionsLive} of ${m.maxSessions} ${m.maxSessions === 1 ? "screen" : "screens"} now (${why})`;
};

/** The session cap's choices: auto, then 1 to 16, and the set value when it is above. */
export const capChoices = (m: MachineRolesEntry): Array<{ value: string; label: string }> => {
  const auto = m.maxSessionsSet === undefined ? m.maxSessions : null;
  const numbers = Array.from({ length: 16 }, (_, i) => i + 1);
  if (m.maxSessionsSet !== undefined && m.maxSessionsSet > 16) numbers.push(m.maxSessionsSet);
  return [{ value: "auto", label: auto === null ? "Auto" : `Auto (${auto})` }, ...numbers.map((n) => ({ value: String(n), label: String(n) }))];
};

/** Why what it can host is unknown, or why other machines' agents can't use it, when either is so. */
export const hostsNote = (m: MachineRolesEntry): string | null => {
  if (!m.roles.includes("sessions")) return null;
  if ((m.hosts ?? []).length === 0) return m.online ? "Hasn't said what it can host yet." : "Offline: what it can host shows once it is back.";
  // The hub says why in plain words: no key to seal to, an older fleetd, or offline.
  if (!m.hostsOthers) return m.hostsOthersNote ?? "It hosts only its own agents' screens.";
  return null;
};
