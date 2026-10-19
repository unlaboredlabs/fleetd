// The sidebar's projects, from the data layer.
import { useMemo } from "react";
import { useData } from "../../src/data/react";
import { leadLaneId, selectBoard, selectProjects } from "../../src/data/selectors";
import { toSidebar, type ProjectRowIn, type SidebarProject } from "./model";

const active = (status: string): boolean => status === "working" || status === "starting";

/**
 * Stands in for the chat data layer's selectProjectList (A7) until it lands, in its row shape: running agents from
 * the board's lanes, the lead's live lane for "working", and "waiting" on the lead's lane as the needs-you state.
 * Sorted as A7 sorts: needs you, then working, then title.
 */
const useProjectRows = (): ReadonlyArray<ProjectRowIn> | undefined => {
  const projects = useData(selectProjects);
  const board = useData(selectBoard);
  const lanes = useData((s) => s.live.lanes);
  return useMemo(() => {
    if (projects === undefined) return undefined;
    const rows = projects.map((project): ProjectRowIn => {
      const mine = (board ?? []).filter((v) => v.card.projectRef.machineId === project.machineId && v.card.projectRef.projectId === project.projectId);
      const running = mine.reduce((n, v) => n + v.lanes.filter((l) => active(l.status)).length, 0);
      const lead = lanes[leadLaneId(project)];
      return { project, needsYou: lead?.status === "waiting", working: running > 0 || (lead !== undefined && active(lead.status)), running };
    });
    return rows.sort(
      (a, b) => Number(b.needsYou) - Number(a.needsYou) || Number(b.working) - Number(a.working) || a.project.title.localeCompare(b.project.title),
    );
  }, [projects, board, lanes]);
};

export const useSidebarProjects = (): ReadonlyArray<SidebarProject> | undefined => {
  const rows = useProjectRows();
  return useMemo(() => toSidebar(rows), [rows]);
};
