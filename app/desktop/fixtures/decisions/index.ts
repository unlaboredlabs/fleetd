// The Decisions tab's answers (decisions_list, decisions_overturn) for the first project, storefront: what its lead
// settled and what the person answered, project-wide and for two orders, with values changed twice, one changed by
// the person, and one the person revoked. Added to the shared fixtures; the group's own cover no decisions yet, the
// list still on its way, and a list the hub fails to read.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { firstProject } from "../kit/chat.ts";
import type { JsonObject } from "../kit/json.ts";
import { LONG_PARAGRAPH, ofLength } from "../kit/text.ts";

const ago = (f: Fixture, minutes: number): string => new Date(Date.parse(f.now) - minutes * 60_000).toISOString();

/** The orders decisions are scoped to, by their titles as the hub keeps them. */
const ORDERS = [
  { workstreamId: "W4", title: "Receipts in the shop's time zone" },
  { workstreamId: "W6", title: "Checkout v2" },
];

interface Spec {
  readonly key: string;
  readonly value: string;
  readonly why?: string;
  readonly who: "lead" | "human";
  /** Absent: the whole project. */
  readonly order?: string;
  readonly minutes: number;
  readonly state?: "active" | "superseded" | "retired";
  readonly revoked?: { readonly minutes: number; readonly why: string };
}

const specs = (): Spec[] => [
  { key: "receipts.timezone", value: "The shop's own time zone, from its settings; never the server's", why: "You said receipts must match what the till printed.", who: "human", order: "W4", minutes: 40 },
  { key: "receipts.date_format", value: "Day month year, with the month as a word: 19 Oct 2026", who: "lead", order: "W4", minutes: 35, why: "Reads the same in every locale the shops use, and no one confuses 10/11 with 11/10." },
  { key: "payments.provider", value: "stripe", who: "lead", order: "W6", minutes: 60 * 26, state: "superseded", why: "Already integrated for refunds." },
  { key: "payments.provider", value: "adyen", who: "human", order: "W6", minutes: 60 * 3, why: "The contract with Adyen is signed; Stripe stays for refunds until March." },
  { key: "checkout.guest", value: "Guests can pay without an account; we offer one after the order", who: "human", order: "W6", minutes: 90 },
  { key: "api.health.path", value: "/health", who: "lead", minutes: 60 * 24 * 9, state: "superseded", why: "What the old service used." },
  { key: "api.health.path", value: "/healthz", who: "lead", minutes: 60 * 24 * 4, state: "superseded", why: "The load balancer's default probe path." },
  { key: "api.health.path", value: "/livez", who: "human", minutes: 60 * 20, why: "The cluster probes /livez now; /healthz stays as an alias for a release." },
  { key: "ci.required_checks", value: "test, lint and typecheck; e2e only on main", who: "lead", minutes: 60 * 24 * 2, why: "e2e takes 25 minutes and fails on its own one run in fifty." },
  { key: "db.engine", value: "sqlite", who: "lead", minutes: 60 * 24 * 6, state: "retired", why: "One shop per database file keeps backups simple.", revoked: { minutes: 60 * 5, why: "We need read replicas for reports; ask me before picking another." } },
  { key: "ui.theme", value: "Follow the system's light or dark", who: "human", minutes: 60 * 24 * 3 },
];

const decisionsOf = (f: Fixture, list: readonly Spec[]): JsonObject[] => {
  const r = firstProject(f);
  // Numbered oldest first, as the hub numbers them; listed newest first.
  const oldest = [...list].sort((a, b) => b.minutes - a.minutes);
  const ids = new Map(oldest.map((s, i) => [s, `D${String(i + 101)}`]));
  const earlier = (s: Spec): Spec | undefined =>
    oldest.filter((o) => o.key === s.key && o.order === s.order && o.minutes > s.minutes && o.state === "superseded").at(-1);
  return [...list]
    .sort((a, b) => a.minutes - b.minutes)
    .map((s) => {
      const before = earlier(s);
      return {
        decisionId: ids.get(s) ?? "D1",
        key: s.key,
        scope: s.order === undefined ? { kind: "project", projectRef: { ...r } } : { kind: "workstream", workstreamId: s.order },
        value: s.value,
        ...(s.why === undefined ? {} : { why: s.why }),
        source: s.who,
        by: s.who === "human" ? "human:desk" : `lead:${r.machineId}/${r.projectId}`,
        ...(before === undefined ? {} : { supersedes: ids.get(before) ?? "D1" }),
        state: s.state ?? "active",
        at: ago(f, s.minutes),
        ...(s.revoked === undefined ? {} : { retired: { by: "human:desk", at: ago(f, s.revoked.minutes), why: s.revoked.why } }),
      };
    });
};

const answerAll = (f: Fixture, list: readonly Spec[]): void => {
  const r = firstProject(f);
  f.answer("decisions_list", { projectRef: { ...r } }, { decisions: decisionsOf(f, list), orders: ORDERS });
  // A change or revoke goes through; the list stays as it was (a fixture hub sends no event).
  f.answer("decisions_overturn", undefined, { overturned: decisionsOf(f, list)[0] ?? {}, next: "The lead reads it at its next wake." });
};

/** The same, with values and reasons long enough to wrap and clamp. */
const longSpecs = (): Spec[] =>
  specs().map((s, i) => (i % 3 === 0 ? { ...s, value: ofLength(`${s.value}. ${LONG_PARAGRAPH}`, 600), why: ofLength(LONG_PARAGRAPH, 900) } : s));

export default defineGroup({
  extend: {
    typical: (f) => answerAll(f, specs()),
    "many-agents": (f) => answerAll(f, specs()),
    "long-text": (f) => answerAll(f, longSpecs()),
  },
  fixtures: (base) => [
    (() => {
      const f = Fixture.from(base("typical"), "decisions-none", "storefront has decided nothing yet.");
      f.answer("decisions_list", { projectRef: { ...firstProject(f) } }, { decisions: [], orders: [] });
      return f;
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "decisions-loading", "The decisions still on their way from the hub.");
      answerAll(f, specs());
      for (const a of f.answers("decisions_list")) f.answer("decisions_list", a.input, a.output, 600_000);
      // The answer never comes in a shot: shoot without waiting for it.
      return f.settleAt(0);
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "decisions-error", "The hub fails to read the decisions.");
      f.drop("decisions_list");
      f.fail("decisions_list", { projectRef: { ...firstProject(f) } }, { code: "failed", message: "The hub failed to answer that request." });
      return f;
    })(),
  ],
});
