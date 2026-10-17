import { HubHello, PROTOCOL_VERSION } from "@fleetd/contracts";
import { Exit, Schema } from "effect";

export type HandshakeResult = { readonly ok: true; readonly hello: HubHello } | { readonly ok: false; readonly reason: string };

const decodeHello = Schema.decodeUnknownExit(Schema.fromJsonString(HubHello));

/** Checks the hub's first frame; the node only proceeds when both sides speak one protocol. */
export const checkHubHello = (frame: string): HandshakeResult => {
  const decoded = decodeHello(frame);
  if (Exit.isFailure(decoded)) return { ok: false, reason: "malformed hello" };
  const hello = decoded.value;
  if (hello.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, reason: `hub speaks protocol ${hello.protocolVersion}, this node speaks ${PROTOCOL_VERSION}` };
  }
  return { ok: true, hello };
};
