// Web Push to the human's paired devices: only events the hub marked for attention (attention/rules.ts), at most one per 20 minutes with the rest
// folded in as "+N more", held during quiet hours (`policy.quiet_hours`, 23:00-08:00 by default) unless they are money or irreversible. Each push is one
// line with no secret in it; `push.sent` records how many items and devices, never the text.
import path from "node:path";
import {
  type AgentKeyInfo,
  type AskId,
  type HubEvent,
  type McpToolError,
  type PushSubscribeInput as PushSubscribeInputSchema,
} from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { quietPolicy } from "../attention/policy.ts";
import { quietUntil } from "../attention/rules.ts";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import { isoAt } from "../ledger/LedgerRepo.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import { askLine, eventLine, type LoudItem, plan, pushLine } from "./rules.ts";
import { pushRequest, type PushRequest, type VapidKeys, vapidKeysFromFile } from "./webPush.ts";

type PushSubscribeInput = typeof PushSubscribeInputSchema.Type;

export class PushRefused extends Data.TaggedError("PushRefused")<McpToolError> {}

/** Delivers one request; resolves to the push service's HTTP status, or a network error code. */
export type PushPost = (request: PushRequest) => Effect.Effect<number, string>;

/** The VAPID `sub` claim: who runs this sender, for the push service's operator. */
const SUBJECT = "https://github.com/wynn-dev/fleetd";
const POST_TIMEOUT_MS = 10_000;

export const fetchPushPost: PushPost = (request) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: new Uint8Array(request.body),
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(POST_TIMEOUT_MS)]),
      });
      await response.body?.cancel();
      return response.status;
    },
    catch: (error) => String((error as { cause?: { code?: unknown } }).cause?.code ?? (error instanceof Error ? error.name : "error")),
  });

export class Push extends Context.Service<
  Push,
  {
    /** push_vapid_key: base64url of the hub's 65-byte public key. */
    readonly vapidKey: () => Effect.Effect<string>;
    /** push_subscribe: human keys only; the same endpoint again replaces it. */
    readonly subscribe: (caller: AgentKeyInfo, input: PushSubscribeInput) => Effect.Effect<void, PushRefused>;
    /** push_unsubscribe: false when no subscription had this endpoint. */
    readonly unsubscribe: (caller: AgentKeyInfo, endpoint: string) => Effect.Effect<boolean, PushRefused>;
  }
>()("fleetd/push/Push") {}

const humanOnly = (caller: AgentKeyInfo) =>
  caller.kind === "human"
    ? Effect.void
    : Effect.fail(
        new PushRefused({
          code: "forbidden",
          message: "Only a person's device gets Web Push.",
          fix: "Turn on push in the fleetd phone app, paired with `fleetd hub device add`; agents follow events with events_wait or fleetd listen.",
        }),
      );

