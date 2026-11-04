import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import type { CloudView } from "../../../shared/contracts";
import { useLive } from "../settings/hub";

const noInput = {};

/** The hub's cloud machines (cloud_get); undefined while they load, null from a hub without them. */
export function useCloud(enabled = true): CloudView | null | undefined {
  const live = useLive();
  const query = useToolQuery("cloud_get", noInput, { enabled: live && enabled });
  if (query.error instanceof CallError && lacksTool(query.error.error)) return null;
  return query.data?.cloud;
}
