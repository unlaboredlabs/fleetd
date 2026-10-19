// The screen host: which component each route shows. Each screen writer swaps their placeholder for their
// component here (one import, one line), so the router stays the one place routes meet screens.
import { Suspense } from "react";
import { EmptyState, GalleryScreen } from "../../ui";
import { OnboardingScreen } from "../onboarding";
import { InboxPanel } from "../inbox";
import { SettingsScreen } from "../settings/SettingsScreen";
import { BoardScreen } from "../board/BoardScreen";
import { BoardStrips } from "../board/Strips";
import { AddProjectScreen, MachinesScreen } from "../projects";
import { StatusScreen } from "../status/StatusScreen";
import { TimeScreen } from "../time/TimeScreen";
import { OrderScreen } from "../order/OrderScreen";
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
      return <BoardScreen project={screen.project} />;
    case "order":
      return (
        <OrderScreen
          key={screen.orderId}
          id={screen.orderId}
          {...(screen.at ? { jump: { thread: screen.at.threadId, item: screen.at.itemId } } : {})}
        />
      );
    case "status":
      return <StatusScreen />;
    case "machines":
      return <MachinesScreen />;
    case "time":
      return <TimeScreen order={screen.orderId ?? undefined} />;
    case "projects.add":
      return <AddProjectScreen />;
    case "settings":
      return <SettingsScreen />;
    case "onboarding":
      return <OnboardingScreen hub={screen.hub ?? undefined} code={screen.code ?? undefined} />;
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
export function InboxBody({ askId }: { askId: string | null; onClose: () => void }) {
  return <InboxPanel askId={askId ?? undefined} />;
}

/** The machine and train strips along the bottom (F2). Renders nothing until there is something to show. */
export function StripsBody(props: { onOpenMachines: () => void }) {
  return <BoardStrips onOpenMachines={props.onOpenMachines} />;
}
