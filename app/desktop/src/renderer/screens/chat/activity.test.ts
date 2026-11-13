import { describe, expect, it } from "vitest";
import type { HubEvent } from "../../../shared/contracts";
import { createDataStore, type DataState } from "../../src/data/store";
import { leadLaneId } from "../../src/data/selectors";
import { doingWords, leadDoing, leadLastTurnSince, leadLastTurnUntil, leadTurnSince, leadTurnUntil, turnLine, workedFor } from "./activity";

const AT = "2026-10-19T10:00:00.000Z";
const ref = { machineId: "devbox", projectId: "storefront" };
const KEY = "devbox/storefront";
const ev = (seq: number, type: string, data?: unknown, projectId = ref.projectId, at = AT): HubEvent => ({
  seq,
  at,
  type,
  summary: type,
  machineId: "devbox",
  projectId,
  ...(data === undefined ? {} : { data }),
});
const working = (leadWorking: boolean) => ({ projectRef: ref, needsYou: false, leadWorking, lastSeq: 1 });

const state = (patch: Partial<DataState>): DataState => ({ ...createDataStore().getState(), fresh: true, ...patch });

describe("the lead's activity line", () => {
  it("says what the lead does now, from its lane", () => {
    const lanes = {
      [leadLaneId(ref)]: { laneId: leadLaneId(ref), status: "working" as const, activity: { activity: { kind: "tool" as const, name: "plan", server: "fleetd" }, since: AT } },
    };
    const s = state({ chatStates: { [KEY]: working(true) }, live: { ...createDataStore().getState().live, lanes } });
    expect(leadDoing(s, KEY)).toBe("planning");
    // No lane yet (an older hub): the hub's word that it works.
    expect(leadDoing(state({ chatStates: { [KEY]: working(true) } }), KEY)).toBe("working");
  });

  it("is gone once the turn ends or the link is not fresh", () => {
    for (const s of [state({ chatStates: { [KEY]: working(false) } }), state({ fresh: false, chatStates: { [KEY]: working(true) } })]) {
      expect(leadDoing(s, KEY)).toBeUndefined();
    }
  });

  it("speaks in plain words, never a raw tool name or command", () => {
    expect(doingWords({ kind: "read", path: "app/desktop/src/renderer/screens/chat/ChatList.tsx" })).toBe("reading `ChatList.tsx`");
    expect(doingWords({ kind: "read", pattern: "chat_delta" })).toBe("searching the code");
    expect(doingWords({ kind: "command", text: "cargo test -p fleetd" })).toBe("running a command");
    expect(doingWords({ kind: "tool", name: "brief", server: "fleetd" })).toBe("briefing an agent");
    expect(doingWords({ kind: "tool", name: "something_new", server: "fleetd" })).toBe("checking with fleetd");
    expect(doingWords({ kind: "tool", name: "x", server: "other" })).toBe("working");
    expect(doingWords({ kind: "web", detail: "github.com" })).toBe("reading the web");
    expect(doingWords({ kind: "planning" })).toBe("planning");
  });

  it("times the turn from its first working to its idle, and the turn before once a new one hasn't begun", () => {
    const t = (m: number, sec = 0) => `2026-10-19T10:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`;
    const ms = (iso: string) => Date.parse(iso);
    const events = [
      ev(1, "chat.waiting", working(false), ref.projectId, t(0)),
      ev(2, "chat.waiting", working(true), ref.projectId, t(1)),
      // Said again mid-turn, and another project's idle: neither ends or restarts the turn.
      ev(3, "chat.waiting", { ...working(true), needsYou: true }, ref.projectId, t(2)),
      ev(4, "chat.waiting", working(false), "elsewhere", t(3)),
    ];
    const running = state({ chatStates: { [KEY]: working(true) }, events });
    expect([leadTurnSince(running, KEY), leadTurnUntil(running, KEY)]).toEqual([ms(t(1)), undefined]);
    const over = state({ events: [...events, ev(5, "chat.waiting", working(false), ref.projectId, t(4, 40))] });
    expect([leadTurnSince(over, KEY), leadTurnUntil(over, KEY)]).toEqual([ms(t(1)), ms(t(4, 40))]);
    // Without the idle before it, the first "working" may be mid-turn: no time rather than a short one.
    const cut = state({ events: [...events.slice(1), ev(5, "chat.waiting", working(false), ref.projectId, t(4, 40))] });
    expect([leadTurnSince(cut, KEY), leadTurnUntil(cut, KEY)]).toEqual([undefined, undefined]);
    // The last finished turn, the reply's stamp: none while the first runs, and still that one once the next runs.
    const last = (st: DataState) => [leadLastTurnSince(st, KEY), leadLastTurnUntil(st, KEY)];
    expect(last(running)).toEqual([undefined, undefined]);
    expect(last(over)).toEqual([ms(t(1)), ms(t(4, 40))]);
    const next = state({ events: [...over.events, ev(6, "chat.waiting", working(true), ref.projectId, t(6))] });
    expect([leadTurnSince(next, KEY), leadTurnUntil(next, KEY)]).toEqual([ms(t(6)), undefined]);
    expect(last(next)).toEqual([ms(t(1)), ms(t(4, 40))]);
  });

  it("counts up while the lead works and says how long it worked once it's done, elapsed only", () => {
    const since = Date.parse(AT);
    expect(turnLine({ since }, "planning · started 3 agents", since + 72_000)).toEqual({ count: "Working for 1m 12s", words: "planning · started 3 agents" });
    // The hub's bare "working" adds nothing to the count.
    expect(turnLine({ since }, "working", since + 9_000)).toEqual({ count: "Working for 9s" });
    // A start no longer among the events: the words alone, never a guessed time.
    expect(turnLine({}, "planning", since)).toEqual({ words: "planning" });
    expect(turnLine({ since, until: since + 220_000 }, undefined, since + 999_000)).toEqual({ words: "Worked for 3m 40s" });
    expect(turnLine({}, undefined, since)).toBeUndefined();
    expect([workedFor(-5), workedFor(59_999), workedFor(60_000), workedFor(4_330_000)]).toEqual(["0s", "59s", "1m 0s", "1h 12m"]);
  });
});
