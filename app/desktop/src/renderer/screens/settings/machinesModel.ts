// The words of Administration's machine roles, pure so they are tested on their own: a machine's roles as one
// choice, its session slots as a line, and what it can host, each kind by its name.
import type { HostCheck, MachineRole, MachineRolesEntry, SessionHost } from "../../../shared/contracts";

export type RolesChoice = "agents" | "sessions" | "both";

export const ROLE_CHOICES: ReadonlyArray<{ value: RolesChoice; label: string }> = [
  { value: "agents", label: "Agents" },
  { value: "sessions", label: "Screens" },
  { value: "both", label: "Both" },
];

export const choiceOf = (roles: readonly MachineRole[]): RolesChoice =>
  roles.includes("agents") && roles.includes("sessions") ? "both" : roles.includes("sessions") ? "sessions" : "agents";

export const rolesOf = (choice: RolesChoice): MachineRole[] => (choice === "both" ? ["agents", "sessions"] : [choice]);

/** What the choice means, under the control. */
export const ROLE_HELP: Readonly<Record<RolesChoice, string>> = {
  agents: "Runs agents. Their browser and device screens run on a machine that hosts screens.",
  sessions: "Hosts browser and device screens for agents on any machine, and runs no agents.",
  both: "Runs agents and hosts screens, its own agents' first.",
};

/** "2 of 4 screens now (auto: 8 CPUs, 16 GB)"; "set" reads as "you set it". */
export const sessionsLine = (m: MachineRolesEntry): string => {
  const why = m.maxSessionsWhy === "set" ? "you set it" : m.maxSessionsWhy;
  return `${m.sessionsLive} of ${m.maxSessions} ${m.maxSessions === 1 ? "screen" : "screens"} now (${why})`;
};

const HOST_NAME: Readonly<Record<string, string>> = {
  browser: "Browser",
  android: "Android emulator",
  ios: "iOS simulator",
  desktop: "Desktop",
};

export const hostName = (host: SessionHost): string => HOST_NAME[host] ?? host;

/** The kinds it can host first, then the rest, each in the hub's order. */
export const hostsInOrder = (hosts: readonly HostCheck[]): HostCheck[] => [...hosts.filter((h) => h.ready), ...hosts.filter((h) => !h.ready)];

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
