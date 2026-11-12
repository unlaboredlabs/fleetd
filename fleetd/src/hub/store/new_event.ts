// An event on its way into the log, before the log numbers it (events.ts appends it).
import type { HubEvent } from "../../shared/contracts.ts";

export type NewEvent = Omit<HubEvent, "seq">;
