// The status docs the screenshots use (fixtures/status/docs.ts), by "<scope>[-<variant>]", for the tests: one source
// for both.
import { emptyDoc, legacyDoc, longTextDoc, planningDoc, statusDoc, type Kind } from "../../../../fixtures/status/docs";
import type { StatusDoc } from "./contracts";

const VARIANTS: Record<string, (kind: Kind) => unknown> = {
  typical: (k) => statusDoc(k),
  stale: (k) => statusDoc(k, true),
  planning: (k) => (k === "order" ? planningDoc() : statusDoc(k)),
  legacy: legacyDoc,
  "long-text": longTextDoc,
  empty: emptyDoc,
};

/** Every status_get answer the fixtures give, keyed "<variant>/<scope kind>". */
export const fixtureAnswers: Record<string, unknown> = Object.fromEntries(
  Object.entries(VARIANTS).flatMap(([variant, doc]) => (["fleet", "project", "order"] as const).map((k) => [`${variant}/${k}`, { doc: doc(k) }])),
);

/** "fleet", "order-stale", "order-planning", "fleet-long-text", "fleet-legacy". */
export const fixture = (name: string): StatusDoc => {
  const [kind = "", ...variant] = name.split("-");
  const output = fixtureAnswers[`${variant.length > 0 ? variant.join("-") : "typical"}/${kind}`] as { doc: StatusDoc } | undefined;
  if (!output) throw new Error(`no status fixture ${name}`);
  return output.doc;
};
