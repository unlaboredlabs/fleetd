// The screen host: which component each route shows. Each screen writer swaps their placeholder for their
// component here (one import, one line), so the router stays the one place routes meet screens.
import { Suspense } from "react";
import { EmptyState, GalleryScreen } from "../../ui";
import { StatusScreen } from "../status/StatusScreen";
import type { Screen } from "./routes";

/** A screen that hasn't landed yet. It carries the screen's id, so the route table is testable end to end now. */
function Pending({ id, title }: { id: string; title: string }) {
  return (
    <div data-screen={id} style={{ display: "contents" }}>
      <EmptyState title={title}>This screen is on its way.</EmptyState>
    </div>
  );
}

export function ScreenHost({ screen }: { screen: Screen }) {
  switch (screen.id) {
    case "board":
      return <Pending id="board" title="Board" />;
    case "order":
      return <Pending id="order" title="Order" />;
    case "status":
      return <StatusScreen />;
    case "machines":
      return <Pending id="machines" title="Machines" />;
    case "time":
      return <Pending id="time" title="Time" />;
    case "projects.add":
      return <Pending id="projects.add" title="Add a project" />;
    case "settings":
      return <Pending id={`settings.${screen.tab}`} title="Settings" />;
    case "onboarding":
      return <Pending id="onboarding" title="Connect to your hub" />;
    case "gallery":
      // Only dev builds and the screenshot suite's build carry the gallery.
      return GalleryScreen === null ? (
        <Pending id="gallery" title="Gallery" />
      ) : (
        <Suspense>
          <GalleryScreen />
        </Suspense>
      );
  }
}

/** The inbox panel's body (F5): the question cards, scrolled to `askId` when given. */
export function InboxBody(_props: { askId: string | null; onClose: () => void }) {
  return (
    <div data-screen="inbox">
      <EmptyState title="Nothing needs you">Questions from your leads show up here.</EmptyState>
    </div>
  );
}

/** The machine and train strips along the bottom (F2). Renders nothing until there is something to show. */
export function StripsBody(_props: { onOpenMachines: () => void }) {
  return null;
}
