// One session in a window of its own, the pop-out for taking a page over: a title row, then the session at the window's
// size, and nothing else of the app (the main window keeps the notifications, the badge and the menu). The app's keymap
// runs here too, so ⌘⇧↩ (Ctrl+Shift+Enter) hands the page back before the page sees the keys.
import { useEffect } from "react";
import { useData } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { Text } from "../../ui";
import { installKeymap } from "../palette/keymap";
import type { ProjectKey } from "../shell/routes";
import { SessionView } from "./SessionView";
import { announceWindow } from "./windows";
import s from "./sessions.module.css";

export function SessionWindow({ project, id }: { project: ProjectKey; id: string }) {
  useEffect(() => announceWindow(id), [id]);
  useEffect(() => installKeymap(window.fleetd.platform, () => false), []);
  const title = useData((st) => st.projects[projectKey(project)]?.title);
  useEffect(() => {
    document.title = title === undefined ? "Session · fleetd" : `${title} · Session`;
  }, [title]);
  return (
    <div className={s.window} data-screen="session-window">
      <header className={s.windowBar}>
        <Text size="sm" strong>
          {title ?? "Session"}
        </Text>
        <Text size="xs" tone="quiet">
          Session
        </Text>
      </header>
      <SessionView project={project} id={id} windowed />
    </div>
  );
}
