// hub_update, hub_update_status and hub_update_settings (crates/fleetd/src/hub/update/tools.rs).
import type { HubUpdateOutput, UpdateRun } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { REPAIR_FIX } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allowsEverywhere } from "../claude_accounts/people.ts";
import { isoMs } from "../store/time.ts";
import { versionLabel } from "../../update/version.ts";
import { join } from "node:path";
import { defaultTiming, DRAIN_MINUTES_MAX, type Refused, Updates } from "./index.ts";
import { hubPorts } from "./ports.ts";

/** The hub's update, `hub.area("updates")`: its ports wired to the running hub. */
export const updates = (hub: Hub) =>
  hub.area("updates", (h) => {
    const u = new Updates(join(h.config.home, "update"), h.clock, defaultTiming(), h.shutdown.signal);
    u.setPorts(hubPorts(h));
    return u;
  });

const head = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max));

/** Every answer's shape: the run, what's ready, and the settings with when an automatic update is due. */
function output(hub: Hub, run: UpdateRun | undefined): HubUpdateOutput {
  const u = updates(hub);
  const leftOver = u.leftOver();
  const settings = u.settings();
  const autoAt = u.autoAt();
  const skips = settings.auto ? u.autoSkips() : undefined;
  const last = u.lastAuto();
  const nextCheck = u.nextCheck();
  const skip = u.skipReason();
  const ready = u.ready();
  return {
    next: next(run, leftOver),
    ...(run ? { run } : {}),
    ...(ready !== undefined ? { ready: head(ready, 200) } : {}),
    ...(leftOver ? { leftOver: true } : {}),
    settings,
    ...(autoAt !== undefined ? { autoAt: isoMs(autoAt) } : {}),
    ...(skips !== undefined ? { autoSkips: head(skips, 200) } : {}),
    ...(last ? { lastAuto: last } : {}),
    ...(nextCheck !== undefined ? { nextCheck: isoMs(nextCheck) } : {}),
    ...(skip !== undefined ? { skipReason: head(skip, 500) } : {}),
  };
}

/** Only a person with Admin on every machine changes how the hub updates: an update restarts every machine. */
function refuseUnlessAdminEverywhere(caller: Caller): void {
  if (!allowsEverywhere(caller, "admin") || caller.kind !== "human") {
    throw new ToolError(
      "forbidden",
      "Updating fleetd restarts the hub and every node: it needs a person's key with Admin on every machine.",
      caller.kind === "human" ? REPAIR_FIX : "Use an Admin key for all machines (`--machines '*'`).",
    );
  }
}

function next(run: UpdateRun | undefined, leftOver: boolean): string {
  if (!run) return "The hub hasn't updated itself yet.";
  if (run.finishedAt === undefined && leftOver) {
    return "Left over: nothing in the hub drives this update any more, so it won't change again. Call hub_update to start a new one.";
  }
  if (run.finishedAt === undefined) {
    return "Going on: the hub restarts while it updates, so the connection drops for a moment. Call hub_update_status again to follow it.";
  }
  return "Finished: each part says how it went.";
}

function refusal(r: Refused): ToolError {
  if (r.kind === "not_wired") return new ToolError("failed", "The hub's update isn't ready yet; try again in a moment.");
  if (r.kind === "nothing_to_retry") {
    return new ToolError(
      "failed",
      "There is nothing to retry: the last update didn't update the hub, or didn't have that machine.",
      "Press Update to update everything.",
    );
  }
  return new ToolError(
    "failed",
    `The hub runs ${versionLabel(r.running)} now, not the build that update went to, so retrying it would put this machine behind the hub.`,
    "Press Update to bring every machine to the hub's build.",
  );
}

export function register(tools: Registry): void {
  tools.add("hub_update", (hub, caller, input) => {
    // It restarts the hub and every node, so Admin on one machine is not enough; and a person decides it.
    refuseUnlessAdminEverywhere(caller);
    const now = input.now === true;
    const u = updates(hub);
    const started = input.machine !== undefined ? u.retry(input.machine, now) : input.startOver === true ? u.startOver(input.channel, now) : u.start(input.channel, now);
    if (!("run" in started)) throw refusal(started);
    return output(hub, started.run);
  });
  tools.add("hub_update_status", (hub) => output(hub, updates(hub).status()));
  tools.add("hub_update_settings", (hub, caller, input) => {
    refuseUnlessAdminEverywhere(caller);
    if (input.drainMinutes !== undefined && input.drainMinutes > DRAIN_MINUTES_MAX) {
      throw new ToolError("invalid", `drainMinutes must be 0-${DRAIN_MINUTES_MAX}`);
    }
    try {
      updates(hub).setSettings(input.auto, input.drainMinutes);
    } catch (e) {
      throw new ToolError("failed", `The hub couldn't write its update settings: ${(e as Error).message}`);
    }
    return output(hub, updates(hub).status());
  });
}
