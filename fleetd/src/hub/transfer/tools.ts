// hub_move_status, hub_move_start, hub_move_cancel and hub_move_resume: Move to the cloud (move.ts), from the app's
// Settings › Hub › Setup and the banner a moved hub shows. Anyone on the hub reads where it stands; a person with
// Admin on every machine moves it, stops the move or lifts its pause.
import { ToolError } from "../../shared/errors.ts";
import { REPAIR_FIX } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allowsEverywhere } from "../claude_accounts/people.ts";
import { mover } from "./move.ts";

function refuseUnlessAdminEverywhere(caller: Caller): void {
  if (!allowsEverywhere(caller, "admin") || caller.kind !== "human") {
    throw new ToolError(
      "forbidden",
      "Moving this workspace moves every machine's bots: it needs a person's key with Admin on every machine.",
      caller.kind === "human" ? REPAIR_FIX : "Use an Admin key for all machines (`--machines '*'`).",
    );
  }
}

export function register(tools: Registry): void {
  tools.add("hub_move_status", (hub) => ({ move: mover(hub).status() }));
  tools.add("hub_move_start", (hub, caller, input) => {
    refuseUnlessAdminEverywhere(caller);
    return { move: mover(hub).start(input) };
  });
  tools.add("hub_move_cancel", (hub, caller) => {
    refuseUnlessAdminEverywhere(caller);
    return { move: mover(hub).cancel() };
  });
  tools.add("hub_move_resume", (hub, caller) => {
    refuseUnlessAdminEverywhere(caller);
    return { move: mover(hub).resume() };
  });
}
