// pair_code_create: the app's Pair a phone, a `fleetd pair` code for one more device of the caller's person, with the
// link to show as a QR. mac_code_create / mac_code_status: Add machine › A Mac for agents' six-digit code
// (crates/fleetd/src/hub/pair/tools.rs).
import type { Role } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isHuman } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allowsEverywhere } from "../people/tools.ts";
import { pairCodes } from "./codes.ts";
import { macMachineId } from "./http.ts";
import { deepLink, loopbackOnlyFix, phoneHubUrl, phoneLoopbackFix } from "./urls.ts";

/** The most the caller's key may do on every machine: the paired device gets no more. */
const roleEverywhere = (caller: Caller): Role | undefined =>
  (["admin", "operate", "read"] as const).find((role) => allowsEverywhere(caller, role));

/** Setting up the agents' Mac is an owner's or admin's, from their own device, as Add machine is. */
function macAdmin(caller: Caller): void {
  if (isHuman(caller) && allowsEverywhere(caller, "admin")) return;
  throw new ToolError(
    "forbidden",
    "Setting up the agents' Mac is for the hub's owners and admins, from their own device.",
    "Ask an owner or admin of the hub to open Add machine › A Mac for agents.",
  );
}

export function register(tools: Registry): void {
  tools.add("pair_code_create", async (hub, caller, input) => {
    const person = isHuman(caller) ? caller.person : undefined;
    if (!person) {
      throw new ToolError(
        "forbidden",
        "Only a person's own device pairs a phone.",
        "Open Pair a phone in the fleetd app, or run `fleetd pair` on the hub.",
      );
    }
    const role = roleEverywhere(caller);
    if (!role) {
      throw new ToolError(
        "forbidden",
        "This device's key reaches only some machines, and a phone paired from it would reach them all.",
        "Pair the phone from a device with a key for every machine, or run `fleetd pair` on the hub.",
      );
    }
    const hubUrl = await phoneHubUrl(hub, input.hubUrl);
    if (hubUrl === undefined) {
      throw new ToolError(
        "failed",
        `The hub is only at ${input.hubUrl ?? hub.url()}, which a phone can't reach.`,
        phoneLoopbackFix(),
      );
    }
    const minted = pairCodes(hub).createFor(person.personId, role);
    return {
      code: minted.code,
      expiresAt: minted.expiresAt,
      hubUrl,
      link: deepLink(hubUrl, minted.code),
      next: "Scan the QR with the fleetd app on the phone. The code works once, for 15 minutes.",
    };
  });

  tools.add("mac_code_create", async (hub, caller, input) => {
    macAdmin(caller);
    const machineId = macMachineId(hub);
    const minted = pairCodes(hub).createMac(machineId);
    const hubUrl = await phoneHubUrl(hub, input.hubUrl);
    const next =
      hubUrl !== undefined
        ? "In the fleetd app on the Mac, choose Set up this Mac for agents and type the code. It works once, for 10 " +
          `minutes; should the app not find the hub, give it ${hubUrl}.`
        : `The hub is only at a loopback address, which the Mac can't reach. ${loopbackOnlyFix("the Mac", "make a new code here")}`;
    return { code: minted.code, expiresAt: minted.expiresAt, ...(hubUrl === undefined ? {} : { hubUrl }), machineId, next };
  });

  tools.add("mac_code_status", (hub, caller, input) => {
    macAdmin(caller);
    const state = pairCodes(hub).macState(input.code);
    return state === undefined ? {} : { state };
  });
}
