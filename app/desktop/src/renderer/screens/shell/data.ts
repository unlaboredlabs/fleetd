// The sidebar's projects, from the data layer: the project list (needs-you and agents at work), the open requests
// (what a lead waits on you for), Status's rows (what is blocked) and what you last saw in each chat. Offline, the
// projects held from before, with their marks as last known (the open requests the store keeps).
import { useEffect, useMemo } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { markSeen, useSeen } from "../../src/data/seen";
import { selectMachines, selectProjectList, selectShownProjects } from "../../src/data/selectors";
import { projectId, toSidebar, type SidebarProject } from "./model";
import type { ProjectKey } from "./routes";

const OPEN_REQUESTS = { state: "open", limit: 100 } as const;
const ALL = {} as const;

export const useSidebarProjects = (open: ProjectKey | null): ReadonlyArray<SidebarProject> | undefined => {
  const rows = useData(selectShownProjects);
  const read = useToolQuery("requests_list", OPEN_REQUESTS).data?.requests;
  // Held rows count the requests as last read; a live row waits for this connection's own read.
  const held = useData((s) => (s.fresh ? undefined : s.openRequests));
  const requests = read ?? held;
  const status = useToolQuery("status_projects", ALL).data?.rows;
  const seen = useSeen();
  const blocked = useMemo(
    () => (status === undefined ? undefined : new Map(status.filter((r) => r.state === "blocked").map((r) => [projectId(r.projectRef), r.blockedReason]))),
    [status],
  );
  const openKey = open === null ? null : projectId(open);
  // The open chat is seen as it grows; a project seen for the first time starts read, not as a backlog of unread.
  useEffect(() => {
    if (rows === undefined) return;
    const marks: Record<string, number> = {};
    for (const r of rows) {
      if (r.lastSeq === undefined) continue;
      if (r.key === openKey || seen[r.key] === undefined) marks[r.key] = r.lastSeq;
    }
    markSeen(marks);
  }, [rows, openKey, seen]);
  return useMemo(() => toSidebar(rows, { requests, blocked, seen, open }), [rows, requests, blocked, seen, open]);
};

/** Agents at work across every project, the leads not counted, for the sidebar's Agents entry; undefined until known. */
export const useAgentsWorking = (): number | undefined => useData((s) => selectProjectList(s)?.reduce((n, r) => n + r.running, 0));

/** Machines not online, for the sidebar's Machines entry; undefined until known. */
export const useMachinesDown = (): number | undefined => {
  const machines = useData(selectMachines);
  return useMemo(() => machines?.filter((m) => m.machine.status !== "online").length, [machines]);
};
