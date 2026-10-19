// The board's data, from the hub through window.fleetd: the snapshot's projects and machines, orders_board, the
// open asks, the live feed, and the orders sent from the composer. One store for the window, held while anything
// reads it (the board, and the frame's strips under every screen), so they draw the same data from one subscription.
// A stand-in for E1's store and Query hooks: when the board moves onto them, this file becomes selectors over them.
import { useMemo, useSyncExternalStore } from "react";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import type { ComposerApi, Draft } from "./Composer";
import type { AgentLane, AskSummary, IntakeSubmitInput, IntakeSubmitOutput, LiveFrame, OrdersBoardOutput } from "./contracts";
import { ORDER_DONE_HOLD_MS } from "./fleet";
import { EMPTY, type LiveState, type ProjectKey, applyFrame, markStale, projectKey, setBoard, setDone } from "./live";
import type { BoardModel, Conn, Project, SentOrder } from "./model";
import type { BoardActions } from "./BoardView";

type DraftParts = Pick<Draft, "template" | "attachments" | "refs">;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export interface State {
  readonly conn: Conn;
  readonly snapshot: boolean;
  readonly projects: readonly Project[];
  readonly live: LiveState;
  readonly asks: readonly AskSummary[];
  readonly loaded: ReadonlySet<ProjectKey>;
  readonly errors: ReadonlyMap<ProjectKey, string>;
  readonly sent: readonly SentOrder[];
  /** What each sent order carried, so Retry resends exactly that with the same clientRequestId. */
  readonly drafts: ReadonlyMap<string, DraftParts>;
  readonly lastUsed: ProjectKey | undefined;
  readonly note: string | undefined;
}

type Action =
  | { readonly t: "conn"; readonly conn: Conn; readonly note?: string | undefined }
  | { readonly t: "snapshot"; readonly projects: readonly Project[] }
  | { readonly t: "live"; readonly frame: LiveFrame; readonly at: number }
  | { readonly t: "boards"; readonly out: OrdersBoardOutput }
  | { readonly t: "boardsFailed"; readonly message: string }
  | { readonly t: "asks"; readonly asks: readonly AskSummary[] }
  | { readonly t: "done"; readonly workstreamId: string; readonly lanes: readonly AgentLane[] }
  | { readonly t: "sent"; readonly order: SentOrder; readonly draft?: DraftParts }
  | { readonly t: "unsend"; readonly requestId: string };

const initial: State = {
  conn: "connecting",
  snapshot: false,
  projects: [],
  live: EMPTY,
  asks: [],
  loaded: new Set(),
  errors: new Map(),
  sent: [],
  drafts: new Map(),
  lastUsed: undefined,
  note: undefined,
};

/** One board answer for every project, split per project so each keeps its own history. */
const splitBoards = (projects: readonly Project[], out: OrdersBoardOutput): Map<ProjectKey, OrdersBoardOutput> => {
  const by = new Map<ProjectKey, OrdersBoardOutput>(projects.map((p) => [p.key, { orders: [], trains: out.trains, at: out.at }]));
  for (const o of out.orders) {
    const k = projectKey(o.projectRef);
    const b = by.get(k) ?? { orders: [], trains: out.trains, at: out.at };
    by.set(k, { ...b, orders: [...b.orders, o] });
  }
  return by;
};

const reduce = (s: State, a: Action): State => {
  switch (a.t) {
    case "conn":
      // A reconnect never shows cached data as live: the feed greys until the next frame, the boards refetch.
      return { ...s, conn: a.conn, note: a.note, live: a.conn === "live" ? s.live : markStale(s.live) };
    case "snapshot":
      return { ...s, projects: a.projects, snapshot: true };
    case "live":
      return { ...s, live: applyFrame(s.live, a.frame, a.at) };
    case "boards": {
      let live = s.live;
      const loaded = new Set(s.loaded);
      for (const [k, b] of splitBoards(s.projects, a.out)) {
        live = setBoard(live, k, b);
        loaded.add(k);
      }
      // A sent order leaves once its card is on the board.
      const onBoard = new Set(a.out.orders.map((o) => o.workstreamId));
      const sent = s.sent.filter((o) => !(o.status.kind === "placed" && onBoard.has(o.status.workstreamId)));
      return { ...s, live, loaded, errors: new Map(), sent };
    }
    case "boardsFailed":
      return { ...s, errors: new Map(s.projects.map((p) => [p.key, a.message])) };
    case "asks":
      return { ...s, asks: a.asks };
    case "done":
      return { ...s, live: setDone(s.live, a.workstreamId, a.lanes) };
    case "sent": {
      const sent = s.sent.some((o) => o.requestId === a.order.requestId)
        ? s.sent.map((o) => (o.requestId === a.order.requestId ? a.order : o))
        : [...s.sent, a.order];
      const drafts = a.draft ? new Map([...s.drafts, [a.order.requestId, a.draft]]) : s.drafts;
      return { ...s, sent, drafts, lastUsed: a.order.to ?? s.lastUsed };
    }
    case "unsend": {
      const drafts = new Map(s.drafts);
      drafts.delete(a.requestId);
      return { ...s, sent: s.sent.filter((o) => o.requestId !== a.requestId), drafts };
    }
  }
};

