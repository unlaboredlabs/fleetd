// The inbox's state and every change to it, as pure functions. The store (store.ts) feeds them hub frames and call
// results; the cards read the result. One state for every surface, so answering on the board clears the panel too.
import type { HubEvent } from "../../../shared/hub";
import { UNDO_WINDOW_MS, pickLabel, type CardPick } from "./ask";
import type { Ask, AskOption, InboxReplyOutput, Machine } from "./contracts";

/** An ask answered from this app, shown collapsed until its receipt has been seen. */
export interface Answered {
  readonly ask: Ask;
  readonly label: string;
  /** Local epoch ms; null when the hub keeps no undo window for this answer (approve, do, an older hub). */
  readonly undoBy: number | null;
  /** The receipt: when the lead got it. Null while sending or inside the undo window. */
  readonly deliveredAt: string | null;
  readonly sending: boolean;
  /** Secret asks: the node's fingerprint of what it stored (8 hex characters), to compare, never the value. */
  readonly fingerprint?: string;
}

/** A failed or late event worth a human's look, from the snapshot's `attention` and loud events since. */
export interface AttentionItem {
  readonly seq: number;
  readonly at: string;
  readonly summary: string;
  readonly urgent: boolean;
  readonly project: string | null;
}

export interface InboxState {
  readonly live: boolean;
  readonly loaded: boolean;
  /** Open asks in the hub's order: newest batch first, then by number. */
  readonly open: readonly Ask[];
  readonly answered: ReadonlyMap<string, Answered>;
  /** Per ask: why its last answer was refused. */
  readonly errors: ReadonlyMap<string, string>;
  readonly attention: readonly AttentionItem[];
  /** "machineId/projectId" → project title. */
  readonly projects: ReadonlyMap<string, string>;
  /** workstreamId → order title. */
  readonly orders: ReadonlyMap<string, string>;
  /** machineId → what a secret ask needs to seal to it. */
  readonly machines: ReadonlyMap<string, Machine>;
  /** The reply field's last result: the hub's echo, or its hint when it could not read the reply. */
  readonly replyEcho: { readonly ok: boolean; readonly text: string } | null;
  readonly loadError: string | null;
}

export const emptyInbox: InboxState = {
  live: false,
  loaded: false,
  open: [],
  answered: new Map(),
  errors: new Map(),
  attention: [],
  projects: new Map(),
  orders: new Map(),
  machines: new Map(),
  replyEcho: null,
  loadError: null,
};

const ATTENTION_MAX = 10;

const without = <V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> => {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
};

const withEntry = <V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> =>
  new Map(map).set(key, value);

export const projectKey = (machineId: string, projectId: string): string => `${machineId}/${projectId}`;

/** A hub from before labels sends options as bare keys; everything past here sees AskOption. */
export const normalizeAsk = (ask: Ask): Ask => {
  const options: readonly unknown[] | undefined = ask.options;
  if (options === undefined || options.every((o) => typeof o !== "string")) return ask;
  return { ...ask, options: options.map((o) => (typeof o === "string" ? { key: o } : (o as AskOption))) };
};

/** A fresh asks_list. Asks answered here stay collapsed even if a fetch sent before the answer still lists them. */
export const withAsks = (state: InboxState, asks: readonly Ask[]): InboxState => ({
  ...state,
  loaded: true,
  loadError: null,
  open: asks.filter((a) => a.state === "open" && !state.answered.has(a.askId)).map(normalizeAsk),
});

export const answering = (state: InboxState, ask: Ask, pick: CardPick): InboxState => answeringAs(state, ask, pickLabel(ask, pick));

/** An answer on its way, collapsed to "You chose: <label>". */
export const answeringAs = (state: InboxState, ask: Ask, label: string): InboxState => ({
  ...state,
  open: state.open.filter((a) => a.askId !== ask.askId),
  errors: without(state.errors, ask.askId),
  answered: withEntry(state.answered, ask.askId, {
    ask,
    label,
    undoBy: null,
    deliveredAt: null,
    sending: true,
  }),
});

/** Puts an ask back as open, with the reason when there is one. */
const reopen = (state: InboxState, ask: Ask, error: string | null): InboxState => ({
  ...state,
  answered: without(state.answered, ask.askId),
  open: state.open.some((a) => a.askId === ask.askId) ? state.open : insertByNumber(state.open, ask),
  errors: error === null ? without(state.errors, ask.askId) : withEntry(state.errors, ask.askId, error),
});

const insertByNumber = (open: readonly Ask[], ask: Ask): Ask[] => {
  const at = open.findIndex((a) => a.batchId === ask.batchId && (a.number ?? 0) > (ask.number ?? 0));
  return at === -1 ? [...open, ask] : [...open.slice(0, at), ask, ...open.slice(at)];
};

