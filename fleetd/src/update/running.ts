// This process's own binary, held from its start: what an
// update keeps for a rollback. Its own module, with nothing else imported, so the CLI holds it before anything loads.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";

/** An open binary: its bytes stay readable after a new one is renamed over its path, as the old inode lives on. */
export class Kept {
  constructor(private readonly fd: number) {}

  static open(path: string): Kept {
    return new Kept(openSync(path, "r"));
  }

  bytes(): Uint8Array {
    const bytes = new Uint8Array(fstatSync(this.fd).size);
    for (let at = 0; at < bytes.length; ) {
      const n = readSync(this.fd, bytes, at, bytes.length - at, at);
      if (n === 0) throw new Error("the kept binary ended early");
      at += n;
    }
    return bytes;
  }

  close(): void {
    closeSync(this.fd);
  }
}

let running: Kept | undefined;

/** Called first thing in `main`: holds this process's binary before anything can install over its path. On the hub's
 * Mac the hub and the node run one binary, and the hub's update replaces it before the node's starts; the node's
 * rollback must put back what the node runs, not what the hub just installed. macOS has no /proc/self/exe, so without
 * it the Mac's node refused every update. */
export function keepRunningBinary(): void {
  if (running) return;
  try {
    running = Kept.open(process.execPath);
  } catch {}
}

/** The bytes of the binary this process runs, whatever has been installed over its path since. */
export function runningBinary(): Uint8Array {
  if (running) return running.bytes();
  if (process.platform === "linux") return readFileSync("/proc/self/exe");
  throw new Error("this process's binary wasn't kept when it started");
}
