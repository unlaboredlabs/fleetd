// The Factory's two tabs, in its title row: Output (this screen, #/factory) and Agent time (the time inspector,
// #/factory/time). A hub from before metrics has no Output, so its Factory is Agent time alone, with no tabs.
import { Segmented } from "../../ui";
import { toHash } from "../shell/routes";
import { useMetricsSupport } from "./support";

export type FactoryTab = "output" | "time";

const TABS = [
  { value: "output", label: "Output" },
  { value: "time", label: "Agent time" },
] as const;

export function FactoryTabs({ tab }: { tab: FactoryTab }) {
  const metrics = useMetricsSupport();
  if (metrics === false) return null;
  return (
    <Segmented<FactoryTab>
      label="Factory"
      options={TABS}
      value={tab}
      onChange={(t) => {
        window.location.hash = toHash(t === "output" ? { id: "factory", project: null } : { id: "time", orderId: null });
      }}
    />
  );
}
