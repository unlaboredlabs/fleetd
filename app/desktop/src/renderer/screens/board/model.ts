// The board as rows, pure: what the virtual list draws, in order. Every count on a row is computed here from the
// same lanes the rows under it show, so a header never says "2 writing" over one lane. The hub data comes from the
// data layer (selectBoardData); only the orders sent from this window and not yet on the board are the board's own.
import type { BoardData, OrderView } from "../../src/data/selectors";
import type { AgentLane, OrderCard, OrderPhase } from "./contracts";
import { type Group, chipHidden, finishHeadline, finished, fleet, hold, idleHeadline, onBoard, phaseLabel, sortCards, stagePick } from "./fleet";
import { parseMs, plural } from "./format";
import { type ProjectKey, leadLane, leadLaneId, projectKey } from "./live";
import { fleetActivity, isFinal } from "./words";

export interface Project {
  readonly key: ProjectKey;
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
  /** The machine's name, for the composer's "on devbox". */
  readonly machine: string;
  readonly offline: boolean;
}

/** An order between Enter and its card. */
export interface SentOrder {
  readonly requestId: string;
  readonly text: string;
  readonly to?: ProjectKey | undefined;
  readonly status:
    | { readonly kind: "sending" }
    | { readonly kind: "placed"; readonly workstreamId: string; readonly project?: ProjectKey | undefined; readonly leadWaiting?: string | undefined }
    | { readonly kind: "unrouted"; readonly askId: string }
    | { readonly kind: "failed"; readonly message: string };
}

export interface BoardModel {
  readonly data: BoardData;
  /** Orders sent from this window that the board doesn't list yet. */
  readonly sent: readonly SentOrder[];
}

/** The projects the composer can send to; undefined until the snapshot loaded them. */
export const projectsOf = (d: BoardData): Project[] | undefined =>
  d.projects?.map((p) => {
    const m = d.machines?.find((x) => x.machine.machineId === p.machineId)?.machine;
    return { key: projectKey(p), machineId: p.machineId, projectId: p.projectId, title: p.title, machine: m?.name ?? p.machineId, offline: m?.status === "offline" };
  });

/** Sent orders still worth a row: one the board now lists has its card instead. */
export const pendingSent = (m: BoardModel): SentOrder[] => {
  const listed = new Set((m.data.orders ?? []).map((o) => o.card.workstreamId));
  return m.sent.filter((o) => !(o.status.kind === "placed" && listed.has(o.status.workstreamId)));
};

export type Item =
  | { readonly kind: "empty"; readonly why: "no-projects" | "loading" | "idle" | "offline" }
  | { readonly kind: "project"; readonly key: ProjectKey; readonly title: string; readonly facts: string }
  | { readonly kind: "routing" }
  | { readonly kind: "sent"; readonly sent: SentOrder }
  | {
      readonly kind: "card";
      readonly card: OrderCard;
      readonly phase: OrderPhase;
      readonly label: string;
      readonly chip: boolean;
      readonly lanes: readonly AgentLane[];
    }
  | {
      readonly kind: "stageTitle";
      readonly card: OrderCard;
      readonly phase: OrderPhase;
      /** The phase chip's words, when the fleet's own lines don't already say it. */
      readonly chip?: string | undefined;
      readonly lead?: AgentLane | undefined;
      readonly note?: string | undefined;
    }
  | { readonly kind: "stageHead"; readonly text: string; readonly sinceMs?: number | undefined }
  | { readonly kind: "lane"; readonly lane: AgentLane; readonly indent: boolean }
  | { readonly kind: "group"; readonly group: Group }
  | { readonly kind: "finish"; readonly headline: string }
  | { readonly kind: "finishPr"; readonly group: Group }
  | { readonly kind: "gap"; readonly id: string };

export const itemKey = (i: Item): string => {
  switch (i.kind) {
    case "empty":
      return `empty:${i.why}`;
    case "project":
      return `project:${i.key}`;
    case "routing":
      return "routing";
    case "sent":
      return `sent:${i.sent.requestId}`;
    case "card":
      return `card:${i.card.workstreamId}`;
    case "stageTitle":
      return `stage:${i.card.workstreamId}`;
    case "stageHead":
      return "stage-head";
    case "lane":
      return `lane:${i.lane.laneId}`;
    case "group":
      return `group:${i.group.pr.changeId}`;
    case "finish":
      return "finish";
    case "finishPr":
      return `finish-pr:${i.group.pr.changeId}`;
    case "gap":
      return `gap:${i.id}`;
  }
};

