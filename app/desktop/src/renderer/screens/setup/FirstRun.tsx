// `#/` on a hub with no projects yet. On a team of fleetd cloud with no machine yet, its owners and admins connect a
// computer first. Otherwise, for owners and admins while a required setup step is left, it is setup's welcome; once
// none is, and for everyone else, Get started (add a project). Its own chunk, with setup's.
import { useState } from "react";
import { useData, useHub, useToolQuery } from "../../src/data/react";
import { useHubRole } from "../admin/role";
import { GetStarted } from "../onboarding";
import { ConnectComputer } from "./ConnectComputer";
import { useFreshSetup, Welcome } from "./SetupScreen";

const noInput = {};

export function FirstRun({ onAddProject }: { onAddProject: () => void }) {
  const role = useHubRole();
  useFreshSetup(role.administers);
  const setup = useToolQuery("setup_list", noInput, { enabled: role.administers });
  const cloud = useHub().cloud === true;
  const fresh = useData((d) => d.fresh);
  const machines = useData((d) => Object.keys(d.machines).length);
  // Once shown, Connect a computer stays until the person moves on, so the machine that joins is greeted there.
  const [connecting, setConnecting] = useState(false);
  if (!connecting && cloud && fresh && role.administers && machines === 0) setConnecting(true);
  if (connecting) return <ConnectComputer onAddProject={onAddProject} />;
  // Nothing until it's known which, so the welcome never replaces Get started under the admin's eyes.
  if (role.pending || (role.administers && setup.data === undefined && setup.error === null)) return null;
  if (role.administers && setup.data !== undefined && setup.data.requiredLeft > 0) return <Welcome steps={setup.data.steps} />;
  return <GetStarted onAddProject={onAddProject} />;
}
