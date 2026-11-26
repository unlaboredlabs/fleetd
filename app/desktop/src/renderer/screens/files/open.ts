// Open on a chat file, wherever it shows (its card, the Artifacts tab's Files): a file fleetd shows itself opens in
// the wide panel (FileView); Word, PowerPoint and zips open in this computer's app, or save on the web.
import { navigate } from "../shell/navigation";
import { panelRoute, type ProjectKey } from "../shell/routes";
import { showsInside } from "./kind";

/** True when it opened in the panel; false when the file is one for `elsewhere` (its app, or a download). */
export const openChatFile = (project: ProjectKey, file: { readonly attachmentId: string; readonly name: string; readonly mime: string }): boolean => {
  if (!showsInside(file.name, file.mime)) return false;
  navigate(panelRoute({ machineId: project.machineId, projectId: project.projectId }, { tab: "artifacts", artifact: null, file: file.attachmentId }));
  return true;
};
