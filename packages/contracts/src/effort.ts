import { Schema } from "effect";

// Its own module so model.ts can import tasks.ts, which needs Effort, without a cycle.
export const Effort = Schema.Literals(["low", "medium", "high", "max"]);
export type Effort = typeof Effort.Type;
