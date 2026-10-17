import { HubHello, PROTOCOL_VERSION, ProtocolVersion } from "@fleetd/contracts";
import pkg from "../package.json" with { type: "json" };
import { T3_PIN } from "./t3.ts";

export const makeHubHello = (): HubHello =>
  HubHello.make({ protocolVersion: ProtocolVersion.make(PROTOCOL_VERSION), hubVersion: pkg.version, t3Pin: T3_PIN });
