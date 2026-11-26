// `#/` on a hub with no projects yet. On a team of fleetd cloud with nothing to run agents on yet, its owners and admins
// pick where agents run first (a computer, or hosted sandboxes: ConnectComputer), unless this device joined the team by
// an invitation: someone else's team never opens on connecting this computer to it (a machine still joins from Settings ›
// Hub › Machines, Add machine). A team paired with a code, which no sign-in marked either way, opens on it for its owner
// alone. Otherwise, for owners and admins while a required setup step is left, it is setup's
// welcome; once none is, and for everyone else, Get started (add a project). Its own chunk, with setup's. On a fleetd
// cloud team in the web app it is Get started's page (screens/start) instead, for everyone, until its Skip for now;
// while the team can't run anything yet (no computer of its own, no plan or credits: start/runs.ts), whatever was
// skipped before, but for a Skip pressed since the page loaded. Where agents run waits on the same.
import { useEffect, useState } from "react";
import { useHub, useToolQuery } from "../../src/data/react";
import { useHubRole, useServes } from "../admin/role";
import { GetStarted } from "../onboarding";
import { navigate, useRoute } from "../shell/navigation";
import { skipped, startScreen, useKept } from "../start/kept";
import { useRunsNothing } from "../start/runs";
import { onWeb } from "../../src/web";
import { ConnectComputer, whereOpen } from "./ConnectComputer";
import { useFreshSetup, Welcome } from "./SetupScreen";

const noInput = {};

export function FirstRun({ onAddProject }: { onAddProject: () => void }) {
  const role = useHubRole();
  // fleetd cloud has no setup steps: its admins go on to Where agents run or Get started.
  const served = useServes("setup_list");
  const steps = role.administers && served;
  useFreshSetup(steps);
  const setup = useToolQuery("setup_list", noInput, { enabled: steps });
  const hub = useHub();
  // The web app's cloud teams have Get started instead, Skip for now included.
  const cloud = hub.cloud === true && hub.invited !== true && !onWeb() && (hub.codePaired !== true || role.me?.role === "owner");
  const idle = useRunsNothing();
  // Once shown, Where agents run stays until the person moves on, so what joins (a computer, or the hub's runner for
  // hosted sandboxes) is greeted there.
  const [shown, setConnecting] = useState(false);
  // ...a resync that mounts the home again included.
  const connecting = shown || (cloud && whereOpen(hub.id));
  // A Skip for now kept from before holds once the team can run something; one pressed since the page loaded, at once.
  const kept = useKept(hub.id).later === true;
  const later = kept && (idle === false || skipped(hub.id));
  // Settings opened by its address (Stripe's way back to Billing, a link) stays open: Get started is behind it.
  const settings = useRoute().id === "settings";
  const web = onWeb() && hub.cloud === true && !settings;
  // Nothing until the team has said which, where it decides what opens.
  const asking = idle === undefined && ((web && kept && !later) || (cloud && role.administers && !connecting));
  const start = web && !later && !asking;
  useEffect(() => {
    if (start) navigate(startScreen(hub.id), { replace: true });
  }, [start, hub.id]);
  if (start || asking) return null;
  if (!connecting && cloud && role.administers && idle === true) setConnecting(true);
  if (connecting) return <ConnectComputer onAddProject={onAddProject} />;
  // Nothing until it's known which, so the welcome never replaces Get started under the admin's eyes.
  if (role.pending || (steps && setup.data === undefined && setup.error === null)) return null;
  if (steps && setup.data !== undefined && setup.data.requiredLeft > 0) return <Welcome steps={setup.data.steps} />;
  return <GetStarted onAddProject={onAddProject} />;
}
