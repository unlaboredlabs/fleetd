// People's reviews on GitHub, on the PRs in the train. One GraphQL query reads every open Change's PR of a repo (20 to
// a query): each person's latest say on it and its review threads. A person's say is open, as GitHub counts it, while
// their latest review that approves, requests changes or was dismissed requests changes; a thread is open while it is
// unresolved and a person started it. A person is the repo's owner, a member of its organization or a collaborator, as
// GitHub counts a review: anyone else's say, on a public repo, is no finding. Bots, and what fleetd itself posted
// (marked), are never a person's. A plain
// comment, or a review that only comments, is no finding: only its line comments are, as threads. The writer replies as
// the PR's author, so the author's later comments on a thread are shown with it but never sent as new: nothing loops.
//
// The gate (service.ts) holds a Change while any is open and sends each new one to its writer as review findings.
// A read that fails backs off, doubling, and holds nothing: what the last good read found stays.
import type { Database } from "bun:sqlite";
import { Repeats, warnHourly } from "../train/repeats.ts";
import type { Train } from "../train/service.ts";
import { prKey } from "./verdicts.ts";
import {
  peopleQuery,
  type PersonFinding,
  readPeople,
  WATCHED,
} from "./people_rules.ts";

export {
  findingsText,
  FRESH_MS,
  holdWhy,
  isBot,
  openFindings,
  PEOPLE_HOLD,
  peopleQuery,
  type PersonFinding,
  POLL_MS,
  readPeople,
  REVIEW_MARK,
  WATCHED,
} from "./people_rules.ts";

const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
/** PRs per query: GitHub's cost stays a few points a query. */
const CHUNK = 20;

/** The PR's open findings as its last good read found them. */
export function openOf(db: Database, pr: string): PersonFinding[] {
  let row: { data: string } | null;
  try {
    row = db.query<{ data: string }, [string]>("SELECT data FROM review_people WHERE pr_key = ?1").get(prKey(pr));
  } catch {
    return [];
  }
  try {
    return row ? (JSON.parse(row.data) as PersonFinding[]) : [];
  } catch {
    return [];
  }
}

/** Reads people's reviews on the train's PRs; each repo at most once in its interval, backing off after a failure. */
export class People {
  /** When each repo was last read whole. */
  private readonly readAt = new Map<string, number>();
  private readonly backoff = new Map<string, { failures: number; untilMs: number }>();
  private readonly repeats = new Repeats();

  constructor(private readonly train: Train) {}

  private get db(): Database {
    return this.train.records.db.conn;
  }

  /**
   * Reads the repo's watched PRs unless its last read is under `maxAgeMs` old, or it is backing off. Whether what is
   * kept is that fresh now; a failed read changes nothing kept.
   */
  async read(repo: string, maxAgeMs: number): Promise<boolean> {
    const key = repo.toLowerCase();
    const now = this.train.nowMs();
    const last = this.readAt.get(key);
    if (last !== undefined && now - last < maxAgeMs) return true;
    const off = this.backoff.get(key);
    if (off && now < off.untilMs) return false;
    const changes = this.train.records.inTrain(repo, WATCHED);
    const numbers = [...new Set(changes.map((c) => c.prNumber))];
    const [owner, name] = changes[0]?.repo.split("/") ?? key.split("/");
    try {
      for (let i = 0; i < numbers.length; i += CHUNK) {
        const chunk = numbers.slice(i, i + CHUNK);
        const data = await this.train.github.graphql(peopleQuery(chunk), [
          ["owner", owner ?? ""],
          ["name", name ?? ""],
        ]);
        for (const [n, found] of readPeople(data, chunk)) {
          const change = changes.find((c) => c.prNumber === n)!;
          this.db
            .query("INSERT OR REPLACE INTO review_people (pr_key, read_ms, data) VALUES (?1, ?2, ?3)")
            .run(prKey(change.prUrl), now, JSON.stringify(found));
        }
      }
    } catch (error) {
      const failures = (off?.failures ?? 0) + 1;
      const wait = Math.min(BACKOFF_FIRST_MS * 2 ** Math.min(failures - 1, 10), BACKOFF_MAX_MS);
      this.backoff.set(key, { failures, untilMs: now + wait });
      const why = (error as Error)?.message ?? String(error);
      warnHourly(this.repeats, now, ["reviews: people's reviews not read", key], why, `reviews: people's reviews on ${repo} not read (next try in ${wait / 1000} s): ${why}`);
      return false;
    }
    this.backoff.delete(key);
    this.repeats.clear(["reviews: people's reviews not read", key].join(" "));
    this.readAt.set(key, now);
    return true;
  }

  open(pr: string): PersonFinding[] {
    return openOf(this.db, pr);
  }

  /** The findings with something not sent to the writer yet. */
  unsent(pr: string, findings: PersonFinding[]): PersonFinding[] {
    const sent = new Set(
      this.db
        .query<{ key: string }, [string]>("SELECT key FROM review_people_sent WHERE pr_key = ?1")
        .all(prKey(pr))
        .map((r) => r.key),
    );
    return findings.filter((f) => f.keys.some((k) => !sent.has(k)));
  }

  markSent(pr: string, findings: PersonFinding[]): void {
    const q = this.db.query("INSERT OR IGNORE INTO review_people_sent (pr_key, key) VALUES (?1, ?2)");
    for (const f of findings) for (const k of f.keys) q.run(prKey(pr), k);
  }
}
