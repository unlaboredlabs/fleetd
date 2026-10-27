// "This computer" in Add machine (W105): main makes the computer the app runs on a machine of its hub, the way the
// installer's join line does, and reports each step to the page. The one-time code goes from the hub to main and on
// to `fleetd init --join`; it never reaches the page.

export type JoinStepState = "planned" | "running" | "done" | "failed";

export interface JoinStep {
  readonly title: string;
  readonly state: JoinStepState;
  /** The end of what it printed: on failure, and a short line when done. */
  readonly output?: string;
}

export interface JoinHere {
  readonly machineId: string;
  readonly state: "running" | "done" | "failed";
  readonly steps: ReadonlyArray<JoinStep>;
  /** Failed: what went wrong, in a sentence. */
  readonly message?: string;
}
