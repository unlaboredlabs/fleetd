// What the suite runs against: an address, and a way to make a team there. A hub build started on a home is one
// target (hubBuild.ts: a self-hosted hub is one team); the stand-in the two-team cases are proven on is another
// (standIn.ts); a service that hosts many teams brings its own as a module (`--target`, README.md). Types only, and
// nothing imported: fleetd's own tests read this file too.

export type KeyRole = "read" | "operate" | "admin";

export interface Team {
  /** Where the team's hub answers: `http(s)://host[:port]`, no trailing slash. /mcp, /app and /node/link hang off it. */
  readonly url: string;
  /** A new key of the team. `human`: a person's device key, which /app takes; the team's owner makes it. */
  readonly key: (opts: { readonly name: string; readonly role: KeyRole; readonly human?: boolean }) => Promise<string>;
  /** A join code for a machine called `machineId`: what `fleetd node join --token` takes. */
  readonly enrol: (machineId: string) => Promise<string>;
  /**
   * `--areas` only: rows no listed tool can make (a task, whose start is a lead call; a project, on a machine the team
   * knows and that is offline, as one that joined once and went away is). The target makes them, `times` of each,
   * `mark` in every text.
   */
  readonly seed?: (mark: string, times: number) => Promise<void>;
  /** The hub's process, when the target started one here (the benches measure it). */
  readonly pid?: number;
}

export interface Target {
  readonly name: string;
  /** How many teams it can make. A hub build makes one; the two-team cases need two. */
  readonly teams: number;
  /** Makes a team. `dir` is the run's scratch dir, for a target that keeps the team on disk. */
  readonly team: (dir: string) => Promise<Team>;
  /** Stops what it started, by the PIDs it captured. */
  readonly close: () => Promise<void>;
}
