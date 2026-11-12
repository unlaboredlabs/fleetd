// Changes and trains in the hub database (contract.rs). Repos are keyed
// lowercased.
import type { Change, ChangeId, ChangeState, ProjectRef, TrainState, WorkstreamId } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import { encode, HEAD_STATES, isDraft, type ListFilter, parseState, QUEUED_STATES, TERMINAL_STATES, type TrainRow, type Wait, type Watch, type WatchCheck } from "./states.ts";

export {
  ALL_STATES,
  DRAFT,
  encode,
  errorText,
  HEAD_STATES,
  isDraft,
  type ListFilter,
  parsePrUrl,
  parseState,
  QUEUED_STATES,
  TERMINAL_STATES,
  type TrainRow,
  type Wait,
  WAIT_BLOCKED,
  WAIT_PERSON,
  WAIT_REGEN,
  WAIT_UNSTARTED,
  WAITING,
  type Watch,
  type WatchCheck,
} from "./states.ts";

const numberOf = (changeId: ChangeId) => Number.parseInt(changeId.slice(1), 10) || 0;
const decode = (data: string) => JSON.parse(data) as Change;


type TrainSql = { repo: string; machine_id: string; project_id: string; watch_since_ms: number };
const toTrain = (r: TrainSql): TrainRow => ({
  repo: r.repo,
  projectRef: { machineId: r.machine_id, projectId: r.project_id },
  watchSinceMs: r.watch_since_ms,
});

export class ChangeRecords {
  constructor(readonly db: HubDb) {}

  /** Numbers it (`X<n>`) and stores it at the back of its repo's train. `change.changeId` is ignored. */
  create(change: Change): Change {
    return this.db.transaction((tx) => {
      const repo = change.repo.toLowerCase();
      const row = tx
        .query<{ n: number }, [string, number, string, string, string]>(
          `INSERT INTO changes (repo, pr_number, state, machine_id, project_id, train_order, data)
             VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(train_order), 0) + 1 FROM changes WHERE repo = ?1), '') RETURNING n`,
        )
        .get(repo, change.prNumber, change.state, change.projectRef.machineId, change.projectRef.projectId)!;
      const made: Change = { ...change, repo, changeId: `X${row.n}` };
      tx.query("UPDATE changes SET state = ?1, data = ?2 WHERE n = ?3").run(made.state, encode(made), row.n);
      return made;
    });
  }

  put(change: Change): void {
    this.db.conn.query("UPDATE changes SET state = ?1, data = ?2 WHERE n = ?3").run(change.state, encode(change), numberOf(change.changeId));
  }

  get(changeId: ChangeId): Change | undefined {
    const row = this.db.conn.query<{ data: string }, [number]>("SELECT data FROM changes WHERE n = ?1").get(numberOf(changeId));
    return row ? decode(row.data) : undefined;
  }

  /** Sets the Change's `lastError` and nothing else, in one statement. */
  note(changeId: ChangeId, text: string): void {
    this.db.conn
      .query("UPDATE changes SET data = json_set(data, '$.lastError', ?1) WHERE n = ?2")
      .run([...text].slice(0, 2000).join(""), numberOf(changeId));
  }

  private latest(repo: string, prNumber: number, open: boolean): Change | undefined {
    const rows = this.db.conn
      .query<{ data: string; state: string }, [string, number]>(
        "SELECT data, state FROM changes WHERE repo = ?1 AND pr_number = ?2 ORDER BY n DESC",
      )
      .all(repo.toLowerCase(), prNumber);
    for (const row of rows) {
      const state = parseState(row.state);
      const terminal = state !== undefined && TERMINAL_STATES.includes(state);
      if (!open || !terminal) return decode(row.data);
    }
    return undefined;
  }

  /** The newest Change of the PR that is not merged, refused or abandoned. */
  openFor(repo: string, prNumber: number): Change | undefined {
    return this.latest(repo, prNumber, true);
  }

  /** The newest Change of the PR in any state. */
  latestFor(repo: string, prNumber: number): Change | undefined {
    return this.latest(repo, prNumber, false);
  }

