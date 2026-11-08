// Hubs behind a company or private CA: trust what the OS trusts, as the GPUI app did, not only Node's bundled roots.
// Reading the system store and setting it takes 25-40 ms, so it happens before the first TLS connection to a hub (a wss://
// WebSocket, or pairing's fetch), not while the app starts; a plain ws:// hub never needs it.
import tls from "node:tls";

let trusted = false;

export const trustSystemCAs = (): void => {
  if (trusted) return;
  trusted = true;
  tls.setDefaultCACertificates([...tls.getCACertificates("bundled"), ...tls.getCACertificates("system")]);
};
