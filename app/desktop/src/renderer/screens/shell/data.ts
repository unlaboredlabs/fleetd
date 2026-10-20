// The sidebar's projects, from the data layer's project list (needs-you from each chat's state, agents at work).
import { useMemo } from "react";
import { useData } from "../../src/data/react";
import { selectMachines, selectProjectList } from "../../src/data/selectors";
import { toSidebar, type SidebarProject } from "./model";

export const useSidebarProjects = (): ReadonlyArray<SidebarProject> | undefined => {
  const rows = useData(selectProjectList);
  return useMemo(() => toSidebar(rows), [rows]);
};

/** Machines not online, for the sidebar's Machines entry; undefined until known. */
export const useMachinesDown = (): number | undefined => {
  const machines = useData(selectMachines);
  return useMemo(() => machines?.filter((m) => m.machine.status !== "online").length, [machines]);
};
