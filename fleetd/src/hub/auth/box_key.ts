// The hub's own X25519 box key, in its home (`node-box-key.pem`): what a client seals a key the hub keeps to (a vault
// value, the push relay's key), as hub_info's boxPubKey gives it.
import { loadOrCreateBoxKey, publicKeyOf } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";

export const boxKey = (hub: Hub): Uint8Array => hub.area("box_key", (h) => loadOrCreateBoxKey(h.config.home));

/** Its public half, standard base64. */
export const boxPublic = (hub: Hub) => Buffer.from(publicKeyOf(boxKey(hub))).toString("base64");
