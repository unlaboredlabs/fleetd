// The /app protocol's types, generated from crates/fleetd-contracts (see generated/contracts.ts), plus the typed
// views the app uses: a call map keyed by tool, and hub events narrowed by type.
import type { HubError } from "../hub";
import type {
  HubEvent,
  HubEventDataMap,
  HubEventType,
  KnownHubEventType,
  ToolMap,
} from "./generated/contracts";

export type * from "./generated/contracts";
export * from "./generated/contracts";

export type ToolName = keyof ToolMap;
export type ToolInput<T extends ToolName> = ToolMap[T]["input"];
export type ToolOutput<T extends ToolName> = ToolMap[T]["output"];

export type TypedCallOutcome<T extends ToolName> =
  | { readonly ok: true; readonly output: ToolOutput<T> }
  | { readonly ok: false; readonly error: HubError };

/** `window.fleetd.hub.call`'s shape, so this module stays free of the renderer's globals. */
export type RawCall = (tool: string, input: unknown, options?: { timeoutMs?: number }) => Promise<
  { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError }
>;

export type Call = <T extends ToolName>(
  tool: T,
  input: ToolInput<T>,
  options?: { timeoutMs?: number },
) => Promise<TypedCallOutcome<T>>;

/**
 * `call("order_get", { workstreamId })` with the input checked and the output typed. The output is not decoded
 * again here: the hub validated it against the same contracts, and main checked the frame.
 */
export const typedCall =
  (raw: RawCall): Call =>
  async (tool, input, options) =>
    (await raw(tool, input, options)) as TypedCallOutcome<typeof tool>;

/** Any `data` over the hub's 2 KB cap arrives as this instead of its shape. */
export interface TruncatedData {
  readonly truncated: true;
}

/** The declared `data` of event type `K`; `unknown` for types without one (and for a newer hub's types). */
export type EventData<K extends HubEventType> = K extends keyof HubEventDataMap ? HubEventDataMap[K] : unknown;

/** A hub event whose `type` is `K`, with `data` typed to match. */
export type HubEventOf<K extends HubEventType> = Omit<HubEvent, "type" | "data"> & {
  type: K;
  data?: EventData<K> | TruncatedData;
};

/** Every event type this build knows, as a union to switch on; anything else is a generic `HubEvent`. */
export type TypedHubEvent = { [K in KnownHubEventType]: HubEventOf<K> }[KnownHubEventType];

/** Narrows `event` to one of `types`. */
export const isEvent = <K extends KnownHubEventType>(
  event: HubEvent,
  ...types: readonly K[]
): event is HubEvent & HubEventOf<K> => (types as readonly string[]).includes(event.type);

const isTruncated = (data: unknown): data is TruncatedData =>
  typeof data === "object" &&
  data !== null &&
  (data as Partial<TruncatedData>).truncated === true &&
  Object.keys(data).length === 1;

/** The event's declared data, or undefined when it has none or the hub cut it for size. */
export const eventData = <K extends KnownHubEventType>(event: HubEventOf<K>): EventData<K> | undefined =>
  event.data === undefined || isTruncated(event.data) ? undefined : event.data;

/** The id an event's data names, whatever its type: the joins the store makes from events. */
export const dataField = (event: HubEvent, field: string): string | undefined => {
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null) return undefined;
  const value: unknown = (data as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
};
