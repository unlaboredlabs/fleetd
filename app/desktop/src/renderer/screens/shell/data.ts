// The sidebar's projects, from the data layer: your pinned ones first, then the rest by their newest line, newest first
// (pins.ts), the ones in your sections after the ones in none (sections.ts), archived ones left out: the project list
// (needs-you and agents at work), the open requests (what a lead waits on you for), Status's rows (what is blocked,
// what is red on main), each chat's newest line (latest.ts) and what you last saw in each chat. Offline, the projects
// held from before, with their marks as last known (the open requests the store keeps).
import { useEffect, useMemo } from "react";
import { hubKey, useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { markSeen, useSeen } from "../../src/data/seen";
import { selectShownProjects } from "../../src/data/selectors";
import { sidebarOrder } from "../projects/model";
import { projectId, toSidebar, type SidebarProject } from "./model";
import type { ProjectKey } from "./routes";
import { usePersonNames } from "../admin/names";
import { useHubRole } from "../admin/role";
import { useFollowLatest, useLatest } from "./latest";
import { arranged, usePins } from "./pins";
import { useSections } from "./sections";

const OPEN_REQUESTS = { state: "open", limit: 100 } as const;
const ALL = {} as const;

export const useSidebarProjects = (open: ProjectKey | null): ReadonlyArray<SidebarProject> | undefined => {
  const rows = useData(selectShownProjects);
  const read = useToolQuery("requests_list", OPEN_REQUESTS).data?.requests;
  // Held rows count the requests as last read; a live row waits for this connection's own read.
  const held = useData((s) => (s.fresh ? undefined : s.openRequests));
  const requests = read ?? held;
  const status = useToolQuery("status_get", ALL).data?.rows;
  const layer = useDataLayer();
  const { hub } = layer;
  const live = useData((s) => s.fresh && s.hub.phase === "live");
  useFollowLatest(layer, rows, live);
  const latest = useLatest(hub);
  const chats = useData((s) => s.chatStates);
  const lastAt = useMemo(() => Object.fromEntries(Object.entries(chats).map(([k, c]) => [k, c.lastMessageAt])), [chats]);
  const allSeen = useSeen();
  // This hub's marks, by project key: another hub's are kept under its id (hubKey).
  const seen = useMemo(
    () => Object.fromEntries((rows ?? []).flatMap((r) => (allSeen[hubKey(hub, r.key)] === undefined ? [] : [[r.key, allSeen[hubKey(hub, r.key)] ?? 0]]))),
    [rows, allSeen, hub],
  );
  const blocked = useMemo(
    () => (status === undefined ? undefined : new Map(status.filter((r) => r.state === "blocked").map((r) => [projectId(r.projectRef), r.blockedReason]))),
    [status],
  );
  const warnings = useMemo(
    () => (status === undefined ? undefined : new Map(status.flatMap((r) => (r.warning === undefined ? [] : [[projectId(r.projectRef), r.warning] as const])))),
    [status],
  );
  // Your pinned ones on top, in your order (pins.ts).
  const pins = usePins();
  // Then the ones in none of your sections, then each section's (sections.ts).
  const sections = useSections();
  const me = useHubRole().me?.personId;
  const names = usePersonNames();
  const openKey = open === null ? null : projectId(open);
  // The open chat is seen as it grows; a project seen for the first time starts read, not as a backlog of unread.
  useEffect(() => {
    if (rows === undefined) return;
    const marks: Record<string, number> = {};
    for (const r of rows) {
      if (r.lastSeq === undefined) continue;
      if (r.key === openKey || seen[r.key] === undefined) marks[hubKey(hub, r.key)] = r.lastSeq;
    }
    markSeen(marks);
  }, [rows, openKey, seen, hub]);
  return useMemo(() => {
    const shown = toSidebar(rows, { requests, blocked, warnings, seen, open, latest, lastAt, pins, sections, me, names });
    return shown === undefined
      ? undefined
      : arranged(
          sidebarOrder(shown),
          pins,
          undefined,
          sections?.map((s) => s.id),
        );
  }, [rows, requests, blocked, warnings, seen, open, latest, lastAt, pins, sections, me, names]);
};

