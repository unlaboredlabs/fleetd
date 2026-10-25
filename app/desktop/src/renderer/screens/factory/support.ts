// Whether the hub reports metrics at all: a hub from before metrics_get (or an older hub on any machine) has no
// Factory to show, so its sidebar entry, menu item, palette command and shortcut go, rather than a screen that says
// the hub couldn't answer. Asked once per connection (a reconnect drops every answer, so a hub updated meanwhile is
// asked again), the way the chat asks whether the hub can stop a lead: an empty input runs nothing, a hub with the
// tool refuses it as invalid, one without says it has no such tool.
import { useQuery } from "@tanstack/react-query";
import type { HubError } from "../../../shared/hub";
import { useData, useDataLayer } from "../../src/data/react";

/** A hub without the tool answers "not found". */
export const lacksMetrics = (error: Pick<HubError, "code">): boolean => error.code === "not_found";

/** What the probe's answer says: true (it has the tool), false (it doesn't), undefined (couldn't tell: ask again). */
export const metricsSupport = (outcome: { readonly ok: true } | { readonly ok: false; readonly error: Pick<HubError, "code"> }): boolean | undefined => {
  if (outcome.ok || outcome.error.code === "invalid") return true;
  return lacksMetrics(outcome.error) ? false : undefined;
};

/** Undefined until the hub has said (and while there is no hub): the Factory stays where it is until it's known gone. */
export const useMetricsSupport = (): boolean | undefined => {
  const layer = useDataLayer();
  const fresh = useData((s) => s.fresh);
  const probe = useQuery({
    queryKey: ["probe", "metrics_get"],
    queryFn: async () => {
      // The probe's input is empty on purpose: it must not run a read.
      const outcome = await layer.call("metrics_get", {} as never);
      const known = metricsSupport(outcome);
      if (known === undefined) throw new Error("couldn't tell whether the hub reports metrics");
      return known;
    },
    enabled: fresh,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return probe.data;
};
