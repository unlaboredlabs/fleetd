// Webhook subscriptions and their delivery. One fiber per active subscription walks the event log from the
// subscription's cursor and posts each matching event in seq order, retrying the same event until it gets a 2xx
// (at least once, never skipping ahead). The cursor is persisted after every acknowledged event, so a hub restart
// resumes where delivery stopped.
import crypto from "node:crypto";
import path from "node:path";
import {
  Subscription,
  SubscriptionMachines,
  SubscriptionTypes,
  type AgentKeyInfo,
  type HubEvent,
  type HubEventType,
} from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import pkg from "../../package.json" with { type: "json" };
import * as Auth from "../auth/Auth.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as SecretBox from "./SecretBox.ts";
import * as Signing from "./Signing.ts";

/** Seconds before each retry of the same event: 1 s, 5 s, 30 s, 2 min, 10 min, then hourly. */
export const RETRY_DELAYS_SEC = [1, 5, 30, 120, 600] as const;
const RETRY_AFTER_SEC = 3600;
const FAILING_AFTER_MS = 60 * 60 * 1000;
const POST_TIMEOUT_MS = 15_000;

export interface WebhookRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Sends one request. Succeeds with the HTTP status; fails with a short reason that never includes the URL. */
export type Post = (request: WebhookRequest) => Effect.Effect<number, string>;

export interface CreateInput {
  readonly url: string;
  readonly types: typeof SubscriptionTypes.Type;
  readonly machines: typeof SubscriptionMachines.Type;
  readonly clientRequestId: string;
}

export class Webhooks extends Context.Service<
  Webhooks,
  {
    /** Delivers events appended from now on. A retry with the same clientRequestId returns the same subscription. */
    readonly create: (caller: AgentKeyInfo, input: CreateInput) => Effect.Effect<{ readonly subscriptionId: string; readonly secret: string }>;
    /** The caller's own subscriptions; an admin key sees all. Never includes secrets. */
    readonly list: (caller: AgentKeyInfo) => Effect.Effect<ReadonlyArray<Subscription>>;
    /** False when there is no such subscription the caller may delete. */
    readonly remove: (caller: AgentKeyInfo, subscriptionId: string) => Effect.Effect<boolean>;
    /** Emits webhook.failing once per failing spell for each subscription failing over an hour. Safe to call from a sweep. */
    readonly checkFailing: () => Effect.Effect<void>;
  }
>()("fleetd/hub/webhooks/Webhooks") {}

/** `fetch` with no redirects followed: anything but a 2xx is a failed attempt. */
export const fetchPost: Post = (request) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(POST_TIMEOUT_MS)]),
      });
      await response.body?.cancel();
      return response.status;
    },
    catch: (error) => {
      const cause = (error as { cause?: { code?: unknown } }).cause;
      if (typeof cause?.code === "string") return cause.code;
      return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request failed";
    },
  });

const decodeTypes = Schema.decodeSync(Schema.fromJsonString(SubscriptionTypes));
const encodeTypes = Schema.encodeSync(Schema.fromJsonString(SubscriptionTypes));
const decodeMachines = Schema.decodeSync(Schema.fromJsonString(SubscriptionMachines));
const encodeMachines = Schema.encodeSync(Schema.fromJsonString(SubscriptionMachines));

interface Row {
  readonly subscriptionId: string;
  readonly createdBy: string;
  readonly url: string;
  readonly types: typeof SubscriptionTypes.Type;
  readonly machines: typeof SubscriptionMachines.Type;
  readonly sealed: string;
  readonly state: Subscription["state"];
  readonly lastDeliveredSeq: number;
  readonly failingSinceMs: number | undefined;
}

const toRow = (r: Record<string, unknown>): Row => ({
  subscriptionId: String(r.subscription_id),
  createdBy: String(r.created_by),
  url: String(r.url),
  types: decodeTypes(String(r.types)),
  machines: decodeMachines(String(r.machines)),
  sealed: String(r.secret),
  state: r.state === "disabled" ? "disabled" : "active",
  lastDeliveredSeq: Number(r.last_delivered_seq),
  failingSinceMs: r.failing_since_ms === null ? undefined : Number(r.failing_since_ms),
});

const toSubscription = (row: Row): Subscription => ({
  subscriptionId: row.subscriptionId,
  kind: "webhook",
  url: row.url,
  types: row.types,
  machines: row.machines,
  createdBy: row.createdBy,
  state: row.state,
  lastDeliveredSeq: row.lastDeliveredSeq,
  ...(row.failingSinceMs === undefined ? {} : { failingSince: new Date(row.failingSinceMs).toISOString() }),
});

