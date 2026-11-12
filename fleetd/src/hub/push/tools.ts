// The push tools: push_device_register, push_devices_list, push_device_remove
// and push_badge for a person's own phones (a human key with a person), and push_relay_set for a key with admin on
// every machine.
import type { PersonId } from "../../shared/contracts.ts";
import { internalError, ToolError } from "../../shared/errors.ts";
import { openSealed, publicKeyOf, seal } from "../../shared/sealed_box.ts";
import { isBase64 } from "../../shared/text.ts";
import { isHuman } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import type { Hub } from "../api/hub.ts";
import { boxKey } from "../hub_links/store.ts";
import { allowsEverywhere } from "../people/tools.ts";
import { badge, DEFAULT_RELAY, defaultHost, list, PUSH_DEVICES_MAX, register as registerDevice, relay, type RelaySetting, remove, setRelay } from "./index.ts";
import { httpUrl } from "./payload.ts";

/** The caller's person: phones are a person's, so only a person's own device registers or reads them. */
function person(caller: Caller): PersonId {
  if (isHuman(caller) && caller.person !== undefined) return caller.person.personId;
  throw new ToolError(
    "forbidden",
    "Phone notifications are a person's: only a person's own paired device registers them.",
    "Pair the phone with the hub (`fleetd pair` or an invite), then register it from the app.",
  );
}

/** The relay's key, sealed to this hub's box key by the caller: opened to check it and trim a newline, sealed again. */
function reseal(hub: Hub, sealed: string): string {
  const refused = () =>
    new ToolError(
      "invalid",
      "The relay key wasn't sealed to this hub, or is empty.",
      "Seal the relay's key to boxPubKey from hub_links_get, or run `fleetd push-relay set <url> --relay-key-file <path>`.",
    );
  let key: Uint8Array;
  try {
    key = boxKey(hub);
  } catch (error) {
    console.error("push: the hub's box key:", error);
    throw internalError();
  }
  let plain: string | undefined;
  try {
    const opened = isBase64(sealed) ? openSealed(key, Buffer.from(sealed, "base64")) : null;
    plain = opened ? new TextDecoder("utf-8", { fatal: true }).decode(opened) : undefined;
  } catch {
    plain = undefined;
  }
  const trimmed = plain?.trim();
  if (trimmed === undefined || trimmed === "" || /\s/u.test(trimmed)) throw refused();
  return Buffer.from(seal(publicKeyOf(key), new TextEncoder().encode(trimmed))).toString("base64");
}

export function register(tools: Registry): void {
  tools.add("push_device_register", (hub, caller, input) => {
    const me = person(caller);
    const raw = input.publicKey.trim();
    const publicKey = isBase64(raw) ? new Uint8Array(Buffer.from(raw, "base64")) : undefined;
    if (!publicKey || publicKey.length !== 32) {
      throw new ToolError("invalid", "publicKey isn't an X25519 public key.", "Send the device's 32-byte public key in standard base64.");
    }
    const token = input.token.trim();
    if (token === "" || /\s/u.test(token)) {
      throw new ToolError("invalid", "token isn't a push token.", "Send the APNs device token or the FCM registration token as the OS gave it.");
    }
    const now = hub.clock.now();
    const out = hub.db.transaction((c) => {
      const mine = list(c, me);
      const known = c.query("SELECT 1 FROM push_devices WHERE token = ? AND person_id = ?").get(token, me) !== null;
      if (!known && mine.length >= PUSH_DEVICES_MAX) return undefined;
      const device = registerDevice(c, { person: me, keyId: caller.keyId, platform: input.platform, token, publicKey, name: input.name }, now);
      return { device, relay: relay(c, DEFAULT_RELAY) !== undefined };
    });
    if (!out) {
      throw new ToolError(
        "invalid",
        `You have ${PUSH_DEVICES_MAX} phones registered already.`,
        "Remove one with push_device_remove, then register this one.",
      );
    }
    return {
      device: out.device,
      ...(out.relay ? {} : { next: "Phone notifications are off on this hub: an owner or admin turns them on with push_relay_set." }),
      relay: out.relay,
    };
  });

  tools.add("push_devices_list", (hub, caller) => {
    const me = person(caller);
    return { devices: list(hub.db.conn, me), relay: relay(hub.db.conn, DEFAULT_RELAY) !== undefined };
  });

  tools.add("push_badge", (hub, caller) => ({ badge: badge(hub, person(caller)) }));

  tools.add("push_device_remove", (hub, caller, input) => {
    const me = person(caller);
    const device = hub.db.transaction((c) => remove(c, me, input.deviceId));
    if (!device) throw new ToolError("not_found", `You have no phone ${input.deviceId}.`, "Call push_devices_list to see your phones.");
    return { device };
  });

  tools.add("push_relay_set", (hub, caller, input) => {
    // Every person's notifications go through it.
    if (!allowsEverywhere(caller, "admin")) {
      throw new ToolError(
        "forbidden",
        "The push relay is hub-wide: it needs Admin on every machine.",
        "Ask an owner or admin of the hub, or run `fleetd push-relay set` on the hub.",
      );
    }
    const trimmed = input.url.trim().replace(/\/+$/, "");
    let url: string | undefined;
    if (trimmed !== "") {
      if (!httpUrl(trimmed)) {
        throw new ToolError(
          "invalid",
          `${trimmed} isn't an http(s) URL.`,
          "Give the relay's address, such as https://push.example.com or http://devbox:4795.",
        );
      }
      // The public relay takes no key, and nothing goes to it in the clear.
      if (defaultHost(trimmed) && (!trimmed.startsWith("https://") || input.key !== undefined)) {
        throw new ToolError("invalid", `${DEFAULT_RELAY} takes pushes over https, without a key.`, `Set ${DEFAULT_RELAY} without a relay key.`);
      }
      url = trimmed;
    }
    const keySealed = url !== undefined && input.key !== undefined ? reseal(hub, input.key) : undefined;
    // Off is kept as an empty URL, so it outlasts a restart; the default relay without a key is kept as no setting.
    let setting: RelaySetting | undefined;
    if (url === undefined) setting = { url: "" };
    else if (url === DEFAULT_RELAY && keySealed === undefined) setting = undefined;
    else setting = { url, ...(keySealed === undefined ? {} : { keySealed }) };
    const now = hub.db.transaction((c) => {
      setRelay(c, setting);
      return relay(c, DEFAULT_RELAY);
    });
    return {
      default: now !== undefined && now.url === DEFAULT_RELAY && now.keySealed === undefined,
      key: now?.keySealed !== undefined,
      ...(now === undefined ? {} : { url: now.url }),
    };
  });
}
