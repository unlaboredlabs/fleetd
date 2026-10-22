// Small helpers over the data layer's view of live work, shared by the strip and its lanes.
import type { BoardData } from "../../src/data/selectors";
import { projectKey as key, type ProjectKey as Key } from "../../src/data/store";

export type ProjectKey = Key;
export const projectKey = key;

/** The hub's clock now, from the live feed's skew, so elapsed times match the hub's. */
export const hubNow = (d: BoardData, localNowMs: number): number => localNowMs + d.skewMs;
