// Where each of the bot's screens stands in its chat (screens.ts says what its card says): its card's row where it
// opened, after the last message before it, and whether one asks for you now, for the strip over the composer. Read
// from the hub's own rows (browser_sessions), so the first chat loads none of the screens' views: the card and the
// strip come as they are needed (ScreenCard.tsx).
import { useMemo } from "react";
import type { BrowserSession as HubSession } from "../../../shared/contracts";
import type { ChatItem } from "../../src/data/chat";
import { useData, useToolQuery } from "../../src/data/react";
import type { ProjectKey } from "../shell/routes";
import type { Row } from "./model";

/** A screen as the rows need it: when it opened, and whether it is still open. */
export interface ScreenTime {
  readonly id: string;
  readonly at: string;
  readonly live: boolean;
}

const msOf = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

const itemOf = (r: Row): ChatItem | undefined => (r.kind === "message" || r.kind === "event" || r.kind === "inline" ? r.item : undefined);

/** The files a message holds, by name: what a person attached, and a lead's file and image cards. */
const filesOf = (item: ChatItem): string[] => [
  ...item.attachments.map((a) => a.name),
  ...(item.message?.parts ?? []).flatMap((p) => (p.block !== undefined && "name" in p.block && typeof p.block.name === "string" ? [p.block.name] : [])),
];

/**
 * The rows with each screen's card where it opened: before the lines (a day, a pause's time, "New") over the first
 * message after it. One that opened before the oldest message loaded waits for its page, unless there are no older
 * ones. One that opened after the newest message stands at the end, where the reply will come: while the lead browses,
 * the chat shows its screen, not only its dots. A window far back (`newer`) has no end of its own: those wait.
 */
export const withScreens = (rows: readonly Row[], screens: readonly ScreenTime[], at: { readonly hasOlder: boolean; readonly newer: boolean }): readonly Row[] => {
  if (screens.length === 0) return rows;
  const byTime = screens.toSorted((a, b) => msOf(a.at) - msOf(b.at));
  // Each row's next message: its own, or the one a day line or the unread bar stands over.
  const ahead: (ChatItem | undefined)[] = [];
  let after: ChatItem | undefined;
  for (const row of rows.toReversed()) {
    after = itemOf(row) ?? after;
    ahead.push(after);
  }
  ahead.reverse();
  const first = rows.map(itemOf).find((item) => item !== undefined);
  const files = rows.flatMap((r) => {
    const item = itemOf(r);
    return item === undefined ? [] : filesOf(item).map((name) => ({ name, at: msOf(item.at) }));
  });
  const screenRow = (s: ScreenTime): Row => ({
    kind: "screen",
    key: `screen:${s.id}`,
    sessionId: s.id,
    inChat: files.filter((f) => f.at >= msOf(s.at)).map((f) => f.name),
  });
  const out: Row[] = [];
  let next = 0;
  rows.forEach((row, i) => {
    const item = ahead[i];
    for (let s = byTime[next]; item !== undefined && s !== undefined && msOf(s.at) < msOf(item.at); s = byTime[next]) {
      // Before the oldest message loaded: it may belong further back, on a page not read yet.
      if (item !== first || !at.hasOlder) out.push(screenRow(s));
      next += 1;
    }
    // A window's last row reads its next page: what opened after it belongs there.
    if (row.kind === "bottom") next = byTime.length;
    out.push(row);
  });
  if (!at.newer) for (const s of byTime.slice(next)) out.push(screenRow(s));
  return out;
};

/** The hub feature that says it serves screens (sessions/hub.ts FEATURE). */
const SESSIONS = "browser_sessions";
const NONE: readonly ScreenTime[] = [];

/** A row asks for you while it is live, its agent drives it and the agent asked (sessions/hub.ts viewState). */
const asks = (row: HubSession): boolean => row.state === "live" && row.control !== "human" && row.control !== "handing_back" && row.takeoverReason !== undefined;

/** The bot's screens for the rows, and whether one asks for you now. */
export function useScreenTimes(project: ProjectKey): { readonly times: readonly ScreenTime[]; readonly asking: boolean } {
  const on = useData((st) => st.features.includes(SESSIONS));
  const rows = useToolQuery(SESSIONS, { projectRef: { machineId: project.machineId, projectId: project.projectId } }, { enabled: on }).data?.sessions;
  return useMemo(
    () => (rows === undefined ? { times: NONE, asking: false } : { times: rows.map((r) => ({ id: r.sessionId, at: r.startedAt, live: r.state === "live" })), asking: rows.some(asks) }),
    [rows],
  );
}
