// The hub shapes these screens read: E1's generated contracts, plus the event types that belong to one add.
export type {
  CloneProgressData,
  CloneTarget,
  EventsWaitOutput,
  HubEvent,
  LoginLimit,
  Machine,
  MachineLive,
  ProjectAddFailedData,
  ProjectAddInput,
  ProjectAddOutput,
  ProjectAddedData,
  ProjectDiscoverOutput,
  ProjectInspect,
  ProjectInspectOutput,
  ProjectProblem,
  ProjectSummary,
  SleptSpan,
  SlotState,
} from "../../../shared/contracts";

export const ADD_EVENTS = ["project.clone_progress", "project.added", "project.add_failed"] as const;
