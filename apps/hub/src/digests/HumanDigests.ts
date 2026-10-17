// The human digest at 09:00 and 18:00 in `policy.tz`, emitted as `digest.ready`, and on demand for digest_get.
import type { Decision, MachineId, ProjectRef, Workstream } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { workstreamFacts } from "../leads/LeadWakes.ts";
import * as Workstreams from "../leads/Workstreams.ts";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import { renderHumanDigest } from "../ledger/HumanDigest.ts";
import { projectKey } from "../ledger/LedgerRepo.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import { nextCron, parseCron } from "../wakes/schedule.ts";

/** The global Decision key holding the IANA zone digests follow. */
export const POLICY_TZ_KEY = "policy.tz";
const SLOTS = parseCron("0 9,18 * * *");
/** HubEvent.data is capped at 2 KB of JSON; the full text stays available through digest_get. */
const EVENT_DATA_MAX_BYTES = 2048;
const LIST_LIMIT = 200;

export const isZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const hubZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The latest 09:00 or 18:00 at or before `nowMs`: what "since the last digest" means. */
export const previousSlot = (nowMs: number, tz: string) => {
  let last = nowMs - 12 * 3_600_000;
  for (let t = nowMs - 36 * 3_600_000; ; ) {
    const next = nextCron(SLOTS, t, tz);
    if (next === undefined || next > nowMs) return last;
    last = next;
    t = next;
  }
};

export const nextSlot = (nowMs: number, tz: string) => nextCron(SLOTS, nowMs, tz) ?? nowMs + 12 * 3_600_000;

/** `data` for digest.ready: the text, cut at a line so the JSON stays within the event cap. */
export const eventData = (text: string, at: string) => {
  const fits = (data: object) => Buffer.byteLength(JSON.stringify(data)) <= EVENT_DATA_MAX_BYTES;
  if (fits({ text, at })) return { text, at };
  const lines = text.split("\n");
  while (lines.length > 1) {
    lines.pop();
    const data = { text: `${lines.join("\n")}\n…`, at, truncated: true, fullText: "digest_get" };
    if (fits(data)) return data;
  }
  return { text: "", at, truncated: true, fullText: "digest_get" };
};

export class HumanDigests extends Context.Service<
  HumanDigests,
  {
    /** The digest as of now, over the projects on machines `visible` allows (all when absent). */
    readonly render: (visible?: (machineId: MachineId) => boolean) => Effect.Effect<{ readonly text: string; readonly at: string }>;
  }
>()("fleetd/digests/HumanDigests") {}

const make = Effect.gen(function* () {
  const asks = yield* Asks;
  const decisions = yield* Decisions;
  const workstreams = yield* Workstreams.Workstreams;
  const store = yield* HubStore.HubStore;
  const events = yield* EventLog.EventLog;
  const factsContext = yield* Effect.context<Effect.Services<ReturnType<typeof workstreamFacts>>>();

  const zone = Effect.map(decisions.list({ scope: { kind: "global" }, limit: 500 }), (global) => {
    const tz = global.find((d) => d.key === POLICY_TZ_KEY)?.value.trim();
    return tz !== undefined && isZone(tz) ? tz : hubZone();
  });

  const renderAt = (nowMs: number, tz: string, visible: (machineId: MachineId) => boolean = () => true) =>
    Effect.gen(function* () {
      const sinceMs = previousSlot(nowMs, tz);
      const shown = (ref: ProjectRef) => visible(ref.machineId);
      const all = (yield* workstreams.list({ limit: LIST_LIMIT })).filter((w) => shown(w.projectRef));
      const projectOf = new Map(all.map((w) => [w.workstreamId as string, w.projectRef]));
      const recent = (w: Workstream) => Date.parse(w.updatedAt) >= sinceMs;
      const decidedWithoutYou = (yield* decisions.list({ source: "lead", sinceMs, limit: 50 })).filter((d: Decision) => {
        const ref = d.scope.kind === "project" ? d.scope.projectRef : d.scope.kind === "workstream" ? projectOf.get(d.scope.workstreamId) : undefined;
        return ref !== undefined && shown(ref);
      });
      const listed = all.filter((w) => !["done", "failed", "stopped"].includes(w.state) || recent(w));
      const text = renderHumanDigest({
        nowMs,
        tz,
        asks: (yield* asks.list({ state: "open", limit: LIST_LIMIT })).filter((a) => a.projectRef === undefined || shown(a.projectRef)),
        workstreams: listed,
        facts: yield* workstreamFacts(listed).pipe(Effect.provideContext(factsContext)),
        decidedWithoutYou,
        projectNames: new Map((yield* store.projects.list()).map((p) => [projectKey(p), p.title])),
      });
      return { text, at: new Date(nowMs).toISOString() };
    });

  return {
    service: HumanDigests.of({
      render: (visible) => Effect.flatMap(Effect.all([Clock.currentTimeMillis, zone]), ([now, tz]) => renderAt(now, tz, visible)),
    }),
    /**
     * Emits digest.ready at each slot in the current policy.tz. Sleeps at most an hour at a time, so a changed zone
     * takes effect within the hour; after a long pause (host asleep) it fires once, not once per missed slot.
     */
    schedule: Effect.gen(function* () {
      let after = yield* Clock.currentTimeMillis;
      for (;;) {
        const tz = yield* zone;
        const due = nextSlot(after, tz);
        const now = yield* Clock.currentTimeMillis;
        if (now < due) {
          yield* Effect.sleep(Duration.millis(Math.min(due - now, 3_600_000)));
          continue;
        }
        const { text, at } = yield* renderAt(due, tz);
        yield* events.append({ at, type: "digest.ready", summary: text.split("\n")[1] ?? "fleetd digest", data: eventData(text, at) });
        after = Math.max(due, now);
      }
    }),
  };
});

/** HumanDigests plus its 09:00/18:00 scheduler. Needs Asks, Decisions, Workstreams, HubStore and EventLog. */
export const layer = Layer.effect(
  HumanDigests,
  Effect.gen(function* () {
    const { service, schedule } = yield* make;
    yield* Effect.forkScoped(schedule);
    return service;
  }),
);
