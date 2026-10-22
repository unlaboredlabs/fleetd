// The first-run checklist: three steps that tick themselves from what the app already knows. Pure, so the order of
// ticks is tested.

export type StepState = "done" | "current" | "todo";

export interface SetupStep {
  readonly id: "connect" | "project" | "hi";
  readonly label: string;
  readonly state: StepState;
}

export interface SetupProgress {
  readonly connected: boolean;
  readonly project: boolean;
  /** Any project's chat has a message in it. */
  readonly saidHi: boolean;
}

const STEPS = [
  { id: "connect", label: "Connect to your hub" },
  { id: "project", label: "Add a project" },
  { id: "hi", label: "Say hi to its lead" },
] as const;

/** Each step is done when its fact is true; the first one that isn't is current. */
export const setupSteps = (progress: SetupProgress): ReadonlyArray<SetupStep> => {
  const done = { connect: progress.connected, project: progress.project, hi: progress.saidHi };
  let current = false;
  return STEPS.map((step) => {
    if (done[step.id]) return { ...step, state: "done" };
    const state: StepState = current ? "todo" : "current";
    current = true;
    return { ...step, state };
  });
};

/** The one-line answer to "what is fleetd?", the welcome's and the empty home's. */
export const TAGLINE = "Each project gets a lead that runs Claude agents for you and asks only what it needs.";

/** What sets fleetd up on this computer: the installer, which runs `fleetd init` when it's done. */
export const SETUP_COMMAND = "curl -fsSL https://fleetd.sh | sh";
