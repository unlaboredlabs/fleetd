// The renderer's disk cache of the last hub data it saw (src/renderer/src/data/cache.ts), kept as the text it wrote.
// Main checks only the envelope: the version, the size, and that it is for the hub this app is paired with, so a
// cache never outlives its pairing or shows one hub's projects while paired with another.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { HUB_CACHE_MAX_BYTES, HUB_CACHE_VERSION } from "../../shared/cache";

/** The cache's hub, when `text` is a cache this app can read. */
export const cacheHub = (text: string): string | undefined => {
  if (Buffer.byteLength(text, "utf8") > HUB_CACHE_MAX_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const { version, hub } = parsed as { version?: unknown; hub?: unknown };
    return version === HUB_CACHE_VERSION && typeof hub === "string" && hub !== "" ? hub : undefined;
  } catch {
    return undefined;
  }
};

export class HubCacheFile {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  /** The cache for `hub`, or null: none, unreadable, or another hub's. */
  read(hub: string): string | null {
    try {
      const text = readFileSync(this.#path, "utf8");
      return cacheHub(text) === hub ? text : null;
    } catch {
      return null;
    }
  }

  /** Keeps `text` when it is a cache for `hub`; a failed write only costs the next launch its offline view. */
  write(text: string, hub: string): void {
    if (cacheHub(text) !== hub) return;
    try {
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, this.#path);
    } catch {
      // As above.
    }
  }

  clear(): void {
    rmSync(this.#path, { force: true });
    rmSync(`${this.#path}.tmp`, { force: true });
  }
}
