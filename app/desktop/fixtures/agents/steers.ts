// Steers and their receipts, as order_get (its `steers`) and steer_send answer them: the agents-work agent's (one receipt per
// stage across agents-work and agents-steers) and the lead composer's ⌘Enter (fixtures/composer). QA types the words.
import type { Fixture } from "../kit/fixture.ts";
import { at } from "../kit/ids.ts";
import { obj } from "../kit/stress.ts";
import type { JsonObject } from "../kit/json.ts";
import { AGENT } from "./route.ts";

export const STEER_WORDS = {
  agent: "Keep the old date helper exported until the email templates move.",
  leadNow: "Stop the public link work; ship the card first.",
  /** composer-steers: acknowledged, between the lead's question and your answer. */
  leadLink: "Make the public link expire after seven days.",
} as const;

export const steer = (now: string, n: number, target: JsonObject, stage: string, text: string, agoS: number, more: JsonObject = {}): JsonObject => ({
  id: `S${String(n)}`,
  target,
  workstreamId: typeof target["workstreamId"] === "string" ? target["workstreamId"] : "W1",
  thread: { machineId: AGENT.machineId, threadId: AGENT.threadId },
  runId: `run-s${String(n)}`,
  by: { kind: "human", keyName: "laptop" },
  mode: "queue",
  text,
  stage,
  queuedAt: at(now, -agoS * 1000),
  ...more,
});

const T1 = { taskId: AGENT.laneId };

/** W1's order_get lists these as its steers, newest first. */
export const withSteers = (f: Fixture, steers: JsonObject[]): void => {
  f.update("order_get", (out, input) => (obj(input)["workstreamId"] === "W1" ? { ...obj(out), steers } : out));
};

/** Newest first, as order_get lists them: a steer still queued (Withdraw), one delivered, one acknowledged. */
export const agentSteers = (now: string): JsonObject[] => [
  steer(now, 6, T1, "queued", "When the tests pass, open the PR as a draft.", 20),
  steer(now, 5, T1, "delivered", "Use the store’s zone from the order, not the browser’s.", 300, { mode: "now", deliveredAt: at(now, -299_000), how: "stopped", stoppedTool: "pnpm test" }),
  steer(now, 4, T1, "acknowledged", "Cover de-DE too.", 700, {
    deliveredAt: at(now, -690_000),
    how: "boundary",
    ackedAt: at(now, -680_000),
    ackExcerpt: "Adding de-DE to the receipt date tests next, beside en-US and en-GB.",
  }),
  // A lead's own steer to its agent is the lead's, not yours: never shown here.
  { ...steer(now, 3, T1, "acknowledged", "Rebase on main first.", 800), by: { kind: "lead" } },
];

/** The other ways a steer ends: never replied to, taken back, refused by the agent's computer, expired. */
export const troubleSteers = (now: string): JsonObject[] => [
  steer(now, 9, T1, "unacknowledged", "Leave the old helper in place for now.", 60, { deliveredAt: at(now, -59_000), how: "turn" }),
  steer(now, 8, T1, "withdrawn", "Skip the de-DE tests.", 400),
  steer(now, 7, T1, "failed", "Print the zone name after the date.", 900, { detail: "the node refused the message: thread is closed" }),
];
