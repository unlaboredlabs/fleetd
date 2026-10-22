// The screen host: which component each route shows. Each screen writer swaps their placeholder for their
// component here (one import, one line), so the router stays the one place routes meet screens.
import { lazy, Suspense, type ReactNode } from "react";
import { EmptyState, GalleryScreen } from "../../ui";
import type { Screen } from "./routes";
import { ChatScreen } from "../chat";

// Each screen is its own chunk, loaded when its route first opens: the app starts by parsing the shell and the one
// screen it shows, not all of them (startup time and idle memory, perf/budgets.ts).
const OnboardingScreen = lazy(() => import("../onboarding/OnboardingScreen").then((m) => ({ default: m.OnboardingScreen })));
const SettingsScreen = lazy(() => import("../settings/SettingsScreen").then((m) => ({ default: m.SettingsScreen })));
const AddProjectScreen = lazy(() => import("../projects/AddProjectScreen").then((m) => ({ default: m.AddProjectScreen })));
const MachinesScreen = lazy(() => import("../projects/MachinesScreen").then((m) => ({ default: m.MachinesScreen })));
const AgentsScreen = lazy(() => import("../agents/AgentsScreen").then((m) => ({ default: m.AgentsScreen })));
const StatusScreen = lazy(() => import("../status/StatusScreen").then((m) => ({ default: m.StatusScreen })));
const TimeScreen = lazy(() => import("../time/TimeScreen").then((m) => ({ default: m.TimeScreen })));

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
    case "home":
      // Resolved by the frame to the last project; this shows only while the projects load or when there are none.
      return null;
    case "project":
      return (
        <ChatScreen
          key={`${screen.project.machineId}/${screen.project.projectId}`}
          project={screen.project}
          {...(screen.message !== null ? { message: screen.message } : {})}
        />
      );
    case "status":
      return <StatusScreen />;
    case "agents":
      return <AgentsScreen agent={screen.agent} />;
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
