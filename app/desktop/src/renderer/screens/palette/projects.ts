// The palette's "Projects" group: every project on every hub, opening its lead chat. Read from the data layers only
// while the palette is open (the Source contract), so a long project list costs nothing the rest of the time. With
// several hubs each row says its hub beside its machine, and opens on that hub.

import { FIRST_HUB, type HubEntry } from "../../../shared/hubs";
import type { HubSetStore } from "../../src/data/hubs";
import { hubKey } from "../../src/data/react";
import type { DataState } from "../../src/data/store";
import { selectMachines, selectProjects } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { focusSliderNext } from "../settings/focusProject";
import { panelRoute, parseHash, toHash } from "../shell/routes";
import { chatRoute } from "./defaults";
import type { Command, Source } from "./registry";

const itemId = (p: { readonly machineId: string; readonly projectId: string }, hub: string = FIRST_HUB): string => `project:${hubKey(hub, projectKey(p))}`;

/** A settings page scoped to one project, in the form Settings' own links use (`for=<machine>/<project>`). */
const settingsFor = (tab: "agents" | "prompts" | "instructions", p: { readonly machineId: string; readonly projectId: string }): string =>
  `#/settings/${tab}?${new URLSearchParams({ for: projectKey(p) }).toString().replaceAll("%2F", "/")}`;

/** `hash` on hub `on`, when there are several. */
const onHub = (hash: string, on: HubEntry | undefined): string => (on === undefined ? hash : `${hash}${hash.includes("?") ? "&" : "?"}at=${on.id}`);

/**
 * One row per project. The machine name tells two checkouts of the same repo apart; `on`, given only when there are
 * several hubs, names the hub too, and the row opens on it.
 */
export const projectItems = (state: DataState, go: (hash: string) => void, on?: HubEntry): Command[] => {
  const machines = new Map((selectMachines(state) ?? []).map((m) => [m.machine.machineId, m.machine.name]));
  const there = (hash: string) => go(onHub(hash, on));
  return (selectProjects(state) ?? []).map((p): Command => {
    const machine = machines.get(p.machineId);
    // The machine id is never shown; a machine the snapshot doesn't name yet just goes unsaid.
    const where = [on?.label, machine === undefined ? undefined : `on ${machine}`].filter((w) => w !== undefined).join(" · ");
    return {
      id: itemId(p, on?.id),
      title: p.title,
      detail: where === "" ? "Chat with the lead" : `Chat with the lead · ${where}`,
      group: "projects",
      keywords: on === undefined ? [p.projectId] : [p.projectId, on.label],
      run: () => there(chatRoute(p.machineId, p.projectId)),
      actions: [
        { title: "Pull requests in this project", run: () => there(toHash(panelRoute(p, { tab: "prs", pr: null }))) },
        { title: "Instructions for this project", run: () => there(settingsFor("instructions", p)) },
        { title: "Prompts for this project", run: () => there(settingsFor("prompts", p)) },
        {
          title: "Max agents for this project",
          run: () => {
            focusSliderNext();
            there(settingsFor("agents", p));
          },
        },
      ],
    };
  });
};

/** The palette row of the project on screen, if a project's chat is open. */
export const currentProjectItem = (hash: string): string | undefined => {
  const screen = parseHash(hash);
  return screen.id === "project" ? itemId(screen.project, screen.at) : undefined;
};

export const projectSource = (hubs: HubSetStore): Source => ({
  id: "projects",
  items: () => {
    const all = hubs.getState().hubs;
    const go = (hash: string) => {
      window.location.hash = hash;
    };
    return all.flatMap((h) => projectItems(h.layer.store.getState(), go, all.length > 1 ? h : undefined));
  },
  subscribe: (onChange) => {
    let stops = hubs.getState().hubs.map((h) => h.layer.store.subscribe(onChange));
    const offSet = hubs.subscribe((s) => {
      for (const stop of stops) stop();
      stops = s.hubs.map((h) => h.layer.store.subscribe(onChange));
      onChange();
    });
    return () => {
      offSet();
      for (const stop of stops) stop();
    };
  },
});
