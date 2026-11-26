// What a screen's browser downloads: each file lands in a folder of the session's own under the node's home (Chrome
// told so at the session's start, `Browser.setDownloadBehavior`), or is copied there when the agent's agent-browser
// saved it elsewhere, and the hub hears its name, size and when it finished with the session (`downloads`), so the
// person sees it on the screen's card and can put it in the chat (`browser_download_send`, which reads it here with
// `read_download`). The files stay a day after the screen ends, then go.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ScreenDownload } from "../../shared/contracts.ts";

/** How long a screen's downloads stay after it ends. */
export const DOWNLOADS_KEPT_MS = 24 * 60 * 60_000;
/** The most downloads a session lists; later ones are still saved, but not listed. */
export const DOWNLOADS_MAX = 32;

export const downloadsRoot = (home: string) => join(home, "browser", "downloads");
export const downloadsDir = (home: string, sessionId: string) => join(downloadsRoot(home), sessionId);

/** A session id as a folder name: never a path. */
const SESSION = /^[A-Za-z0-9_-]{1,80}$/u;

/** A downloaded file's path in `dir`, by its listed name; undefined for a name that is no plain file name there. */
export const downloadPath = (home: string, sessionId: string, name: string): string | undefined => {
  if (!SESSION.test(sessionId) || name === "" || name !== basename(name) || name === "." || name === "..") return undefined;
  return join(downloadsDir(home, sessionId), name);
};

/** One download as Chrome tells of it: its name, then where it was saved and how big it was. */
type Pending = { name: string };

/**
 * A session's downloads, from its Chrome's `Browser.downloadWillBegin` and `Browser.downloadProgress`: each one that
 * completed, in the order they finished, with a name unique in the list ("report (2).pdf" for a second "report.pdf").
 */
export class Downloads {
  private readonly pending = new Map<string, Pending>();
  private readonly done: ScreenDownload[] = [];

  constructor(
    /** The session's own folder, where Chrome saves them: made here, so Chrome finds it. */
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  list(): ScreenDownload[] {
    return [...this.done];
  }

  /** `Browser.downloadWillBegin`. */
  began(params: Record<string, unknown>): void {
    const guid = String(params.guid ?? "");
    const name = basename(String(params.suggestedFilename ?? "")) || "download";
    if (guid) this.pending.set(guid, { name });
  }

  /** `Browser.downloadProgress`: true when one completed and the list changed. */
  progress(params: Record<string, unknown>): boolean {
    const guid = String(params.guid ?? "");
    const state = String(params.state ?? "");
    const pending = this.pending.get(guid);
    if (!pending || state === "inProgress") return false;
    this.pending.delete(guid);
    if (state !== "completed" || this.done.length >= DOWNLOADS_MAX) return false;
    // Where Chrome saved it: our folder, or the one the agent's agent-browser named (copied here, so it can be sent).
    const saved = typeof params.filePath === "string" && params.filePath !== "" ? params.filePath : join(this.dir, pending.name);
    const name = this.unique(basename(saved) || pending.name);
    const here = join(this.dir, name);
    try {
      if (saved !== here) {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        copyFileSync(saved, here);
      }
      const bytes = statSync(here).size;
      this.done.push({ name, bytes, at: this.now().toISOString() });
      return true;
    } catch (e) {
      console.warn(`a screen's download ${name} isn't kept: ${(e as Error).message}`);
      return false;
    }
  }

  /** `name`, or with " (2)", " (3)"… before its extension when the list has it already. */
  private unique(name: string): string {
    const taken = new Set(this.done.map((d) => d.name));
    if (!taken.has(name)) return name;
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 2; ; n++) {
      const next = `${stem} (${n})${ext}`;
      if (!taken.has(next) && !existsSync(join(this.dir, next))) return next;
    }
  }
}

/** Removes the downloads of sessions not `live` whose folder no file was written to for DOWNLOADS_KEPT_MS. */
export function sweepDownloads(home: string, live: readonly string[], now: number): void {
  const root = downloadsRoot(home);
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return;
  }
  const open = new Set(live);
  for (const id of ids) {
    if (open.has(id)) continue;
    const dir = join(root, id);
    try {
      if (now - statSync(dir).mtimeMs >= DOWNLOADS_KEPT_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone meanwhile.
    }
  }
}
