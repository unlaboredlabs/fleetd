// `#/` on a hub with no projects yet. For its owners and admins, while a required setup step is left, it is setup's
// welcome; once none is, and for everyone else, Get started (add a project, say hi). Its own chunk, with setup's.
import { useToolQuery } from "../../src/data/react";
import { useHubRole } from "../admin/role";
import { GetStarted } from "../onboarding";
import { Welcome } from "./SetupScreen";

const noInput = {};

export function FirstRun({ onAddProject }: { onAddProject: () => void }) {
  const role = useHubRole();
  const setup = useToolQuery("setup_list", noInput, { enabled: role.administers });
  // Nothing until it's known which, so the welcome never replaces Get started under the admin's eyes.
  if (role.pending || (role.administers && setup.data === undefined && setup.error === null)) return null;
  if (role.administers && setup.data !== undefined && setup.data.requiredLeft > 0) return <Welcome steps={setup.data.steps} />;
  return <GetStarted onAddProject={onAddProject} />;
}
