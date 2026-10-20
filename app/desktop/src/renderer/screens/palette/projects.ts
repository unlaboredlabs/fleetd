// The palette's "Projects" group: every project, opening its lead chat. Read from the data layer only while the
// palette is open (the Source contract), so a long project list costs nothing the rest of the time.

import type { DataState, DataStore } from "../../src/data/store";
import { selectMachines, selectProjects } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { chatRoute } from "./defaults";
import type { Command, Source } from "./registry";

/** One row per project. The machine name tells two checkouts of the same repo apart. */
export const projectItems = (state: DataState, go: (hash: string) => void): Command[] => {
  const machines = new Map((selectMachines(state) ?? []).map((m) => [m.machine.machineId, m.machine.name]));
  return (selectProjects(state) ?? []).map((p): Command => {
    const machine = machines.get(p.machineId);
    return {
      id: `project:${projectKey(p)}`,
      title: p.title,
      // The machine id is never shown; a machine the snapshot doesn't name yet just goes unsaid.
      detail: machine === undefined ? "Chat with the lead" : `Chat with the lead · on ${machine}`,
      group: "projects",
      keywords: [p.projectId],
      run: () => go(chatRoute(p.machineId, p.projectId)),
    };
  });
};

export const projectSource = (store: DataStore): Source => ({
  id: "projects",
  items: () =>
    projectItems(store.getState(), (hash) => {
      window.location.hash = hash;
    }),
  subscribe: (onChange) => store.subscribe(onChange),
});
