# fleetd phone web app

The inbox on a phone: one-tap answers, the terse reply box, checklists, approvals, masked secret entry and Web Push.
The hub serves it at `/` on the same origin as its `/app` WebSocket, which is the only API it uses. It needs a secure
context (HTTPS, or `localhost`) for the service worker, push and clipboard.

`pnpm --filter @fleetd/pwa build` writes static files to `dist/` and copies them to `apps/hub/dist/pwa/`. The build
fails when what a visit loads up front (page, app, service worker, manifest) is over 60 KB gzipped. libsodium
(about 148 KB gzipped) is a separate chunk loaded only when a secret is sealed, with its own 160 KB ceiling.

## Pairing and the device key

`fleetd hub device add --name phone --url <hub url>` prints a link ending in `#pair=<token>`. Opening it sends the token in a
`device_pair` frame; the hub answers with a new human key, which the app keeps in IndexedDB and uses to authenticate
from then on. The token is removed from the address bar at once. A link can also be pasted on the pairing screen.

The key is protected by the browser's same-origin policy only. We did not wrap it with a non-extractable WebCrypto
key: script running on this origin could ask WebCrypto to unwrap it just as easily, and anything that can read the
browser profile can read the wrapping key too. The limits are on the hub: the key is human-only, belongs to this
device, and `fleetd hub key revoke` ends it at its next call. A revoked key sends the app back to the pairing screen.

## Secrets

The value is sealed in the browser with libsodium's `crypto_box_seal` to the target machine's `boxPubKey` (from
`fleetd_status`), then sent with `secret_submit`. The hub only relays ciphertext; the node opens it and reports a
fingerprint, which the app shows. The input is cleared and the encoded bytes are wiped after sealing.

libsodium runs as WebAssembly, so a Content-Security-Policy on `/` needs `script-src 'self' 'wasm-unsafe-eval'`.