const projectsOf = (snapshot: Record<string, unknown>): Project[] => {
  const machines = new Map<string, { name: string; offline: boolean }>();
  for (const m of Array.isArray(snapshot["machines"]) ? snapshot["machines"] : []) {
    const id = isObject(m) ? str(m["machineId"]) : undefined;
    if (id !== undefined && isObject(m)) machines.set(id, { name: str(m["name"]) ?? id, offline: m["status"] === "offline" });
  }
  const out: Project[] = [];
  for (const p of Array.isArray(snapshot["projects"]) ? snapshot["projects"] : []) {
    if (!isObject(p)) continue;
    const machineId = str(p["machineId"]);
    const projectId = str(p["projectId"]);
    if (machineId === undefined || projectId === undefined) continue;
    const m = machines.get(machineId);
    out.push({
      key: projectKey({ machineId, projectId }),
      machineId,
      projectId,
      title: str(p["title"]) ?? projectId,
      machine: m?.name ?? machineId,
      offline: m?.offline ?? false,
    });
  }
  return out;
};

const message = (o: CallOutcome & { ok: false }) => (o.error.fix ? `${o.error.message} ${o.error.fix}` : o.error.message);

const BOARD_EVENTS = ["workstream.", "task.", "change.", "claim.", "ask.", "pr.", "review."];
const ASK_EVENTS = ["ask.", "batch.", "decision.", "gated."];

export interface BoardSource {
  readonly model: BoardModel;
  readonly composer: ComposerApi;
  readonly actions: Omit<BoardActions, "openOrder" | "addProject" | "openAsk" | "openPr">;
  readonly lastUsed: ProjectKey | undefined;
  /** Why Send is off, when the hub isn't live. */
  readonly offline: string | undefined;
  /** The order on the stage: its detail is fetched, for the agents a card leaves out. */
  readonly watch: (workstreamId: string | undefined) => void;
}

let state: State = initial;
const listeners = new Set<() => void>();
const dispatch = (a: Action) => {
  state = reduce(state, a);
  for (const l of listeners) l();
};

const hub = () => window.fleetd.hub;
/** The order on the stage: its detail is refetched with the boards. */
let watched: string | undefined;

const fetchDetail = (workstreamId: string) => {
  void hub()
    .call("order_get", { workstreamId })
    .then((o) => {
      if (o.ok && isObject(o.output) && Array.isArray(o.output["doneLanes"])) {
        dispatch({ t: "done", workstreamId, lanes: o.output["doneLanes"] as AgentLane[] });
      }
    });
};

const fetchBoards = () => {
  const includeDoneSince = new Date(Date.now() - ORDER_DONE_HOLD_MS).toISOString();
  void hub()
    .call("orders_board", { includeDoneSince })
    .then((o) => {
      if (o.ok && isObject(o.output) && Array.isArray(o.output["orders"])) dispatch({ t: "boards", out: o.output as unknown as OrdersBoardOutput });
      else if (!o.ok) dispatch({ t: "boardsFailed", message: message(o) });
    });
  if (watched !== undefined) fetchDetail(watched);
};

const fetchAsks = () => {
  void hub()
    .call("asks_list", { state: "open" })
    .then((o) => {
      if (o.ok && isObject(o.output) && Array.isArray(o.output["asks"])) dispatch({ t: "asks", asks: o.output["asks"] as AskSummary[] });
    });
};

/** The hub subscription, while anything reads the store. */
const start = (): (() => void) => {
  let boardsDue: number | undefined;
  let asksDue: number | undefined;
  // A burst of events is one refetch.
  const soon = (due: number | undefined, run: () => void) => {
    window.clearTimeout(due);
    return window.setTimeout(run, 250);
  };
  const onFrame = (frame: HubFrame) => {
    switch (frame.t) {
      case "state": {
        const phase = frame.state.phase;
        const conn: Conn = phase === "live" ? "live" : phase === "unpaired" ? "unpaired" : phase === "connecting" ? "connecting" : "offline";
        const note =
          phase === "retrying"
            ? `Not connected: ${frame.state.reason}`
            : phase === "refused"
              ? frame.state.message
              : phase === "live"
                ? undefined
                : "Not connected to the hub.";
        dispatch({ t: "conn", conn, note });
        if (phase === "live") void hub().live({ board: true });
        return;
      }
      case "snapshot":
        dispatch({ t: "snapshot", projects: projectsOf(frame.snapshot) });
        fetchBoards();
        fetchAsks();
        return;
      case "live":
        dispatch({ t: "live", frame: frame.frame as unknown as LiveFrame, at: Date.now() });
        return;
      case "event": {
        const type = frame.event.type;
        if (BOARD_EVENTS.some((p) => type.startsWith(p))) boardsDue = soon(boardsDue, fetchBoards);
        if (ASK_EVENTS.some((p) => type.startsWith(p))) asksDue = soon(asksDue, fetchAsks);
        if (type.startsWith("project.")) void hub().resync();
        return;
      }
      case "error":
        return;
    }
  };
  const unsubscribe = hub().subscribe(onFrame);
  return () => {
    unsubscribe();
    window.clearTimeout(boardsDue);
    window.clearTimeout(asksDue);
  };
};

