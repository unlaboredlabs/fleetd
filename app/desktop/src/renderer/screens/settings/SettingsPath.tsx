// A Settings path in the app's own words, for the hub on screen: "Settings › Hub › Machines", or "Settings › Team ›
// Machines" on a fleetd cloud team (shared/settingsPages.ts settingsPath).
import { settingsPath } from "../../../shared/settingsPages";
import { useCloudTeam } from "../../src/data/react";

export function SettingsPath({ parts = [] }: { parts?: readonly string[] }) {
  return <>{settingsPath(useCloudTeam(), ...parts)}</>;
}
