import type { CallOutcome, HubFrame } from "../../../shared/hub";

/** The two things the screen needs from main; `window.fleetd.hub` in the app, a fixture in tests and the gallery. */
export interface TimeClient {
  call(tool: string, input: unknown): Promise<CallOutcome>;
  subscribe(listener: (frame: HubFrame) => void): () => void;
}
