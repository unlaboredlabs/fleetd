// The time inspector's answers (time_spans, time_breakdown, time_insights, thread_window) for the shared fixtures:
// W8, a finished order whose lanes tile and whose critical path adds up to its wall, and a week of the fleet with the
// week before for compare. time-heavy gets W8 at ten times the density: about 15k spans, paged 500 at a time.
import { defineGroup } from "../kit/group.ts";
import type { Fixture } from "../kit/fixture.ts";
import type { JsonObject, JsonValue } from "../kit/json.ts";
import { timeCalls, type FixtureOptions } from "../../src/renderer/screens/time/fixture.ts";

const add = (opts: FixtureOptions) => (f: Fixture) => {
  // Ours replace any time answers the kit made, so the order, its pages and its breakdown agree.
  for (const tool of ["time_spans", "time_breakdown", "time_insights", "thread_window"]) f.drop(tool);
  for (const call of timeCalls(opts)) f.answer(call.tool, call.input as JsonObject | undefined, call.outcome.output as JsonValue);
};

export default defineGroup({
  extend: {
    typical: add({}),
    "long-text": add({ gaps: true, long: true }),
    "many-agents": add({ agents: 24 }),
    "time-heavy": add({ dense: true }),
  },
});