export const make = (options: { readonly keys: VapidKeys; readonly post: PushPost }) =>
  Effect.gen(function* () {
    const { db } = yield* HubDb.HubDb;
    const events = yield* EventLog.EventLog;
    const asks = yield* Asks;
    const decisions = yield* Decisions;
    // Rings when the follower adds items; the sender loop also wakes on its own at the next window or quiet end.
    const signal = yield* Queue.dropping<void>(1);

    const sql = {
      upsert: db.prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_name, key_id, created_ms) VALUES ($endpoint, $p256dh, $auth, $device_name, $key_id, $created_ms)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, device_name = excluded.device_name, key_id = excluded.key_id`,
      ),
      remove: db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?"),
      // A revoked device gets nothing more.
      live: db.prepare(
        "SELECT s.endpoint, s.p256dh, s.auth FROM push_subscriptions s JOIN agent_keys k ON k.key_id = s.key_id WHERE k.revoked_ms IS NULL ORDER BY s.created_ms",
      ),
    };

    let pending: Array<LoudItem> = [];
    let lastSentMs: number | undefined;

    const quietEnd = (nowMs: number) => Effect.map(quietPolicy(decisions), ({ tz, quiet }) => quietUntil(nowMs, tz, quiet));

    /** An ask answered or withdrawn since it was queued no longer needs the human. */
    const stillLoud = (item: LoudItem) =>
      item.askId === undefined ? Effect.succeed(true) : Effect.map(asks.get(item.askId), (ask) => ask?.state === "open");

    const send = Effect.fnUntraced(function* (items: ReadonlyArray<LoudItem>, nowMs: number) {
      const text = pushLine(items);
      const targets = sql.live.all().map((row) => ({ endpoint: String(row.endpoint), p256dh: String(row.p256dh), auth: String(row.auth) }));
      let delivered = 0;
      for (const target of targets) {
        const status = yield* Effect.result(options.post(pushRequest(target, text, options.keys, SUBJECT, nowMs)));
        if (status._tag === "Success" && status.success >= 200 && status.success < 300) delivered++;
        else if (status._tag === "Success" && (status.success === 404 || status.success === 410)) {
          // The browser dropped this subscription; the push service says so with 404 or 410.
          sql.remove.run(target.endpoint);
          yield* Effect.logInfo("push subscription gone; removed").pipe(Effect.annotateLogs({ status: status.success }));
        } else {
          yield* Effect.logWarning("push not delivered").pipe(Effect.annotateLogs({ result: status._tag === "Success" ? status.success : status.failure }));
        }
      }
      yield* events.append({
        at: isoAt(nowMs),
        type: "push.sent",
        summary: `Web Push to ${delivered} of ${targets.length} device${targets.length === 1 ? "" : "s"}, covering ${items.length} item${items.length === 1 ? "" : "s"}`,
        data: { items: items.length, devices: delivered },
      });
    });

    /** Sends what the rules allow now; how long until it should look again, or undefined to wait for new items. */
    const flush = Effect.gen(function* () {
      for (;;) {
        const now = yield* Clock.currentTimeMillis;
        const live: Array<LoudItem> = [];
        for (const item of pending) if (yield* stillLoud(item)) live.push(item);
        pending = live;
        const next = plan(pending, now, lastSentMs, yield* quietEnd(now));
        if (next.kind === "idle") return undefined;
        if (next.kind === "wait") return Math.max(1000, next.untilMs - now);
        pending = [...next.held];
        lastSentMs = now;
        yield* send(next.items, now);
      }
    });

    const loudFrom = Effect.fnUntraced(function* (event: HubEvent) {
      if (event.attention === undefined) return undefined;
      const breaksQuiet = event.attention === "urgent";
      if (event.type !== "ask.created") return { line: eventLine(event.summary), breaksQuiet } satisfies LoudItem;
      const data = event.data as { readonly askId?: AskId; readonly reopened?: boolean } | undefined;
      const ask = data?.askId === undefined ? undefined : yield* asks.get(data.askId);
      return ask === undefined ? undefined : ({ line: askLine(ask, data?.reopened === true), breaksQuiet, askId: ask.askId } satisfies LoudItem);
    });

    let cursor = yield* events.head();
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const page = yield* events.wait({ cursor, timeoutSec: 3600 });
          cursor = page.cursor;
          let added = false;
          for (const event of page.events) {
            const item = yield* loudFrom(event);
            if (item === undefined) continue;
            pending.push(item);
            added = true;
          }
          if (added) yield* Queue.offer(signal, undefined);
        }).pipe(Effect.catchCause((cause) => Effect.logError("push: follow failed", { cause }))),
      ),
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const waitMs = yield* flush;
          const woken = Queue.take(signal);
          yield* waitMs === undefined ? woken : Effect.race(Effect.sleep(Duration.millis(waitMs)), woken);
        }).pipe(Effect.catchCause((cause) => Effect.logError("push: send failed", { cause }))),
      ),
    );

    return Push.of({
      vapidKey: () => Effect.succeed(options.keys.publicKey),
      subscribe: (caller, input) =>
        Effect.andThen(humanOnly(caller), () =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.sync(() =>
              void sql.upsert.run({
                endpoint: input.endpoint,
                p256dh: input.keys.p256dh,
                auth: input.keys.auth,
                device_name: input.deviceName,
                key_id: caller.keyId,
                created_ms: now,
              }),
            ),
          ),
        ),
      unsubscribe: (caller, endpoint) => Effect.andThen(humanOnly(caller), () => Effect.sync(() => sql.remove.run(endpoint).changes > 0)),
    });
  });

/** Web Push for the hub in `home`, signing with `<home>/vapid.json` (generated 0600 on first start). */
export const layer = (home: string, post: PushPost = fetchPushPost) =>
  Layer.effect(Push, Effect.suspend(() => make({ keys: vapidKeysFromFile(path.join(home, "vapid.json")), post })));