/**
 * inbox_reply's result for a card's answer. The undo window is timed from here, not from the hub's clock: the hub
 * opened it a moment before the reply arrived, so the local deadline can only be early, never late.
 */
export const replied = (state: InboxState, askId: string, output: InboxReplyOutput, nowMs: number): InboxState => {
  const pending = state.answered.get(askId);
  if (pending === undefined) return state;
  const applied = output.applied.find((a) => a.askId === askId);
  if (!output.parsed || applied === undefined) {
    return reopen(state, pending.ask, output.hint ?? output.echo ?? "The hub did not take this answer.");
  }
  const undoable = applied.undoUntil !== undefined;
  return {
    ...state,
    answered: withEntry(state.answered, askId, {
      ask: pending.ask,
      label: applied.label ?? pending.label,
      undoBy: undoable ? nowMs + UNDO_WINDOW_MS : null,
      deliveredAt: undoable ? null : new Date(nowMs).toISOString(),
      sending: false,
    }),
  };
};

/** A secret the node took: no undo, the receipt is the submit itself. */
export const secretSent = (state: InboxState, askId: string, nowMs: number, fingerprint: string): InboxState => {
  const entry = state.answered.get(askId);
  if (entry === undefined) return state;
  return {
    ...state,
    answered: withEntry(state.answered, askId, {
      ...entry,
      sending: false,
      deliveredAt: new Date(nowMs).toISOString(),
      ...(fingerprint === "" ? {} : { fingerprint }),
    }),
  };
};

export const answerFailed = (state: InboxState, askId: string, message: string): InboxState => {
  const pending = state.answered.get(askId);
  return pending === undefined ? state : reopen(state, pending.ask, message);
};

/** inbox_undo succeeded: the hub's copy of the ask, open again. */
export const undone = (state: InboxState, ask: Ask): InboxState => reopen(state, normalizeAsk(ask), null);

export const undoFailed = (state: InboxState, askId: string, message: string): InboxState => {
  const entry = state.answered.get(askId);
  if (entry === undefined) return state;
  return {
    ...state,
    answered: withEntry(state.answered, askId, { ...entry, undoBy: null }),
    errors: withEntry(state.errors, askId, message),
  };
};

/** Drops a receipt once it has been seen. */
export const dismissed = (state: InboxState, askId: string): InboxState => ({
  ...state,
  answered: without(state.answered, askId),
  errors: without(state.errors, askId),
});

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const toAttention = (event: HubEvent, projects: ReadonlyMap<string, string>): AttentionItem | null => {
  const level = event["attention"];
  if (level !== "loud" && level !== "urgent") return null;
  const machine = str(event["machineId"]);
  const project = str(event["projectId"]);
  return {
    seq: event.seq,
    at: str(event["at"]) ?? "",
    summary: str(event["summary"]) ?? humanEventType(event.type),
    urgent: level === "urgent",
    project: machine !== null && project !== null ? (projects.get(projectKey(machine, project)) ?? null) : null,
  };
};

