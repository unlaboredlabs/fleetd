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

/**
 * This computer as main reads it (src/main/joinHere.ts thisComputer): what its fleetd dir holds (a hub's home, a node
 * already enrolled with a hub under whatever id, or neither), and its fingerprint, a hash of the OS's id for it
 * (crates/fleetd/src/fingerprint.rs), which hub_info gives for the hub's own computer. Only "none" is ever joined from
 * the app.
 */
export type ThisComputer = (
  | { readonly kind: "hub" }
  | { readonly kind: "node"; readonly machineId: string; readonly hub: string }
  | { readonly kind: "none" }
) & { readonly fingerprint?: string };
