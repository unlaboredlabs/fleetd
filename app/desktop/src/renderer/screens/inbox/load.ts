// Whether the open asks loaded, from the data layer's own asks_list query (the one it keeps loaded app-wide), so the
// inbox and the badge can say it failed instead of loading forever.
import type { HubError } from "../../../shared/hub";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";

const OPEN = { state: "open" } as const;

export interface AsksLoad {
  /** Why the last read failed; undefined while it hasn't, or once a retry worked. */
  readonly error: HubError | undefined;
  readonly retrying: boolean;
  readonly retry: () => void;
}

export const useAsksLoad = (): AsksLoad => {
  const q = useToolQuery("asks_list", OPEN);
  const error = !q.isError
    ? undefined
    : q.error instanceof CallError
      ? q.error.error
      : { code: "failed", message: q.error.message };
  return { error, retrying: q.isFetching, retry: () => void q.refetch() };
};
