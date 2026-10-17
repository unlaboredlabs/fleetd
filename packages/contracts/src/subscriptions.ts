import { Schema } from "effect";
import { HubEventType } from "./events.ts";
import { EventSeq, MachineId, Timestamp } from "./ids.ts";

export const isHttpUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/** Absolute http(s) URL; `file:` and every other scheme are refused. */
export const WebhookUrl = Schema.String.check(
  Schema.makeFilter(isHttpUrl, { expected: "an absolute http:// or https:// URL" }),
).annotate({ identifier: "WebhookUrl" });

export const SubscriptionTypes = Schema.Union([Schema.Literal("*"), Schema.Array(HubEventType)]);
export const SubscriptionMachines = Schema.Union([Schema.Literal("*"), Schema.Array(MachineId)]);

export const SubscriptionState = Schema.Literals(["active", "disabled"]);
export type SubscriptionState = typeof SubscriptionState.Type;

/** A webhook push target. Its signing secret is shown once by subscription_set and never returned again. */
export const Subscription = Schema.Struct({
  subscriptionId: Schema.NonEmptyString,
  kind: Schema.Literal("webhook"),
  url: WebhookUrl,
  types: SubscriptionTypes,
  machines: SubscriptionMachines,
  /** keyId of the agent key that created it. */
  createdBy: Schema.String,
  state: SubscriptionState,
  lastDeliveredSeq: Schema.optionalKey(EventSeq),
  /** When deliveries started failing; absent while healthy. */
  failingSince: Schema.optionalKey(Timestamp),
}).annotate({ identifier: "Subscription" });
export type Subscription = typeof Subscription.Type;
