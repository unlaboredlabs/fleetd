// Which status sources are live (crates/fleetd/src/hub/status/fresh.rs): `hub.area("status_fresh")`. A source is
// touched on every good answer (`touch`) and told of failures (`fail`, which keeps the reason but flips nothing).
// Staleness is decided only here, by deadlines: a source is stale once `asOf + staleAfter` passes untouched. The
// status loop sleeps until `nextDeadline` and calls `check`; nothing polls.
import type { Hub } from "../api/hub.ts";

/** GitHub answers for a repo, from any `gh api` call. */
export const GITHUB_STALE_MS = 180_000;
/** The end of a train pass for a repo. */
export const TRAIN_STALE_MS = 120_000;
export const github = (repo: string) => `github:${repo}`;
export const train = (repo: string) => `train:${repo}`;

export type Stale = { sinceMs: number; reason: string };

type Source = {
  staleAfterMs: number;
  /** The last good answer; absent until the first one since the hub started. */
  asOfMs?: number;
  /** When the source was first expected, for "not checked since the hub started". */
  expectedMs: number;
  lastError?: string;
  stale?: Stale;
};

/** A source's state as the view shows it. */
export type SourceView = { asOfMs?: number; stale?: Stale };

/** A flip the status loop turns into `source.stale` / `source.fresh`. */
export type Flip = { kind: "stale"; source: string; sinceMs: number; reason: string } | { kind: "fresh"; source: string; staleMs: number };

function ageText(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

function reasonFor(source: string, ageMs: number, lastError: string | undefined): string {
  const age = ageText(ageMs);
  const colon = source.indexOf(":");
  const [kind, name] = colon < 0 ? [source, ""] : [source.slice(0, colon), source.slice(colon + 1)];
  if (kind === "github") return lastError !== undefined ? `GitHub not reached for ${age}: ${lastError}` : `GitHub not reached for ${age}`;
  if (kind === "train") return `the ${name} train hasn't run for ${age}`;
  return `${source} silent for ${age}`;
}

export class Fresh {
  /** Sorted by name when read, as the Rust BTreeMap. */
  private readonly sources = new Map<string, Source>();
  /** Flips to fresh, made by `touch`, waiting for the status loop. */
  private pending: Flip[] = [];
  private readonly listeners = new Set<() => void>();

  /** Calls `fn` when a source turns fresh or a new deadline may be earlier than the loop's sleep. */
  onNotify(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Registers a source with its cadence. Until its first touch it reads stale: "not checked since the hub started". */
  expect(source: string, staleAfterMs: number, nowMs: number): void {
    const known = this.sources.get(source);
    if (known) {
      known.staleAfterMs = staleAfterMs;
      return;
    }
    this.sources.set(source, { staleAfterMs, expectedMs: nowMs });
    this.notify();
  }

  /** Stops expecting the source: nothing reads it any more. */
  forget(source: string): void {
    this.sources.delete(source);
  }

  /** A good answer at `atMs`. A stale source turns fresh at once and the status loop is woken. */
  touch(source: string, atMs: number): void {
    const s = this.sources.get(source);
    if (!s) return;
    const first = s.asOfMs === undefined;
    s.asOfMs = s.asOfMs === undefined ? atMs : Math.max(s.asOfMs, atMs);
    delete s.lastError;
    if (first) {
      // "Not checked since the hub started" ends here: a flip like any other, so docs re-render.
      this.pending.push({ kind: "fresh", source, staleMs: Math.max(0, atMs - s.expectedMs) });
      this.notify();
      return;
    }
    if (s.stale) {
      this.pending.push({ kind: "fresh", source, staleMs: atMs - s.stale.sinceMs });
      delete s.stale;
      this.notify();
    }
  }

  /** A failed call: the reason shows once the source goes stale. Flips nothing by itself. */
  fail(source: string, reason: string): void {
    const s = this.sources.get(source);
    if (s) s.lastError = [...reason].slice(0, 160).join("");
  }

  /** The earliest moment a source could flip stale. */
  nextDeadline(): number | undefined {
    let min: number | undefined;
    for (const s of this.sources.values()) {
      if (s.stale || s.asOfMs === undefined) continue;
      const d = s.asOfMs + s.staleAfterMs;
      if (min === undefined || d < min) min = d;
    }
    return min;
  }

  /** Flips every source whose deadline passed; returns those plus the fresh flips `touch` made since the last call. */
  check(nowMs: number): Flip[] {
    const flips = this.pending;
    this.pending = [];
    for (const name of [...this.sources.keys()].sort()) {
      const s = this.sources.get(name) as Source;
      if (s.asOfMs === undefined || s.stale || nowMs - s.asOfMs <= s.staleAfterMs) continue;
      const reason = reasonFor(name, nowMs - s.asOfMs, s.lastError);
      s.stale = { sinceMs: s.asOfMs, reason };
      flips.push({ kind: "stale", source: name, sinceMs: s.asOfMs, reason });
    }
    return flips;
  }

  view(source: string, nowMs: number): SourceView | undefined {
    const s = this.sources.get(source);
    if (!s) return undefined;
    let stale: Stale | undefined;
    if (s.stale) {
      // The age in the reason grows with time; recompute it so it is never stale itself.
      stale = { sinceMs: s.stale.sinceMs, reason: s.asOfMs !== undefined ? reasonFor(source, nowMs - s.asOfMs, s.lastError) : s.stale.reason };
    } else if (s.asOfMs === undefined) stale = { sinceMs: s.expectedMs, reason: "not checked since the hub started" };
    return { ...(s.asOfMs === undefined ? {} : { asOfMs: s.asOfMs }), ...(stale ? { stale } : {}) };
  }
}

/** The hub's freshness registry: `fresh(hub).touch(github(repo), now)`. */
export const fresh = (hub: Hub) => hub.area("status_fresh", () => new Fresh());
