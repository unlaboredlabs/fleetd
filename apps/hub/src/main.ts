import { HubHello } from "@fleetd/contracts";
import { Schema } from "effect";
import { makeHubHello } from "./hello.ts";
import { missingExecutorRpcs } from "./t3.ts";

// Placeholder until M1: proves the bundle carries fleetd's and T3's contracts.
const missing = missingExecutorRpcs();
if (missing.length > 0) {
  process.stderr.write(`pinned T3 lacks executor RPCs: ${missing.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write(`${Schema.encodeSync(Schema.fromJsonString(HubHello))(makeHubHello())}\n`);