/** An order on the board with its live phase (from the data layer: open asks now, lanes live). */
export interface LiveCard {
  readonly view: OrderView;
  readonly card: OrderCard;
  readonly phase: OrderPhase;
  readonly lanes: readonly AgentLane[];
}

export const boardCards = (m: BoardModel, nowMs: number, filter?: ProjectKey): LiveCard[] =>
  (m.data.orders ?? [])
    .filter((v) => (filter === undefined || projectKey(v.card.projectRef) === filter) && onBoard({ ...v.card, phase: v.phase.phase }, nowMs))
    .map((view) => ({ view, card: view.card, phase: view.phase.phase, lanes: view.lanes }));

/** The order on the stage: when nothing else is in flight, the only open order (or the last to finish). */
export const stagedOrder = (m: BoardModel, nowMs: number, filter?: ProjectKey): LiveCard | undefined => {
  if (pendingSent(m).length > 0) return undefined;
  const cards = boardCards(m, nowMs, filter);
  const pick = stagePick(cards.map(({ card, phase }) => ({ ...card, phase })));
  return cards.find((c) => c.card.workstreamId === pick?.workstreamId);
};

/** The lead's "next" note only while nothing else speaks for the order: no agent at work and no PR yet. */
export const leadNote = (card: OrderCard, lanes: readonly AgentLane[]): string | undefined =>
  card.prs.length === 0 && !lanes.some((l) => l.role !== "lead" && !isFinal(l.status)) ? card.next : undefined;

/**
 * The staged order: its title and lead, what the fleet is doing and for how long, the writers still writing, each
 * PR with its checkers indented under it; or, once every PR merged and nobody works, the finish.
 * `drawn` is the lanes shown now (at work, or holding their check); `seen` every lane it has had.
 */
export const stageItems = (m: BoardModel, staged: LiveCard, drawn: readonly AgentLane[], seen: readonly AgentLane[]): Item[] => {
  const { card, phase } = staged;
  const live = m.data.liveLanes[leadLaneId(card.projectRef)];
  const lead = live ? leadLane(live) : undefined;
  const chip = chipHidden(phase, card, seen) ? undefined : phaseLabel(staged.view.phase, staged.lanes);
  const items: Item[] = [{ kind: "stageTitle", card, phase, chip, lead, note: leadNote(card, seen) }];
  if (finished(drawn, card.prs)) {
    const created = parseMs(card.createdAt);
    const ends = seen.map((l) => parseMs(l.endedAt)).filter((t) => t !== undefined);
    const last = ends.length > 0 ? Math.max(...ends) : undefined;
    const took = created !== undefined && last !== undefined ? last - created : undefined;
    items.push({ kind: "finish", headline: finishHeadline(card.prs.length, phase === "done", took, seen.length) });
    for (const group of fleet([], seen, card.prs).groups) items.push({ kind: "finishPr", group });
    return items;
  }
  const f = fleet(drawn, seen, card.prs);
  if (drawn.length === 0 && f.groups.length === 0) return items;
  const doing = fleetActivity(drawn);
  items.push({ kind: "stageHead", text: doing === "" ? idleHeadline(card.prs) : doing, sinceMs: parseMs(card.createdAt) });
  for (const lane of f.writers) items.push({ kind: "lane", lane, indent: false });
  for (const group of f.groups) {
    items.push({ kind: "group", group });
    // The PR's writer, while it still works on it (or failed: a counted failure has its row), then its checkers;
    // a writer that finished folds into the header's "written in".
    const writer = group.writer && drawn.find((l) => l.laneId === group.writer?.laneId && l.status !== "done" && l.status !== "cancelled");
    if (writer) items.push({ kind: "lane", lane: writer, indent: true });
    for (const lane of group.rows) items.push({ kind: "lane", lane, indent: true });
  }
  for (const lane of f.others) items.push({ kind: "lane", lane, indent: false });
  return items;
};

/** "lead · 2 orders · 3/7 agents settled". */
const projectFacts = (cards: readonly LiveCard[]): string => {
  const open = cards.filter((c) => c.phase !== "done" && c.phase !== "stopped").length;
  const total = cards.reduce((n, c) => n + c.card.total, 0);
  const settled = cards.reduce((n, c) => n + c.card.settled, 0);
  return [plural(open, "open order"), ...(total > 0 ? [`${settled}/${total} agents settled`] : [])].join(" · ");
};

