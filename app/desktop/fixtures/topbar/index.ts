// The top bar's states (status-rows' eight projects): search's lead is held by a usage pause on buildbox's login
// rather than by buildbox going quiet, so the bar and the line above the composer show the pause and Resume; or by
// buildbox offline, where the line opens the machine.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { isObject, type JsonValue } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";

const paused = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "topbar-paused", "Top bar: search is blocked by a usage pause on buildbox, with Resume.");
  const reason = "paused until Sun 23:40 UTC (usage limit on buildbox's login)";
  const rows = arr(obj(f.output("status_get", {}))["rows"])
    .filter(isObject)
    .map((r) => {
      if (r["title"] !== "search") return r;
      const { stale: _stale, ...row } = r;
      return { ...row, blockedReason: reason, usagePausedOn: "buildbox", usagePausedReason: reason };
    });
  return f.answer("status_get", {}, { rows });
};

const offline = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "topbar-offline", "Top bar: search is blocked by buildbox offline, and the line opens buildbox.");
  const off = (machines: JsonValue | undefined) => arr(machines).map((m) => (isObject(m) && m["machineId"] === "buildbox" ? { ...m, status: "offline" } : m));
  if (f.snapshot !== undefined) f.snapshot["machines"] = off(f.snapshot["machines"]);
  f.live = f.live.map((frame) => ({ ...frame, machines: off(frame["machines"]) }));
  const rows = arr(obj(f.output("status_get", {}))["rows"])
    .filter(isObject)
    .map((r) => {
      if (r["title"] !== "search") return r;
      const { stale: _stale, ...row } = r;
      return { ...row, state: "blocked", blockedReason: "buildbox is offline" };
    });
  return f.answer("status_get", {}, { rows });
};

export default defineGroup({
  fixtures: (base) => [paused(base("status-rows")), offline(base("status-rows"))],
});