  /** Whether a Change of the workstream merged. */
  anyMerged(r: ProjectRef, workstreamId: string): boolean {
    return (
      this.db.conn
        .query(
          `SELECT 1 FROM changes WHERE machine_id = ?1 AND project_id = ?2
             AND json_extract(data, '$.workstreamId') = ?3 AND state = ?4 LIMIT 1`,
        )
        .get(r.machineId, r.projectId, workstreamId, "merged") !== null
    );
  }

  /** The workstream's Changes that are not merged, refused or abandoned, oldest first. */
  unlanded(r: ProjectRef, workstreamId: string): Change[] {
    return this.db.conn
      .query<{ data: string; state: string }, [string, string, string]>(
        `SELECT data, state FROM changes WHERE machine_id = ?1 AND project_id = ?2
           AND json_extract(data, '$.workstreamId') = ?3 ORDER BY n`,
      )
      .all(r.machineId, r.projectId, workstreamId)
      .filter((row) => {
        const s = parseState(row.state);
        return s !== undefined && !TERMINAL_STATES.includes(s);
      })
      .map((row) => decode(row.data));
  }

  /** Every Change not merged, refused or abandoned, oldest first. */
  unlandedAll(): Change[] {
    return this.db.conn
      .query<{ data: string }, []>("SELECT data FROM changes WHERE state NOT IN ('merged', 'refused', 'abandoned') ORDER BY n")
      .all()
      .map((row) => decode(row.data));
  }

  /** The repos of the Changes not merged, refused or abandoned that wait on `prUrl` (their `after`). */
  afterRepos(prUrl: string): string[] {
    return this.db.conn
      .query<{ repo: string }, [string]>(
        `SELECT DISTINCT repo FROM changes, json_each(changes.data, '$.after') AS a
           WHERE a.value = ?1 AND state NOT IN ('merged', 'refused', 'abandoned') ORDER BY repo`,
      )
      .all(prUrl)
      .map((r) => r.repo);
  }

  /** The repo's Changes in these states, in train order. */
  inTrain(repo: string, states: ChangeState[]): Change[] {
    return this.db.conn
      .query<{ data: string; state: string }, [string]>("SELECT data, state FROM changes WHERE repo = ?1 ORDER BY train_order, n")
      .all(repo.toLowerCase())
      .filter((row) => {
        const s = parseState(row.state);
        return s !== undefined && states.includes(s);
      })
      .map((row) => decode(row.data));
  }

  /** Newest first. */
  list(filter: ListFilter): Change[] {
    return this.db.conn
      .query<{ data: string }, [string | null, string | null, string | null, string | null, number]>(
        `SELECT data FROM changes
           WHERE (?1 IS NULL OR (machine_id = ?1 AND project_id = ?2))
             AND (?3 IS NULL OR repo = ?3) AND (?4 IS NULL OR state = ?4)
           ORDER BY n DESC LIMIT ?5`,
      )
      .all(
        filter.projectRef?.machineId ?? null,
        filter.projectRef?.projectId ?? null,
        filter.repo?.toLowerCase() ?? null,
        filter.state ?? null,
        filter.limit,
      )
      .map((r) => decode(r.data));
  }

  /** Creates the repo's train for `r` if it has none; returns the train either way. */
  ensureTrain(repo: string, r: ProjectRef, nowMs: number): TrainRow {
    const key = repo.toLowerCase();
    this.db.conn
      .query("INSERT OR IGNORE INTO trains (repo, machine_id, project_id, watch_since_ms) VALUES (?1, ?2, ?3, ?4)")
      .run(key, r.machineId, r.projectId, nowMs);
    return this.train(key)!;
  }

  /** Moves the repo's train to another project, keeping its watch window. */
  rebindTrain(repo: string, r: ProjectRef): void {
    this.db.conn.query("UPDATE trains SET machine_id = ?1, project_id = ?2 WHERE repo = ?3").run(r.machineId, r.projectId, repo.toLowerCase());
  }

  /** Forgets the repo's train while it is still `r`'s; its Changes stay, as history. */
  dropTrain(repo: string, r: ProjectRef): void {
    this.db.conn
      .query("DELETE FROM trains WHERE repo = ?1 AND machine_id = ?2 AND project_id = ?3")
      .run(repo.toLowerCase(), r.machineId, r.projectId);
  }

