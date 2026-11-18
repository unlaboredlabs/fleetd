// Hubs behind a company or private CA: trust what the OS trusts, as the GPUI app did, not only Node's bundled roots.
// Reading the system store takes 50-90 ms and setting it 12-15 ms more, so it happens before the first TLS connection
// to a hub (a wss:// WebSocket, or pairing's fetch), never on the way to the window; a plain ws:// hub never needs it.
// systemCAs reads the store on a worker thread, leaving main only the setting; trustSystemCAs, for a connection that
// can't wait, does it all at once.
import tls from "node:tls";
import { Worker } from "node:worker_threads";

let trusted = false;

const trust = (system: readonly string[]): void => {
  if (trusted) return;
  trusted = true;
  tls.setDefaultCACertificates([...tls.getCACertificates("bundled"), ...system]);
};

export const trustSystemCAs = (): void => {
  if (!trusted) trust(tls.getCACertificates("system"));
};

const READ_SYSTEM = `require("node:worker_threads").parentPort.postMessage(require("node:tls").getCACertificates("system"));`;

let reading: Promise<void> | undefined;

/** Trusts the OS's CAs, read off the main thread; settles once they are set (at once if they already are). */
export const systemCAs = (): Promise<void> =>
  (reading ??= trusted
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const done = (system?: unknown) => {
          void worker.terminate();
          // A worker that couldn't read them: main reads them itself, as before.
          if (Array.isArray(system) && system.every((c) => typeof c === "string")) trust(system);
          else trustSystemCAs();
          resolve();
        };
        const worker = new Worker(READ_SYSTEM, { eval: true });
        worker.once("message", done);
        worker.once("error", () => done());
        worker.once("exit", () => done());
      }));
