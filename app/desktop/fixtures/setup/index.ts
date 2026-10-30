// The hub admin's setup (screens/setup): a hub `fleetd init` just made on devbox, plain HTTP on its tailnet, at each
// point of its first run. Every answer is the hub's own: steps.json is hub/setup's catalog read from the checks the
// doctor reports at that point, written by `FLEETD_WRITE_FIXTURES=1 cargo test -p fleetd --lib hub::setup::fixtures`
// (crates/fleetd/src/hub/setup/fixtures.rs), so the app shows exactly what a hub says. Each fixture answers setup_list,
// setup_test of any step (as the next point finds it) and setup_skip both ways; hub_info makes this app's person an
// admin, who alone sees setup.
import { Fixture, PROTOCOL } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject } from "../kit/json.ts";
import steps from "./steps.json" with { type: "json" };

type Reads = Readonly<Record<string, JsonObject>>;
interface Scenario {
  readonly requiredLeft: number;
  readonly list: Reads;
  readonly tests: Reads;
  readonly skips: Reads;
  readonly unskips: Reads;
}

const guides = steps.guides as unknown as ReadonlyArray<JsonObject & { readonly id: string }>;
const scenarios = steps.scenarios as unknown as Readonly<Record<string, Scenario>>;

/** A step's guide with what a read says of it. */
const step = (id: string, read: JsonObject | undefined): JsonObject => {
  const guide = guides.find((g) => g.id === id);
  if (guide === undefined || read === undefined) throw new Error(`fixtures/setup: no step ${id}`);
  return { ...guide, ...read };
};

const NOTES: Readonly<Record<string, string>> = {
  "setup-fresh": "A hub fleetd init just made on devbox: the hub and devbox up, Claude and GitHub to do (devbox's claude logged out), the rest optional.",
  "setup-claude-logins": "Claude done the plain way: no hub key, devbox's own claude logged in.",
  "setup-github": "Claude done with the hub's API key; GitHub is next, and its Test finds gh logged in on the hub.",
  "setup-done": "Everything required and GitHub done; people put off for later.",
};

export default defineGroup({
  fixtures: (base) =>
    Object.entries(scenarios).map(([name, sc]) => {
      const f = Fixture.from(base("empty"), name, NOTES[name] ?? name);
      f.state = { phase: "live", hub: steps.hub, protocol: PROTOCOL };
      f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: true });
      f.answer("setup_list", undefined, {
        steps: guides.map((g) => step(g.id, sc.list[g.id])),
        requiredLeft: sc.requiredLeft,
      });
      for (const [id, read] of Object.entries(sc.tests)) f.answer("setup_test", { step: id }, { step: step(id, read) }, 600);
      for (const [id, read] of Object.entries(sc.skips)) f.answer("setup_skip", { step: id, skipped: true }, { step: step(id, read) });
      for (const [id, read] of Object.entries(sc.unskips)) f.answer("setup_skip", { step: id, skipped: false }, { step: step(id, read) });
      return f;
    }),
});