let stop: (() => void) | undefined;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  stop ??= start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = undefined;
    }
  };
};

/** The board's state, shared by every reader in the window. */
export const useBoardState = (): State => useSyncExternalStore(subscribe, () => state);

/** Puts an order on the stage: its detail is fetched now and with every board refetch. */
const watch = (workstreamId: string | undefined) => {
  if (workstreamId === watched) return;
  watched = workstreamId;
  if (workstreamId !== undefined) fetchDetail(workstreamId);
};

const submit = (order: SentOrder, draft: DraftParts) => {
  dispatch({ t: "sent", order: { ...order, status: { kind: "sending" } }, draft });
  const [machineId, projectId] = order.to?.split("/") ?? [];
  const input: IntakeSubmitInput = {
    ...(machineId !== undefined && projectId !== undefined ? { machineId, projectId } : {}),
    text: order.text,
    template: draft.template,
    ...(draft.attachments.length > 0 ? { attachments: draft.attachments } : {}),
    ...(draft.refs.length > 0 ? { refs: draft.refs } : {}),
    clientRequestId: order.requestId,
  };
  void hub()
    .call("intake_submit", input)
    .then((o) => {
      if (!o.ok) return dispatch({ t: "sent", order: { ...order, status: { kind: "failed", message: message(o) } } });
      const out = (isObject(o.output) ? o.output : {}) as IntakeSubmitOutput;
      if (out.askId !== undefined) {
        fetchAsks();
        return dispatch({ t: "sent", order: { ...order, status: { kind: "unrouted", askId: out.askId } } });
      }
      if (out.workstreamId !== undefined) {
        const project = out.echo ? projectKey(out.echo.projectRef) : undefined;
        dispatch({ t: "sent", order: { ...order, status: { kind: "placed", workstreamId: out.workstreamId, project, leadWaiting: out.leadWaiting } } });
        fetchBoards();
      }
    });
};

const actions = {
  retry: (requestId: string) => {
    const order = state.sent.find((o) => o.requestId === requestId);
    const draft = state.drafts.get(requestId);
    if (order && draft) submit(order, draft);
  },
  edit: (requestId: string) => {
    const order = state.sent.find((o) => o.requestId === requestId);
    dispatch({ t: "unsend", requestId });
    return order?.text;
  },
};

export const useBoardSource = (addProject: () => void): BoardSource => {
  const s = useBoardState();
  const composer = useMemo<ComposerApi>(
    () => ({
      preview: async (text) => {
        const o = await hub().call("intake_preview", { text });
        if (!o.ok || !isObject(o.output) || !isObject(o.output["echo"])) return undefined;
        const ref = o.output["echo"]["projectRef"];
        return isObject(ref) && typeof ref["machineId"] === "string" && typeof ref["projectId"] === "string"
          ? projectKey({ machineId: ref["machineId"], projectId: ref["projectId"] })
          : undefined;
      },
      files: async (target, query) => {
        const o = await hub().call("project_files", { machineId: target.machineId, projectId: target.projectId, query, limit: 20 });
        return o.ok && isObject(o.output) && Array.isArray(o.output["paths"]) ? o.output["paths"].filter((p) => typeof p === "string") : [];
      },
      upload: async (name, mime, dataB64) => {
        const o = await hub().call("attachment_put", { name, mime, dataB64 }, { timeoutMs: 120_000 });
        if (!o.ok) return { ok: false, message: message(o) };
        const id = isObject(o.output) ? str(o.output["attachmentId"]) : undefined;
        return id === undefined ? { ok: false, message: "The hub didn't say where it put the file." } : { ok: true, id };
      },
      send: (draft) => {
        const requestId = `app-${crypto.randomUUID()}`;
        const keep = { template: draft.template, attachments: draft.attachments, refs: draft.refs };
        submit({ requestId, text: draft.text, to: draft.target as ProjectKey | undefined, status: { kind: "sending" } }, keep);
      },
      addProject,
    }),
    [addProject],
  );
  const model: BoardModel = { conn: s.conn, snapshot: s.snapshot, projects: s.projects, live: s.live, asks: s.asks, loaded: s.loaded, errors: s.errors, sent: s.sent };
  return { model, composer, actions, watch, lastUsed: s.lastUsed, offline: s.conn === "live" ? undefined : (s.note ?? "Not connected to the hub.") };
};
