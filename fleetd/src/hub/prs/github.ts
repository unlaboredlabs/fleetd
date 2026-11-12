// What the PR views read from GitHub, through `gh` on the hub's machine, cached briefly so a burst of refetches costs
// one call: a repo's open or closed PRs a page at a time, most recently updated
// first (one GraphQL query per page), one PR's detail (one query), and its changed files (REST, per page of 100, kept
// per head so a page is read once per push). Only the PR views call this; nothing here runs on a timer. A failed read
// is remembered for the same TTL, so a rate-limited or signed-out `gh` is asked again at most once a minute.
import type { Clock } from "../../shared/clock.ts";
import { GhStartError, type GhRunner } from "../train/gh.ts";
import {
  DETAIL_FIELDS,
  DETAIL_TTL_MS,
  ERROR_TTL_MS,
  explain,
  type GhDetail,
  type GhFile,
  type GhPage,
  LIST_CHECKS,
  LIST_QUERY,
  LIST_TTL_MS,
  num,
  PAGE_SIZE,
  PATCH_MAX_BYTES,
  type Read,
  readDetail,
  readPage,
  READS_AT_ONCE,
  str,
} from "./shapes.ts";

export {
  DETAIL_TTL_MS,
  ERROR_TTL_MS,
  explain,
  type GhCheck,
  type GhDetail,
  type GhFile,
  type GhPage,
  type GhPull,
  type GhReview,
  LIST_TTL_MS,
  PAGE_SIZE,
  type Read,
  READS_AT_ONCE,
} from "./shapes.ts";

const MAX_LISTS = 128;
const MAX_DETAILS = 64;
const MAX_FILE_PAGES = 16;

type Entry<T> = { value?: T; okMs: number; error?: [string, number]; used: number };

/** A small map that drops its least recently used entry past `max`. */
class Cache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  /** The read of each key running now, which a burst of calls for the key shares. */
  readonly asking = new Map<string, Promise<Read<T>>>();
  private tick = 0;
  constructor(private readonly max: number) {}

  get(key: string, now: number, ttl: number): Read<T> | undefined {
    this.tick++;
    const e = this.entries.get(key);
    if (!e) return undefined;
    e.used = this.tick;
    const fresh = e.error ? now - e.error[1] < ERROR_TTL_MS : e.value !== undefined && now - e.okMs < ttl;
    return fresh ? read(e) : undefined;
  }

  put(key: string, result: { ok: true; value: T } | { ok: false; error: string }, now: number): Read<T> {
    this.tick++;
    if (this.entries.size >= this.max && !this.entries.has(key)) {
      let oldest: string | undefined;
      let used = Infinity;
      for (const [k, e] of this.entries) {
        if (e.used < used) {
          used = e.used;
          oldest = k;
        }
      }
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    let e = this.entries.get(key);
    if (!e) {
      e = { okMs: 0, used: 0 };
      this.entries.set(key, e);
    }
    e.used = this.tick;
    if (result.ok) {
      e.value = result.value;
      e.okMs = now;
      delete e.error;
    } else {
      // An older value stays: the views show it with the reason the refresh failed.
      e.error = [result.error, now];
    }
    return read(e);
  }
}

function read<T>(e: Entry<T>): Read<T> {
  const out: Read<T> = {};
  if (e.value !== undefined) out.value = e.value;
  if (e.error) out.error = e.error[0];
  return out;
}

export class PrsGitHub {
  private readonly lists = new Cache<GhPage>(MAX_LISTS);
  private readonly details = new Cache<GhDetail>(MAX_DETAILS);
  private readonly files_ = new Cache<GhFile[]>(MAX_FILE_PAGES);
  /**
   * GitHub reads running, at most READS_AT_ONCE, and the ones waiting for a turn. Once one at a time, a chat with five
   * PR cards waited 3 s for their details, each behind the one before.
   */
  private running = 0;
  private readonly turns: (() => void)[] = [];

  constructor(
    private readonly gh: GhRunner,
    private readonly clock: Clock,
  ) {}

