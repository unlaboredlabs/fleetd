// The inbox's own state is only what the person did here: answers on their way, the undo window, receipts, and the
// reply field's echo. Everything from the hub (asks, projects, orders, machines, events) is read from E1's data
// layer (src/renderer/src/data); the functions below combine the two, as pure functions.
import type { Ask, AskOption, HubEvent, InboxReplyOutput, Machine } from "../../../shared/contracts";
import type { InboxItem } from "../../src/data/selectors";
import type { DataState } from "../../src/data/store";
import { UNDO_WINDOW_MS, pickLabel, type CardPick } from "./ask";

/** An ask answered from this app, shown collapsed ("You chose: …") until its receipt has been seen. */
export interface Answered {
  /** The ask as it was when answered: the data layer drops it from the open asks once the hub has the answer. */
  readonly ask: Ask;
  readonly label: string;
  /** Local epoch ms; null when the hub keeps no undo window for this answer (approve, do, an older hub). */
  readonly undoBy: number | null;
  /** The receipt when it is known here (no undo window, or a secret the node stored); else `ask.delivered`. */
  readonly deliveredAt: string | null;
  readonly sending: boolean;
  /** Undo went through: the card shows "Taking it back…" until the data layer lists the ask as open again. */
  readonly undone: boolean;
  /** Secret asks: the node's fingerprint of what it stored (8 hex characters), to compare, never the value. */
  readonly fingerprint?: string;
}

export interface InboxUi {
  readonly answered: ReadonlyMap<string, Answered>;
  /** Per ask: why its last answer or undo was refused. */
  readonly errors: ReadonlyMap<string, string>;
  /** The reply field's last result: the hub's echo, or its hint when it could not read the reply. */
  readonly replyEcho: { readonly ok: boolean; readonly text: string } | null;
}

export const emptyUi: InboxUi = { answered: new Map(), errors: new Map(), replyEcho: null };

const without = <V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> => {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
};

const withEntry = <V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> =>
  new Map(map).set(key, value);

export const answering = (ui: InboxUi, ask: Ask, pick: CardPick): InboxUi => answeringAs(ui, ask, pickLabel(ask, pick));

/** An answer on its way, collapsed to "You chose: <label>". */
export const answeringAs = (ui: InboxUi, ask: Ask, label: string): InboxUi => ({
  ...ui,
  errors: without(ui.errors, ask.askId),
  answered: withEntry(ui.answered, ask.askId, { ask, label, undoBy: null, deliveredAt: null, sending: true, undone: false }),
});

/** Back to an open card, with the reason when there is one. */
const reopen = (ui: InboxUi, askId: string, error: string | null): InboxUi => ({
  ...ui,
  answered: without(ui.answered, askId),
  errors: error === null ? without(ui.errors, askId) : withEntry(ui.errors, askId, error),
});

/**
 * inbox_reply's result for a card's answer. The undo window is timed from here, not from the hub's clock: the hub
 * opened it a moment before the reply arrived, so the local deadline can only be early, never late.
 */
export const replied = (ui: InboxUi, askId: string, output: InboxReplyOutput, nowMs: number): InboxUi => {
  const pending = ui.answered.get(askId);
  if (pending === undefined) return ui;
  const applied = output.applied.find((a) => a.askId === askId);
  if (!output.parsed || applied === undefined) {
    return reopen(ui, askId, output.hint ?? output.echo ?? "The hub did not take this answer.");
  }
  const undoable = applied.undoUntil !== undefined;
  return {
    ...ui,
    answered: withEntry(ui.answered, askId, {
      ...pending,
      label: applied.label ?? pending.label,
      undoBy: undoable ? nowMs + UNDO_WINDOW_MS : null,
      deliveredAt: undoable ? null : new Date(nowMs).toISOString(),
      sending: false,
    }),
  };
};

/** A secret the node took: no undo, the receipt is the submit itself. */
export const secretSent = (ui: InboxUi, askId: string, nowMs: number, fingerprint: string): InboxUi => {
  const entry = ui.answered.get(askId);
  if (entry === undefined) return ui;
  return {
    ...ui,
    answered: withEntry(ui.answered, askId, {
      ...entry,
      sending: false,
      deliveredAt: new Date(nowMs).toISOString(),
      ...(fingerprint === "" ? {} : { fingerprint }),
    }),
  };
};

export const answerFailed = (ui: InboxUi, askId: string, message: string): InboxUi =>
  ui.answered.has(askId) ? reopen(ui, askId, message) : ui;

/** inbox_undo went through; the card waits for the data layer to list the ask as open again. */
export const undone = (ui: InboxUi, askId: string): InboxUi => {
  const entry = ui.answered.get(askId);
  if (entry === undefined) return ui;
  return { ...ui, errors: without(ui.errors, askId), answered: withEntry(ui.answered, askId, { ...entry, undoBy: null, undone: true }) };
};

export const undoFailed = (ui: InboxUi, askId: string, message: string): InboxUi => {
  const entry = ui.answered.get(askId);
  if (entry === undefined) return ui;
  return {
    ...ui,
    answered: withEntry(ui.answered, askId, { ...entry, undoBy: null }),
    errors: withEntry(ui.errors, askId, message),
  };
};

/** Drops a receipt once it has been seen, or an undone answer once its ask is open again. */
export const dismissed = (ui: InboxUi, askId: string): InboxUi => ({
  ...ui,
  answered: without(ui.answered, askId),
  errors: without(ui.errors, askId),
});

/** A hub from before labels sends options as bare keys; everything past here sees AskOption. */
export const normalizeAsk = (ask: Ask): Ask => {
  const options: readonly unknown[] | undefined = ask.options;
  if (options === undefined || options.every((o) => typeof o !== "string")) return ask;
  return { ...ask, options: options.map((o) => (typeof o === "string" ? { key: o } : (o as AskOption))) };
};

