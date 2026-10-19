// The Status view's answers (F6): status_get for the fleet, storefront and W14 (the data layer refetches it on
// events; there is no long-poll), and the seen mark. Added to the shared fixtures, plus the states
// only Status has: stale sources, the lead still planning, a hub without the progress model, and the skeleton.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { isObject, type JsonObject } from "../kit/json.ts";
import { emptyDoc, type Kind, legacyDoc, longTextDoc, planningDoc, SCOPES, statusDoc } from "./docs.ts";

/** The transport's longest delay: a status_get still unanswered when the screenshot is taken (the skeleton). */
const HOLD_MS = 600_000;
const KINDS: readonly Kind[] = ["fleet", "project", "order"];

/** The open asks the fixture's inbox answers with, so Needs you shows the same cards the inbox does. */
const openAsks = (f: Fixture): string[] => {
  const out = f.answers("asks_list").find((a) => isObject(a.input) && a.input["state"] === "open")?.output;
  const asks = isObject(out) && Array.isArray(out["asks"]) ? out["asks"] : [];
  return asks.flatMap((a) => (isObject(a) && typeof a["askId"] === "string" ? [a["askId"]] : []));
};

const answer = (f: Fixture, docs: (kind: Kind, asks: readonly string[]) => JsonObject, getDelayMs?: number): void => {
  const asks = openAsks(f);
  for (const kind of KINDS) {
    const doc = docs(kind, asks);
    f.answer("status_get", { scope: SCOPES[kind] }, { doc }, getDelayMs);
  }
  f.answer("status_seen", undefined, { recorded: true });
};

const own = (base: Fixture, what: string, note: string, docs: (kind: Kind, asks: readonly string[]) => JsonObject, getDelayMs?: number): Fixture => {
  const f = Fixture.from(base, `status-${what}`, note);
  answer(f, docs, getDelayMs);
  // The held answer is the state being shot, not a frame still to come: nothing to wait for before the shot.
  if (getDelayMs !== undefined) f.settleAt(0);
  return f;
};

export default defineGroup({
  extend: {
    typical: (f) => answer(f, (k, asks) => statusDoc(k, false, asks)),
    "needs-you": (f) => answer(f, (k, asks) => statusDoc(k, false, asks)),
    empty: (f) => answer(f, (k) => emptyDoc(k)),
    "long-text": (f) => {
      answer(f, (k, asks) => longTextDoc(k, asks));
      // On purpose: wire values a newer hub might send (a risk rule, a CI state, a stage), which must render a
      // generic fallback. The schema of this build rejects them, which is the point.
      f.pendingContracts.set("status_get", "values from a newer hub, on purpose");
    },
  },
  fixtures: (base) => [
    own(base("typical"), "stale", "Status: GitHub stopped answering for acme/storefront on top of the typical picture.", (k, asks) => statusDoc(k, true, asks)),
    own(base("typical"), "planning", "Status: W14's lead is still planning, so the order shows its planning bar, not 0%.", (k, asks) =>
      k === "order" ? planningDoc() : statusDoc(k, false, asks),
    ),
    own(base("typical"), "legacy", "Status: a hub without the progress model (no estimate, stage credit, critical path or blockers).", (k, asks) => legacyDoc(k, asks)),
    own(base("typical"), "skeleton", "Status: the hub is live but hasn't answered status_get yet: the skeleton, no numbers.", (k, asks) => statusDoc(k, false, asks), HOLD_MS),
  ],
});
