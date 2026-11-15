// The route a session's own window opens on (`#/session/<machine>/<project>/<session>`): main's pop-out window
// (main/sessionWindow.ts) and the web app's new tab (src/web/shell.ts) build it from the ids, never from a URL.
import type { SessionWindowRequest } from "./ipc";

export const sessionHash = ({ machineId, projectId, session, hub }: SessionWindowRequest): string =>
  `#/session/${[machineId, projectId, session].map(encodeURIComponent).join("/")}${hub === undefined ? "" : `?at=${hub}`}`;
