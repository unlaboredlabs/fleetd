// The board's reads and writes through the data layer (src/data): selectBoardData for everything it draws, the
// staged order's order_get, and the composer's calls. The only state kept here is the board's own: orders sent from
// this window that the board doesn't list yet, and what each carried, so Retry resends exactly that.
import { useMemo, useReducer, useState } from "react";
import type { IntakeSubmitInput, PlaybookName } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { selectBoardData } from "../../src/data/selectors";
import { plainReason } from "../shell/model";
import type { ComposerApi, Draft } from "./Composer";
import { type ProjectKey, projectKey } from "./live";
import type { BoardModel, SentOrder } from "./model";

type DraftParts = Pick<Draft, "template" | "attachments" | "refs">;

interface Sent {
  readonly orders: readonly SentOrder[];
  readonly drafts: ReadonlyMap<string, DraftParts>;
}

type Action = { readonly t: "sent"; readonly order: SentOrder; readonly draft?: DraftParts } | { readonly t: "unsend"; readonly requestId: string };

const reduce = (s: Sent, a: Action): Sent => {
  switch (a.t) {
    case "sent": {
      const orders = s.orders.some((o) => o.requestId === a.order.requestId)
        ? s.orders.map((o) => (o.requestId === a.order.requestId ? a.order : o))
        : [...s.orders, a.order];
      return { orders, drafts: a.draft ? new Map([...s.drafts, [a.order.requestId, a.draft]]) : s.drafts };
    }
    case "unsend": {
      const drafts = new Map(s.drafts);
      drafts.delete(a.requestId);
      return { orders: s.orders.filter((o) => o.requestId !== a.requestId), drafts };
    }
  }
};

const message = (e: HubError) => (e.fix ? `${e.message} ${e.fix}` : e.message);

/** The project the last order went to: the composer's default when nothing else picks one. */
let lastUsed: ProjectKey | undefined;

export interface BoardSource {
  readonly model: BoardModel;
  readonly composer: ComposerApi;
  readonly actions: {
    readonly retry: (requestId: string) => void;
    readonly edit: (requestId: string) => string | undefined;
    readonly retryBoard: () => void;
  };
  readonly lastUsed: ProjectKey | undefined;
  /** Why Send is off, when the hub isn't live. */
  readonly offline: string | undefined;
  /** The order on the stage: its detail (order_get) is loaded, for the agents a card leaves out. */
  readonly watch: (workstreamId: string | undefined) => void;
}

export const useBoardSource = (addProject: () => void): BoardSource => {
  const layer = useDataLayer();
  const data = useData(selectBoardData);
  const [sent, dispatch] = useReducer(reduce, { orders: [], drafts: new Map() });
  const [watched, watch] = useState<string | undefined>(undefined);
  useToolQuery("order_get", { workstreamId: watched ?? "" }, { enabled: watched !== undefined });
  // The same read the data layer keeps loaded (same key, one query): here for its error and a retry.
  const board = useToolQuery("orders_board", {});
  const boardError = board.isError ? (board.error instanceof CallError ? message(board.error.error) : board.error.message) : undefined;

  const submit = useMemo(
    () => (order: SentOrder, draft: DraftParts) => {
      dispatch({ t: "sent", order: { ...order, status: { kind: "sending" } }, draft });
      if (order.to !== undefined) lastUsed = order.to;
      const [machineId, projectId] = order.to?.split("/") ?? [];
      const input: IntakeSubmitInput = {
        ...(machineId !== undefined && projectId !== undefined ? { machineId, projectId } : {}),
        text: order.text,
        template: draft.template,
        ...(draft.attachments.length > 0 ? { attachments: [...draft.attachments] } : {}),
        ...(draft.refs.length > 0 ? { refs: [...draft.refs] } : {}),
        clientRequestId: order.requestId,
      };
      void layer.call("intake_submit", input).then((o) => {
        if (!o.ok) return dispatch({ t: "sent", order: { ...order, status: { kind: "failed", message: message(o.error) } } });
        const out = o.output;
        if (out.askId !== undefined) return dispatch({ t: "sent", order: { ...order, status: { kind: "unrouted", askId: out.askId } } });
        if (out.workstreamId !== undefined) {
          const project = out.echo ? projectKey(out.echo.projectRef) : undefined;
          dispatch({ t: "sent", order: { ...order, status: { kind: "placed", workstreamId: out.workstreamId, project, leadWaiting: out.leadWaiting } } });
        }
      });
    },
    [layer],
  );

  const composer = useMemo<ComposerApi>(
    () => ({
      preview: async (text) => {
        const o = await layer.call("intake_preview", { text });
        return o.ok && o.output.echo ? projectKey(o.output.echo.projectRef) : undefined;
      },
      files: async (target, query) => {
        const o = await layer.call("project_files", { machineId: target.machineId, projectId: target.projectId, query, limit: 20 });
        return o.ok ? o.output.paths : [];
      },
      upload: async (name, mime, dataB64) => {
        const o = await layer.call("attachment_put", { name, mime, dataB64 }, { timeoutMs: 120_000 });
        return o.ok ? { ok: true, id: o.output.attachmentId } : { ok: false, message: message(o.error) };
      },
      send: (draft) => {
        const requestId = `app-${crypto.randomUUID()}`;
        submit(
          { requestId, text: draft.text, to: draft.target, status: { kind: "sending" } },
          { template: draft.template satisfies PlaybookName, attachments: draft.attachments, refs: draft.refs },
        );
      },
      addProject,
    }),
    [layer, submit, addProject],
  );

  const actions = useMemo(
    () => ({
      retry: (requestId: string) => {
        const order = sent.orders.find((o) => o.requestId === requestId);
        const draft = sent.drafts.get(requestId);
        if (order && draft) submit(order, draft);
      },
      edit: (requestId: string) => {
        const order = sent.orders.find((o) => o.requestId === requestId);
        dispatch({ t: "unsend", requestId });
        return order?.text;
      },
      retryBoard: () => void board.refetch(),
    }),
    [sent, submit, board],
  );

  const c = data.connection;
  const offline =
    c.view === "live"
      ? undefined
      : c.view === "refused"
        ? c.message
        : c.view === "skeleton" && c.reason !== undefined
          ? `Reconnecting: ${plainReason(c.reason, c.hub)}`
          : "Not connected to the hub.";
  return { model: { data, sent: sent.orders, boardError }, composer, actions, watch, lastUsed, offline };
};
