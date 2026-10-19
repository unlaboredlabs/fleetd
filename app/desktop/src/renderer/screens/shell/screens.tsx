// The screen host: which component each route shows. Each screen writer swaps their placeholder for their
// component here (one import, one line), so the router stays the one place routes meet screens.
import { lazy, Suspense, type ReactNode } from "react";
import { EmptyState, GalleryScreen } from "../../ui";
import type { Screen } from "./routes";

// Each screen is its own chunk, loaded when its route first opens: the app starts by parsing the shell and the one
// screen it shows, not all of them (startup time and idle memory, perf/budgets.ts).
const OnboardingScreen = lazy(() => import("../onboarding/OnboardingScreen").then((m) => ({ default: m.OnboardingScreen })));
const InboxPanel = lazy(() => import("../inbox/InboxPanel").then((m) => ({ default: m.InboxPanel })));
const SettingsScreen = lazy(() => import("../settings/SettingsScreen").then((m) => ({ default: m.SettingsScreen })));
const BoardScreen = lazy(() => import("../board/BoardScreen").then((m) => ({ default: m.BoardScreen })));
const BoardStrips = lazy(() => import("../board/Strips").then((m) => ({ default: m.BoardStrips })));
const AddProjectScreen = lazy(() => import("../projects/AddProjectScreen").then((m) => ({ default: m.AddProjectScreen })));
const MachinesScreen = lazy(() => import("../projects/MachinesScreen").then((m) => ({ default: m.MachinesScreen })));
const StatusScreen = lazy(() => import("../status/StatusScreen").then((m) => ({ default: m.StatusScreen })));
const TimeScreen = lazy(() => import("../time/TimeScreen").then((m) => ({ default: m.TimeScreen })));
const OrderScreen = lazy(() => import("../order/OrderScreen").then((m) => ({ default: m.OrderScreen })));

/** Holds a screen's place, busy (which the QA gate waits out), while its chunk loads. */
const Loading = ({ children }: { children: ReactNode }) => <Suspense fallback={<div aria-busy="true" />}>{children}</Suspense>;

/** A screen that hasn't landed yet. It carries the screen's id, so the route table is testable end to end now. */
function Pending({ id, title }: { id: string; title: string }) {
  return (
    <div data-screen={id} style={{ display: "contents" }}>
      <EmptyState title={title}>This screen is on its way.</EmptyState>
    </div>
  );
}

export function ScreenHost({ screen }: { screen: Screen }) {
  return <Loading>{screenFor(screen)}</Loading>;
}

function screenFor(screen: Screen): ReactNode {
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
        <GalleryScreen />
      );
  }
}

/** The inbox panel's body (F5): the question cards, scrolled to `askId` when given. */
export function InboxBody({ askId }: { askId: string | null; onClose: () => void }) {
  return (
    <Loading>
      <InboxPanel askId={askId ?? undefined} />
    </Loading>
  );
}

/** The machine and train strips along the bottom (F2). Renders nothing until there is something to show. */
export function StripsBody(props: { onOpenMachines: () => void }) {
  return (
    <Suspense>
      <BoardStrips onOpenMachines={props.onOpenMachines} />
    </Suspense>
  );
}
