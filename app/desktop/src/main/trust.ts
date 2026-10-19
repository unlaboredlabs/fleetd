// Hubs behind a company or private CA: trust what the OS trusts, as the GPUI app did, not only Node's bundled roots.
// Reading the system store takes ~15 ms, so it happens before the first connection to a hub (the WebSocket, or
// pairing's fetch), not while the app starts.
import tls from "node:tls";

let trusted = false;

export const trustSystemCAs = (): void => {
  if (trusted) return;
  trusted = true;
  tls.setDefaultCACertificates([...tls.getCACertificates("bundled"), ...tls.getCACertificates("system")]);
};
