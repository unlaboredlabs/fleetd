// `#/` on a hub with no projects yet. On a team of fleetd cloud with no machine yet, its owners and admins connect a
// computer first, unless this device joined the team by an invitation: someone else's team never opens on connecting
// this computer to it (a machine still joins from Settings › Hub › Machines, Add machine). Otherwise, for owners and admins while a required setup step is left, it is setup's welcome; once
// none is, and for everyone else, Get started (add a project). Its own chunk, with setup's.
import { useState } from "react";
import { useData, useHub, useToolQuery } from "../../src/data/react";
import { useHubRole, useServes } from "../admin/role";
import { GetStarted } from "../onboarding";
import { ConnectComputer } from "./ConnectComputer";
import { useFreshSetup, Welcome } from "./SetupScreen";

const noInput = {};

export function FirstRun({ onAddProject }: { onAddProject: () => void }) {
  const role = useHubRole();
  // fleetd cloud has no setup steps: its admins go on to Connect a computer or Get started.
  const served = useServes("setup_list");
  const steps = role.administers && served;
  useFreshSetup(steps);
  const setup = useToolQuery("setup_list", noInput, { enabled: steps });
  const hub = useHub();
  const cloud = hub.cloud === true && hub.invited !== true;
  const fresh = useData((d) => d.fresh);
  const machines = useData((d) => Object.keys(d.machines).length);
  // Once shown, Connect a computer stays until the person moves on, so the machine that joins is greeted there.
  const [connecting, setConnecting] = useState(false);
  if (!connecting && cloud && fresh && role.administers && machines === 0) setConnecting(true);
  if (connecting) return <ConnectComputer onAddProject={onAddProject} />;
  // Nothing until it's known which, so the welcome never replaces Get started under the admin's eyes.
  if (role.pending || (steps && setup.data === undefined && setup.error === null)) return null;
  if (steps && setup.data !== undefined && setup.data.requiredLeft > 0) return <Welcome steps={setup.data.steps} />;
  return <GetStarted onAddProject={onAddProject} />;
}