  private async runJson<T>(args: string[], shape: (v: unknown) => T): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    let out;
    try {
      out = await this.gh.run(args);
    } catch (error) {
      const spawn = error instanceof GhStartError ? error.message : String((error as Error)?.message ?? error);
      return {
        ok: false,
        error: spawn === "ENOENT" ? "The GitHub CLI (gh) isn't installed on the machine fleetd runs on." : `GitHub couldn't be read: ${spawn}`,
      };
    }
    if (out.exitCode !== 0) return { ok: false, error: explain(out.exitCode, out.stderr) };
    try {
      return { ok: true, value: shape(JSON.parse(out.stdout)) };
    } catch (error) {
      const message = (error as Error).message;
      return { ok: false, error: message.startsWith("GitHub") ? message : "GitHub answered in a shape fleetd doesn't read." };
    }
  }

  /** The cached answer for `key`, else one read of it: a burst of calls for the same key shares it. */
  private cached<T>(cache: Cache<T>, key: string, ttl: number, fetch: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<Read<T>> {
    const hit = cache.get(key, this.clock.now(), ttl);
    if (hit) return Promise.resolve(hit);
    let asking = cache.asking.get(key);
    if (!asking) {
      asking = this.turn(async () => cache.put(key, await fetch(), this.clock.now())).finally(() => cache.asking.delete(key));
      cache.asking.set(key, asking);
    }
    return asking;
  }

  /** Runs `read` once fewer than READS_AT_ONCE others run; a finished read hands its turn to the first waiting. */
  private async turn<T>(read: () => Promise<T>): Promise<T> {
    if (this.running < READS_AT_ONCE) this.running++;
    else await new Promise<void>((resolve) => this.turns.push(resolve));
    try {
      return await read();
    } finally {
      const next = this.turns.shift();
      if (next) next();
      else this.running--;
    }
  }

  /** A page of the repo's open PRs (`closed` false) or of its closed and merged ones, most recently updated first. */
  page(repo: string, closed: boolean, after?: string): Promise<Read<GhPage>> {
    const state = closed ? "closed" : "open";
    const key = JSON.stringify([repo.toLowerCase(), state, after ?? null]);
    return this.cached(this.lists, key, LIST_TTL_MS, () => {
      const slash = repo.indexOf("/");
      const [owner, name] = slash < 0 ? [repo, ""] : [repo.slice(0, slash), repo.slice(slash + 1)];
      const [states, checks] = closed ? ["[CLOSED, MERGED]", ""] : ["[OPEN]", LIST_CHECKS];
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${LIST_QUERY.replace("STATES", states).replace("CHECKS", checks)}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `first=${PAGE_SIZE}`,
      ];
      if (after !== undefined) args.push("-f", `after=${after}`);
      return this.runJson(args, readPage);
    });
  }

  /** One PR's detail. */
  detail(repo: string, number: number): Promise<Read<GhDetail>> {
    const key = JSON.stringify([repo.toLowerCase(), number]);
    return this.cached(this.details, key, DETAIL_TTL_MS, () =>
      this.runJson(["pr", "view", String(number), "--repo", repo, "--json", DETAIL_FIELDS], (v) => {
        const d = readDetail(v);
        if (!d) throw new Error("shape");
        return d;
      }),
    );
  }

  /** Page `page` (0-based, 100 files each) of the PR's files at `head`, kept until it falls out of the cache. */
  files(repo: string, number: number, head: string, page: number): Promise<Read<GhFile[]>> {
    const key = JSON.stringify([repo.toLowerCase(), number, head, page]);
    return this.cached(this.files_, key, Number.MAX_SAFE_INTEGER, () =>
      this.runJson(["api", `repos/${repo}/pulls/${number}/files?per_page=100&page=${page + 1}`], (v) => {
        if (!Array.isArray(v)) throw new Error("shape");
        return v.map((f: any) => {
          if (typeof f?.filename !== "string") throw new Error("shape");
          const patch = typeof f.patch === "string" && Buffer.byteLength(f.patch) <= PATCH_MAX_BYTES ? f.patch : null;
          return {
            filename: f.filename,
            previous_filename: f.previous_filename ?? null,
            status: str(f.status),
            additions: num(f.additions),
            deletions: num(f.deletions),
            patch,
          } as GhFile;
        });
      }),
    );
  }
}