const batchNumber = (ask: Ask): number => Number(ask.batchId?.slice(1) ?? 0);

/**
 * The asks a surface lists: the data layer's open asks plus those answered here that still show "You chose", in
 * the inbox's order (newest batch first, then by number) so a card collapses in place instead of jumping. An ask
 * answered here hides its open copy until the hub catches up; an undone one gives way to it as soon as it is back.
 * Undefined while the asks are loading.
 */
export const needsYou = (
  open: readonly InboxItem[] | undefined,
  ui: InboxUi,
  only?: { readonly workstreamId?: string | undefined; readonly project?: string | undefined },
): Ask[] | undefined => {
  if (open === undefined) return undefined;
  const openIds = new Set(open.map((i) => i.ask.askId));
  const answered = [...ui.answered.values()].filter((a) => !(a.undone && openIds.has(a.ask.askId))).map((a) => a.ask);
  const answeredIds = new Set(answered.map((a) => a.askId));
  const all = [...open.map((i) => normalizeAsk(i.ask)).filter((a) => !answeredIds.has(a.askId)), ...answered];
  const mine = all.filter(
    (a) =>
      (only?.workstreamId === undefined || a.workstreamId === only.workstreamId) &&
      (only?.project === undefined || (a.projectRef !== undefined && `${a.projectRef.machineId}/${a.projectRef.projectId}` === only.project)),
  );
  return mine.sort((a, b) => batchNumber(b) - batchNumber(a) || (a.number ?? 0) - (b.number ?? 0));
};

/** When the lead got an answer: the latest `ask.delivered` for the ask among the layer's recent events. */
export const deliveredAt = (events: readonly HubEvent[], askId: string): string | undefined => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    const data = e?.data as { askId?: unknown; deliveredAt?: unknown } | undefined;
    if (e?.type === "ask.delivered" && data?.askId === askId) return typeof data.deliveredAt === "string" ? data.deliveredAt : e.at;
  }
  return undefined;
};

/** A failed or late event worth a human's look, from the snapshot's `attention` and loud events since. */
export interface AttentionItem {
  readonly seq: number;
  readonly at: string;
  readonly summary: string;
  readonly urgent: boolean;
  readonly project: string | null;
}

const ATTENTION_MAX = 10;

const humanEventType = (type: string): string => {
  const words = type.replace(/[._]/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * The snapshot's attention events and loud ones since, newest first, at most ten. An ask's filing is left out: while
 * the ask is open the list above shows it, and once it is answered the event would still say it needs a look.
 */
export const attentionItems = (s: Pick<DataState, "attention" | "events" | "projects">): AttentionItem[] => {
  const seen = new Set<number>();
  const out: AttentionItem[] = [];
  for (const e of [...s.attention, ...s.events]) {
    if ((e.attention !== "loud" && e.attention !== "urgent") || e.type === "ask.created" || seen.has(e.seq)) continue;
    seen.add(e.seq);
    const project =
      e.machineId !== undefined && e.projectId !== undefined ? (s.projects[`${e.machineId}/${e.projectId}`]?.title ?? null) : null;
    out.push({ seq: e.seq, at: e.at, summary: e.summary === "" ? humanEventType(e.type) : e.summary, urgent: e.attention === "urgent", project });
  }
  return out.sort((a, b) => b.seq - a.seq).slice(0, ATTENTION_MAX);
};

/** What the card header says: never an id. */
export const askPlace = (
  s: Pick<DataState, "projects" | "orders">,
  ask: Ask,
): { readonly project: string; readonly order: string | null } => {
  const ref = ask.projectRef;
  const project = ref === undefined ? "No project yet" : (s.projects[`${ref.machineId}/${ref.projectId}`]?.title ?? "Project");
  const order = ask.workstreamId === undefined ? null : (s.orders?.[ask.workstreamId]?.title ?? null);
  return { project, order: order === null || order.trim() === "" ? null : order };
};

export type SecretTarget =
  | { readonly ok: true; readonly machine: string; readonly boxPubKey: string; readonly where: string }
  | { readonly ok: false; readonly message: string; readonly fix: string };

/** secrets.rs parse_secret_sink, as far as the card needs it: the machine and the path. */
const SINK = /^(env|file):([a-z0-9-]{1,32}):(\/[^\n\r]*)$/u;

/** Where a secret ask's value goes and the key to seal it to, or why it can't be sent now and what to do. */
export const secretTarget = (machines: Readonly<Record<string, Machine>>, ask: Ask): SecretTarget => {
  const sink = SINK.exec(ask.sink ?? "");
  const [, kind, machineId, path] = sink ?? [];
  if (kind === undefined || machineId === undefined || path === undefined) {
    return { ok: false, message: "This ask doesn't say where the secret goes.", fix: "Decline it; the lead will ask again with a destination." };
  }
  const machine = machines[machineId];
  if (machine === undefined) {
    return { ok: false, message: `The hub doesn't know the machine ${machineId}.`, fix: "Decline it, or add that machine and ask the lead again." };
  }
  if (machine.boxPubKey === undefined) {
    return { ok: false, message: `${machine.name} takes no secrets yet: its node has no box key.`, fix: `Update fleetd on ${machine.name}, then send the secret.` };
  }
  if (machine.status === "offline") {
    return { ok: false, message: `${machine.name} is offline.`, fix: `Send the secret once ${machine.name} is back online.` };
  }
  const where = kind === "env" ? `as ${ask.envName ?? "its variable"} in ${path} on ${machine.name}` : `to ${path} on ${machine.name}`;
  return { ok: true, machine: machine.name, boxPubKey: machine.boxPubKey, where };
};
