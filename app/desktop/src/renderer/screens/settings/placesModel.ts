// Hub › Machines' one model, apart from React: every place agents and screens run (a machine, a hosted sandbox
// provider) is a row with its state as one dot and, at its end, what it is doing or what is wrong in a few words.
// Pure so it is tested on its own.
import type { Mark } from "./parts";

/** A machine's dot: ready while online with nothing failing, needs someone otherwise. */
export const machineMark = (status: string, needs: string | undefined): Mark => (status === "online" && needs === undefined ? "ready" : "needs");

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What a well machine is doing, at its row's end: the agents running there and the screens it hosts now, only the
 * kinds it is for; Idle when nothing runs.
 */
export const loadWords = (load: { agents?: number | undefined; screens?: number | undefined }): string => {
  const parts = [
    load.agents === undefined || load.agents === 0 ? null : count(load.agents, "agent", "agents"),
    load.screens === undefined || load.screens === 0 ? null : count(load.screens, "screen", "screens"),
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? "Idle" : parts.join(" · ");
};