/** Logged instead of the URL, whose path or query may carry a token. */
const origin = (url: string) => new URL(url).origin;

const isAdmin = (caller: AgentKeyInfo) => caller.grants.some((g) => g.role === "admin");

export const make = (options: { readonly box: SecretBox.SecretBox; readonly post: Post }) =>
  Effect.gen(function* () {
    const { db } = yield* HubDb.HubDb;
    const events = yield* EventLog.EventLog;
    const auth = yield* Auth.Auth;
    const fibers = yield* FiberMap.make<string>();

    const sql = {
      insert: db.prepare(
        `INSERT INTO subscriptions (subscription_id, created_by, client_request_id, url, types, machines, secret, state, created_ms, last_delivered_seq)
         VALUES ($id, $createdBy, $clientRequestId, $url, $types, $machines, $secret, 'active', $now, $seq)
         ON CONFLICT (created_by, client_request_id) DO NOTHING`,
      ),
      byRequest: db.prepare("SELECT * FROM subscriptions WHERE created_by = ? AND client_request_id = ?"),
      get: db.prepare("SELECT * FROM subscriptions WHERE subscription_id = ?"),
      all: db.prepare("SELECT * FROM subscriptions ORDER BY created_ms, subscription_id"),
      active: db.prepare("SELECT * FROM subscriptions WHERE state = 'active'"),
      remove: db.prepare("DELETE FROM subscriptions WHERE subscription_id = ?"),
      disable: db.prepare("UPDATE subscriptions SET state = 'disabled' WHERE subscription_id = ?"),
      cursor: db.prepare("UPDATE subscriptions SET last_delivered_seq = ? WHERE subscription_id = ? AND last_delivered_seq < ?"),
      failing: db.prepare("UPDATE subscriptions SET failing_since_ms = COALESCE(failing_since_ms, ?) WHERE subscription_id = ?"),
      healthy: db.prepare("UPDATE subscriptions SET failing_since_ms = NULL, failing_reported = 0 WHERE subscription_id = ?"),
      overdue: db.prepare(
        "SELECT * FROM subscriptions WHERE state = 'active' AND failing_reported = 0 AND failing_since_ms IS NOT NULL AND failing_since_ms <= ?",
      ),
      reported: db.prepare("UPDATE subscriptions SET failing_reported = 1 WHERE subscription_id = ? AND failing_reported = 0"),
    };

    const checkFailing = () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const row of sql.overdue.all(now - FAILING_AFTER_MS).map(toRow)) {
          // The guarded update makes two concurrent checks emit once.
          if (sql.reported.run(row.subscriptionId).changes === 0) continue;
          const since = new Date(row.failingSinceMs!).toISOString();
          yield* events.append({
            at: new Date(now).toISOString(),
            type: "webhook.failing",
            summary: `Webhook ${row.subscriptionId} to ${origin(row.url)} has been failing since ${since}`,
            data: { subscriptionId: row.subscriptionId, failingSince: since, lastDeliveredSeq: row.lastDeliveredSeq },
          });
        }
      });

    /** Whether the subscription's filters and its creator's read grants (checked at delivery) let `event` through. */
    const matches = (row: Row, creator: AgentKeyInfo | undefined, event: HubEvent) =>
      creator !== undefined &&
      creator.revokedAt === undefined &&
      (row.machines === "*" ? true : event.machineId !== undefined && row.machines.includes(event.machineId)) &&
      (event.machineId === undefined ? auth.allows(creator, "read") : auth.allows(creator, "read", event.machineId));

    /** Posts `event` until a 2xx, following RETRY_DELAYS_SEC; reports webhook.failing as the spell crosses one hour. */
    const deliver = (row: Row, secret: string, event: HubEvent) =>
      Effect.gen(function* () {
        const body = JSON.stringify(event);
        const id = `${row.subscriptionId}_${event.seq}`;
        let failingSince = row.failingSinceMs;
        for (let attempt = 0; ; attempt++) {
          const now = yield* Clock.currentTimeMillis;
          const timestamp = Math.floor(now / 1000);
          const outcome = yield* Effect.result(
            options.post({
              url: row.url,
              body,
              headers: {
                "content-type": "application/json",
                "user-agent": `fleetd/${pkg.version}`,
                "webhook-id": id,
                "webhook-timestamp": String(timestamp),
                "webhook-signature": Signing.sign(secret, id, timestamp, body),
              },
            }),
          );
          if (outcome._tag === "Success" && outcome.success >= 200 && outcome.success < 300) {
            if (failingSince !== undefined) sql.healthy.run(row.subscriptionId);
            return;
          }
          if (failingSince === undefined) {
            failingSince = now;
            sql.failing.run(now, row.subscriptionId);
          }
          const delayMs = (RETRY_DELAYS_SEC[attempt] ?? RETRY_AFTER_SEC) * 1000;
          yield* Effect.logWarning("webhook delivery failed").pipe(
            Effect.annotateLogs({
              subscriptionId: row.subscriptionId,
              to: origin(row.url),
              seq: event.seq,
              error: outcome._tag === "Success" ? `HTTP ${outcome.success}` : outcome.failure,
              retryInSec: delayMs / 1000,
            }),
          );
          const reportAt = failingSince + FAILING_AFTER_MS;
          if (reportAt > now && reportAt < now + delayMs) {
            yield* Effect.sleep(reportAt - now);
            yield* checkFailing();
            yield* Effect.sleep(now + delayMs - reportAt);
          } else {
            if (reportAt <= now) yield* checkFailing();
            yield* Effect.sleep(delayMs);
          }
        }
      });

    const run = (row: Row) =>
      Effect.gen(function* () {
        let secret: string;
        try {
          secret = options.box.open(row.sealed);
        } catch {
          sql.disable.run(row.subscriptionId);
          return yield* Effect.logError("webhook subscription disabled: its secret no longer decrypts (was webhook.key replaced?)").pipe(
            Effect.annotateLogs({ subscriptionId: row.subscriptionId, fix: "delete it and create it again" }),
          );
        }
        let cursor = row.lastDeliveredSeq;
        for (;;) {
          const page = yield* events.wait({ cursor, timeoutSec: 50, ...(row.types === "*" ? {} : { types: row.types as ReadonlyArray<HubEventType> }) });
          const creator = page.events.length === 0 ? undefined : (yield* auth.list()).find((k) => k.keyId === row.createdBy);
          for (const event of page.events) {
            if (matches(row, creator, event)) yield* deliver(row, secret, event);
            sql.cursor.run(event.seq, row.subscriptionId, event.seq);
            cursor = event.seq;
          }
          if (page.cursor > cursor) {
            sql.cursor.run(page.cursor, row.subscriptionId, page.cursor);
            cursor = page.cursor;
          }
        }
      });

    const start = (row: Row) => FiberMap.run(fibers, row.subscriptionId, run(row), { onlyIfMissing: true });

    for (const row of sql.active.all().map(toRow)) yield* start(row);

    const visible = (caller: AgentKeyInfo, row: Row) => isAdmin(caller) || row.createdBy === caller.keyId;

    return Webhooks.of({
      create: (caller, input) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const head = yield* events.head();
          const secret = Signing.newSecret();
          sql.insert.run({
            id: `sub_${crypto.randomBytes(8).toString("hex")}`,
            createdBy: caller.keyId,
            clientRequestId: input.clientRequestId,
            url: input.url,
            types: encodeTypes(input.types),
            machines: encodeMachines(input.machines),
            secret: options.box.seal(secret),
            now,
            seq: head,
          });
          const row = toRow(sql.byRequest.get(caller.keyId, input.clientRequestId)!);
          yield* start(row);
          return { subscriptionId: row.subscriptionId, secret: options.box.open(row.sealed) };
        }),
      list: (caller) =>
        Effect.sync(() =>
          sql.all
            .all()
            .map(toRow)
            .filter((row) => visible(caller, row))
            .map(toSubscription),
        ),
      remove: (caller, subscriptionId) =>
        Effect.gen(function* () {
          const found = sql.get.get(subscriptionId);
          if (found === undefined || !visible(caller, toRow(found))) return false;
          yield* FiberMap.remove(fibers, subscriptionId);
          sql.remove.run(subscriptionId);
          return true;
        }),
      checkFailing,
    });
  });

/** Webhooks for the hub in `home`, sealing secrets with `<home>/webhook.key` (created 0600 on first start). */
export const layer = (home: string) =>
  Layer.effect(Webhooks, Effect.suspend(() => make({ box: SecretBox.fromKeyFile(path.join(home, "webhook.key")), post: fetchPost })));
