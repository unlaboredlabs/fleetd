// Push notifications (D218), not built yet: this is where they plug in. Notifications carry their full content,
// end-to-end encrypted. At pairing the app makes an X25519 key pair, its private key in secure storage; once the
// platform hands it a push token, it registers {platform, pushToken, publicKey, deviceName} with the hub, which
// encrypts each notification to that key and sends it through a push relay. The iOS Notification Service Extension
// and the Android handler open it with `openNotification`. The hub's registration API and the payload are specified
// in docs/design; the extension and the handler come in a later change.
import type { HubClient } from "./hub/client";

export interface DeviceRegistration {
  readonly platform: "ios" | "android";
  readonly pushToken: string;
  /** X25519, base64. */
  readonly publicKey: string;
  readonly deviceName: string;
}

/** Once per session, when the link is live: registers this device for push. Nothing yet: no token, no key pair. */
export const registerDevice = async (_client: HubClient): Promise<void> => {};

/** A notification's sealed payload, opened with the device's private key: what to show. Nothing arrives yet. */
export const openNotification = (_sealed: string): { readonly title: string; readonly body: string } | null => null;