/** The board with several orders (or none): grouped by project, those needing you first, then the latest. */
export const listItems = (m: BoardModel, nowMs: number, filter?: ProjectKey): Item[] => {
  const items: Item[] = [];
  const sent = pendingSent(m);
  const routing = sent.filter((o) => sentProject(o) === undefined);
  if (routing.length > 0 && filter === undefined) {
    items.push({ kind: "routing" });
    for (const o of [...routing].reverse()) items.push({ kind: "sent", sent: o });
  }
  const projects = projectsOf(m.data) ?? [];
  const cards = boardCards(m, nowMs, filter);
  const byProject = new Map<ProjectKey, LiveCard[]>();
  for (const c of cards) {
    const k = projectKey(c.card.projectRef);
    byProject.set(k, [...(byProject.get(k) ?? []), c]);
  }
  const keyed = projects
    .filter((p) => filter === undefined || p.key === filter)
    .map((p) => {
      const list = byProject.get(p.key) ?? [];
      const mine = sent.filter((o) => sentProject(o) === p.key);
      return { p, list, mine, needs: list.some((c) => c.phase === "waiting_on_you"), latest: list.map((c) => c.card.updatedAt).sort().at(-1) ?? "" };
    })
    .filter((x) => x.list.length > 0 || x.mine.length > 0)
    .sort((a, b) => Number(b.needs) - Number(a.needs) || b.latest.localeCompare(a.latest));
  for (const { p, list, mine } of keyed) {
    items.push({ kind: "project", key: p.key, title: p.title, facts: projectFacts(list) });
    for (const o of [...mine].reverse()) items.push({ kind: "sent", sent: o });
    for (const { view, card, phase, lanes } of sortCards(list.map((c) => ({ ...c, updatedAt: c.card.updatedAt })))) {
      const chip = !chipHidden(phase, card, lanes) || phase === "working";
      items.push({ kind: "card", card, phase, lanes, chip, label: phaseLabel(view.phase, lanes) });
    }
  }
  if (!items.some((i) => i.kind === "card" || i.kind === "sent")) items.push({ kind: "empty", why: emptyWhy(m) });
  return items;
};

/**
 * Why the board is empty. The data layer's undefined (not connected yet, or not loaded since the last snapshot) is a
 * loading state, never "nothing here".
 */
const emptyWhy = (m: BoardModel): "no-projects" | "loading" | "idle" | "offline" => {
  const c = m.data.connection.view;
  if (c === "unpaired" || c === "refused") return "offline";
  if (c === "skeleton" || m.data.projects === undefined || m.data.orders === undefined) return "loading";
  return m.data.projects.length === 0 ? "no-projects" : "idle";
};

/** The project a sent order's card sits under, once known. */
export const sentProject = (o: SentOrder): ProjectKey | undefined => {
  switch (o.status.kind) {
    case "placed":
      return o.status.project ?? o.to;
    case "unrouted":
      return undefined;
    default:
      return o.to;
  }
};


/** The order the list was last drawn in, and which orders needed you then. */
export interface Held {
  readonly keys: readonly string[];
  readonly needs: string;
}

/**
 * Keeps the list where the eye left it: a refetch re-sorts by activity, but rows already shown keep their places and
 * new ones go in after whatever precedes them. Only a change in what needs you re-sorts it, so that order rises.
 */
export const stableOrder = (items: readonly Item[], held: Held | undefined): { items: Item[]; held: Held } => {
  const keys = items.map(itemKey);
  const needs = items.flatMap((i) => (i.kind === "card" && i.phase === "waiting_on_you" ? [i.card.workstreamId] : [])).join(",");
  const order = held !== undefined && held.needs === needs ? hold(held.keys, keys) : keys;
  const byKey = new Map(items.map((i) => [itemKey(i), i]));
  return { items: order.flatMap((k) => byKey.get(k) ?? []), held: { keys: order, needs } };
};

export const sameHeld = (a: Held | undefined, b: Held | undefined): boolean =>
  a !== undefined && b !== undefined && a.needs === b.needs && a.keys.join("\n") === b.keys.join("\n");