/** "thread.failed" → "Thread failed", for an event the hub sent without a summary. */
const humanEventType = (type: string): string => {
  const words = type.replace(/[._]/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The snapshot: who the projects are and what needed attention before this window connected. */
export const withSnapshot = (state: InboxState, snapshot: Readonly<Record<string, unknown>>): InboxState => {
  const projects = new Map<string, string>();
  const list = snapshot["projects"];
  for (const raw of Array.isArray(list) ? list : []) {
    const p = record(raw);
    const machine = str(p?.["machineId"]);
    const id = str(p?.["projectId"]);
    const title = str(p?.["title"]);
    if (machine !== null && id !== null && title !== null) projects.set(projectKey(machine, id), title);
  }
  const machines = new Map<string, Machine>();
  const machineList = snapshot["machines"];
  for (const raw of Array.isArray(machineList) ? machineList : []) {
    const m = record(raw);
    const id = str(m?.["machineId"]);
    const status = m?.["status"];
    if (id === null || (status !== "online" && status !== "offline" && status !== "degraded")) continue;
    const key = str(m?.["boxPubKey"]);
    machines.set(id, { machineId: id, name: str(m?.["name"]) ?? id, status, ...(key === null ? {} : { boxPubKey: key }) });
  }
  const events = snapshot["attention"];
  const attention: AttentionItem[] = [];
  for (const raw of Array.isArray(events) ? events : []) {
    const e = record(raw);
    if (e === null || typeof e["seq"] !== "number" || typeof e["type"] !== "string") continue;
    const item = toAttention(e as HubEvent, projects);
    if (item !== null) attention.push(item);
  }
  attention.sort((a, b) => b.seq - a.seq);
  return { ...state, live: true, projects, machines, attention: attention.slice(0, ATTENTION_MAX) };
};

/** What an event changes here directly; the store refetches the asks for the rest (`refetchesAsks`). */
export const withEvent = (state: InboxState, event: HubEvent): InboxState => {
  const data = record(event["data"]);
  const askId = str(data?.["askId"]);
  if (event.type === "ask.delivered" && askId !== null) {
    const entry = state.answered.get(askId);
    if (entry === undefined) return state;
    const at = str(data?.["deliveredAt"]) ?? str(event["at"]) ?? new Date().toISOString();
    return { ...state, answered: withEntry(state.answered, askId, { ...entry, undoBy: null, deliveredAt: at }) };
  }
  if (event.type === "ask.undone" && askId !== null) {
    // Taken back elsewhere (the CLI, the phone): the refetch brings it back as open.
    return { ...state, answered: without(state.answered, askId) };
  }
  const item = toAttention(event, state.projects);
  if (item === null || state.attention.some((a) => a.seq === item.seq)) return state;
  return { ...state, attention: [item, ...state.attention].slice(0, ATTENTION_MAX) };
};

export const refetchesAsks = (type: string): boolean =>
  type.startsWith("ask.") || type === "batch.ready" || type === "decision.recorded" || type === "gated.ran";

/** Order titles from orders_board, for the card headers. */
export const withOrders = (state: InboxState, orders: ReadonlyArray<{ workstreamId: string; title: string }>): InboxState => {
  const next = new Map(state.orders);
  for (const o of orders) if (o.title.trim() !== "") next.set(o.workstreamId, o.title);
  return { ...state, orders: next };
};

/** Whether an ask names an order whose title we don't have yet. */
export const missingOrders = (state: InboxState): boolean =>
  state.open.some((a) => a.workstreamId !== undefined && !state.orders.has(a.workstreamId));

/** What the card header says: never an id. */
export const askPlace = (
  state: Pick<InboxState, "projects" | "orders">,
  ask: Ask,
): { readonly project: string; readonly order: string | null } => {
  const ref = ask.projectRef;
  const project =
    ref === undefined ? "No project yet" : (state.projects.get(projectKey(ref.machineId, ref.projectId)) ?? "Project");
  const order = ask.workstreamId === undefined ? null : (state.orders.get(ask.workstreamId) ?? null);
  return { project, order };
};

const batchNumber = (ask: Ask): number => Number(ask.batchId?.slice(1) ?? 0);

/**
 * The asks a surface lists: open ones plus those answered here that still show "You chose", in the inbox's order
 * (newest batch first, then by number) so a card collapses in place instead of jumping.
 */
export const needsYou = (state: InboxState, workstreamId?: string): Ask[] => {
  const all = [...state.open, ...[...state.answered.values()].map((a) => a.ask)];
  const mine = workstreamId === undefined ? all : all.filter((a) => a.workstreamId === workstreamId);
  return mine.sort((a, b) => batchNumber(b) - batchNumber(a) || (a.number ?? 0) - (b.number ?? 0));
};

export type SecretTarget =
  | { readonly ok: true; readonly machine: string; readonly boxPubKey: string; readonly where: string }
  | { readonly ok: false; readonly message: string; readonly fix: string };

/** secrets.rs parse_secret_sink, as far as the card needs it: the machine and the path. */
const SINK = /^(env|file):([a-z0-9-]{1,32}):(\/[^\n\r]*)$/u;

/** Where a secret ask's value goes and the key to seal it to, or why it can't be sent now and what to do. */
export const secretTarget = (state: Pick<InboxState, "machines">, ask: Ask): SecretTarget => {
  const sink = SINK.exec(ask.sink ?? "");
  const [, kind, machineId, path] = sink ?? [];
  if (kind === undefined || machineId === undefined || path === undefined) {
    return { ok: false, message: "This ask doesn't say where the secret goes.", fix: "Decline it; the lead will ask again with a destination." };
  }
  const machine = state.machines.get(machineId);
  if (machine === undefined) {
    return { ok: false, message: `The hub doesn't know the machine ${machineId}.`, fix: "Decline it, or add that machine and ask the lead again." };
  }
  if (machine.boxPubKey === undefined) {
    return { ok: false, message: `${machine.name} takes no secrets yet: its node has no box key.`, fix: `Update fleetd on ${machine.name}, then send the secret.` };
  }
  if (machine.status === "offline") {
    return { ok: false, message: `${machine.name} is offline.`, fix: `Send the secret once ${machine.name} is back online.` };
  }
  const where =
    kind === "env"
      ? `as ${ask.envName ?? "its variable"} in ${path} on ${machine.name}`
      : `to ${path} on ${machine.name}`;
  return { ok: true, machine: machine.name, boxPubKey: machine.boxPubKey, where };
};
