// The frame's view data as a hook, shared by the frame and the order view (its ⌘[ / ⌘] step through the sidebar).
import { useMemo } from "react";
import { useData } from "../../src/data/react";
import { leadLaneId, selectBoard, selectInbox, selectMachines, selectProjects } from "../../src/data/selectors";
import { toShellData, type ShellData } from "./model";

/** The frame's view data, from the data layer: recomputed only when one of its inputs changed. */
export const useShellData = (): ShellData => {
  const projects = useData(selectProjects);
  const board = useData(selectBoard);
  const inbox = useData(selectInbox);
  const machines = useData(selectMachines);
  const lanes = useData((s) => s.live.lanes);
  return useMemo(
    () =>
      toShellData(
        { projects, board, inbox, machines, leadStatus: (key) => lanes[leadLaneId(key)]?.status },
        // A finished order drops off when the data next changes, not on a timer, so nothing repaints while idle;
        // the clock is read once per data change, which is the point of the memo.
        // eslint-disable-next-line react-hooks/purity
        Date.now(),
      ),
    [projects, board, inbox, machines, lanes],
  );
};

