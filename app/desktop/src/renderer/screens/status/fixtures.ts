// The status docs inside the transport fixtures (app/desktop/fixtures/status-*.json, FLEETD_FIXTURE=<name>), by
// "<scope>[-<variant>]", for the tests. One source: the screenshots and the tests read the same answers.
import type { StatusDoc } from "./contracts";

interface Envelope {
  readonly calls: readonly { readonly tool: string; readonly outcome: { readonly ok: boolean; readonly output?: unknown } }[];
}

const files = import.meta.glob<Envelope>("../../../../fixtures/status-*.json", { eager: true, import: "default" });

/** Every status_get answer in the fixtures, keyed "<file>/<scope kind>". */
export const fixtureAnswers: Record<string, unknown> = Object.fromEntries(
  Object.entries(files).flatMap(([path, env]) => {
    const file = path.replace(/^.*\/status-|\.json$/gu, "");
    return env.calls
      .filter((c) => c.tool === "status_get" && c.outcome.ok)
      .map((c) => {
        const output = c.outcome.output as { doc: { scope: { kind: string } } };
        return [`${file}/${output.doc.scope.kind}`, output];
      });
  }),
);

/** "fleet", "order-stale", "order-planning", "fleet-long-text", "fleet-legacy". */
export const fixture = (name: string): StatusDoc => {
  const [kind = "", ...variant] = name.split("-");
  const output = fixtureAnswers[`${variant.length > 0 ? variant.join("-") : "typical"}/${kind}`] as { doc: StatusDoc } | undefined;
  if (!output) throw new Error(`no status fixture ${name}`);
  return output.doc;
};