  train(repo: string): TrainRow | undefined {
    const row = this.db.conn.query<TrainSql, [string]>("SELECT * FROM trains WHERE repo = ?1").get(repo.toLowerCase());
    return row ? toTrain(row) : undefined;
  }

  trains(): TrainRow[] {
    return this.db.conn.query<TrainSql, []>("SELECT * FROM trains ORDER BY repo").all().map(toTrain);
  }

  /** Moves the repo's watch past a merge outside the train, so it is reported once. */
  watchPast(repo: string, mergedMs: number): void {
    this.db.conn.query("UPDATE trains SET watch_since_ms = max(watch_since_ms, ?1) WHERE repo = ?2").run(mergedMs, repo.toLowerCase());
  }

  /** Starts watching the commit a merge put on `base`; a second merge of the same commit changes nothing. */
  watchMerge(w: Watch): void {
    this.db.conn
      .query(
        `INSERT OR IGNORE INTO train_watches (repo, sha, base, machine_id, project_id, pr_url, since_ms)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .run(w.repo.toLowerCase(), w.sha.toLowerCase(), w.base, w.projectRef.machineId, w.projectRef.projectId, w.prUrl, w.sinceMs);
  }

  /** The repo's merged commits still watched, oldest first. */
  watches(repo: string): Watch[] {
    return this.db.conn
      .query<
        { repo: string; sha: string; base: string; machine_id: string; project_id: string; pr_url: string; since_ms: number },
        [string]
      >(
        `SELECT repo, sha, base, machine_id, project_id, pr_url, since_ms FROM train_watches
           WHERE repo = ?1 ORDER BY since_ms`,
      )
      .all(repo.toLowerCase())
      .map((r) => ({
        repo: r.repo,
        sha: r.sha,
        base: r.base,
        projectRef: { machineId: r.machine_id, projectId: r.project_id },
        prUrl: r.pr_url,
        sinceMs: r.since_ms,
      }));
  }

  endWatch(repo: string, sha: string): void {
    this.db.conn.query("DELETE FROM train_watches WHERE repo = ?1 AND sha = ?2").run(repo.toLowerCase(), sha);
    this.db.conn.query("DELETE FROM train_watch_checks WHERE repo = ?1 AND sha = ?2").run(repo.toLowerCase(), sha);
  }

  /** What the watch did about the checks of merged commit `sha` (`putWatchCheck`), oldest first. */
  watchChecks(repo: string, sha: string): WatchCheck[] {
    return this.db.conn
      .query<{ check_name: string; run_id: number; did: string; at_ms: number }, [string, string]>(
        "SELECT check_name, run_id, did, at_ms FROM train_watch_checks WHERE repo = ?1 AND sha = ?2 ORDER BY at_ms, rowid",
      )
      .all(repo.toLowerCase(), sha)
      .map((r) => ({ name: r.check_name, runId: r.run_id, did: r.did, atMs: r.at_ms }));
  }

  /** Records that the watch did `did` about run `runId` of `check` on merged commit `sha`. */
  putWatchCheck(repo: string, sha: string, check: string, runId: number, did: string, atMs: number): void {
    this.db.conn
      .query("INSERT OR IGNORE INTO train_watch_checks (repo, sha, check_name, run_id, did, at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .run(repo.toLowerCase(), sha, check, runId, did, atMs);
  }

  /** The fix order `check` failing at `sha` itself is for, when it has one. */
  fixOrderAt(repo: string, check: string, sha: string): WorkstreamId | undefined {
    return (
      this.db.conn
        .query<{ workstream_id: string }, [string, string, string]>(
          "SELECT workstream_id FROM train_fix_orders WHERE repo = ?1 AND check_name = ?2 AND sha = ?3",
        )
        .get(repo.toLowerCase(), check, sha)?.workstream_id ?? undefined
    );
  }

  /** The newest fix order opened for `check` failing on the repo's base, and the commit it failed on. */
  fixOrder(repo: string, check: string): { sha: string; order: WorkstreamId } | undefined {
    const row = this.db.conn
      .query<{ sha: string; workstream_id: string }, [string, string]>(
        `SELECT sha, workstream_id FROM train_fix_orders WHERE repo = ?1 AND check_name = ?2
           ORDER BY at_ms DESC, rowid DESC LIMIT 1`,
      )
      .get(repo.toLowerCase(), check);
    return row ? { sha: row.sha, order: row.workstream_id } : undefined;
  }

  /** Records that `check` failing at `sha` is `order`'s to fix. */
  putFixOrder(repo: string, check: string, sha: string, order: WorkstreamId, atMs: number): void {
    this.db.conn
      .query("INSERT OR IGNORE INTO train_fix_orders (repo, check_name, sha, workstream_id, at_ms) VALUES (?1, ?2, ?3, ?4, ?5)")
      .run(repo.toLowerCase(), check, sha, order, atMs);
  }

  /** The train's `kind` of wait on the Change (`train_waits`). */
  wait(changeId: ChangeId, kind: string): Wait | undefined {
    const row = this.db.conn
      .query<{ head: string; since_ms: number; state: string }, [string, string]>(
        "SELECT head, since_ms, state FROM train_waits WHERE change_id = ?1 AND kind = ?2",
      )
      .get(changeId, kind);
    return row ? { head: row.head, sinceMs: row.since_ms, state: row.state } : undefined;
  }

  /**
   * Starts the `kind` of wait on the Change at `head` from `nowMs` in `state`, unless one is at that head already: true
   * when it started. A wait at another head starts over.
   */
  startWait(change: Change, kind: string, head: string, nowMs: number, state: string): boolean {
    return (
      this.db.conn
        .query(
          `INSERT INTO train_waits (change_id, kind, repo, head, since_ms, state) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (change_id, kind) DO UPDATE SET head = excluded.head, since_ms = excluded.since_ms,
             state = excluded.state WHERE head != excluded.head`,
        )
        .run(change.changeId, kind, change.repo.toLowerCase(), head, nowMs, state).changes === 1
    );
  }

  /** Moves the `kind` of wait on the Change at `head` to `state`; a wait at another head stays as it is. */
  setWait(changeId: ChangeId, kind: string, head: string, state: string): void {
    this.db.conn.query("UPDATE train_waits SET state = ?4 WHERE change_id = ?1 AND kind = ?2 AND head = ?3").run(changeId, kind, head, state);
  }

  endWait(changeId: ChangeId, kind: string): void {
    this.db.conn.query("DELETE FROM train_waits WHERE change_id = ?1 AND kind = ?2").run(changeId, kind);
  }

  /** Ends `repo`'s waits of these kinds on Changes not in `live`; other repos' stay. */
  keepWaits(repo: string, kinds: string[], live: ChangeId[]): void {
    this.db.conn
      .query(
        `DELETE FROM train_waits WHERE repo = ?1 AND kind IN (SELECT value FROM json_each(?2))
           AND change_id NOT IN (SELECT value FROM json_each(?3))`,
      )
      .run(repo.toLowerCase(), JSON.stringify(kinds), JSON.stringify(live));
  }

  /** Ends every `kind` of wait in `state`, of any repo. */
  endWaitsIn(kind: string, state: string): void {
    this.db.conn.query("DELETE FROM train_waits WHERE kind = ?1 AND state = ?2").run(kind, state);
  }

  /** The Changes waiting in a repo's queue, in train order, drafts at the back. */
  line(repo: string): Change[] {
    const queued = this.inTrain(repo, QUEUED_STATES);
    return [...queued.filter((c) => !isDraft(c)), ...queued.filter(isDraft)];
  }

  /** Each Change with its `position` in its repo's queue (absent when not queued). */
  positioned(changes: Change[]): Change[] {
    const queues = new Map<string, ChangeId[]>();
    for (const c of changes) if (!queues.has(c.repo)) queues.set(c.repo, this.line(c.repo).map((x) => x.changeId));
    return changes.map((c) => {
      const at = queues.get(c.repo)?.indexOf(c.changeId) ?? -1;
      const { position: _, ...rest } = c;
      return at < 0 ? rest : { ...rest, position: at };
    });
  }

  /** A repo's train as the API shows it: the Change at its head, and the queue in train order. */
  trainState(rawRepo: string): TrainState {
    const repo = rawRepo.toLowerCase();
    const head = this.inTrain(repo, HEAD_STATES)[0];
    return { repo, ...(head ? { head: head.changeId } : {}), queue: this.line(repo).map((c) => c.changeId) };
  }
}
