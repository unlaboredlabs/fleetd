// The screen host: which component each route shows, so the router stays the one place routes meet screens.
import { lazy, Suspense, type ReactNode } from "react";
import type { Screen } from "./routes";
import { ChatScreen } from "../chat";

// Each screen is its own chunk, loaded when its route first opens: the app starts by parsing the shell and the one
// screen it shows, not all of them (startup time and idle memory, perf/budgets.ts).
const OnboardingScreen = lazy(() => import("../onboarding/OnboardingScreen").then((m) => ({ default: m.OnboardingScreen })));
const SettingsScreen = lazy(() => import("../settings/SettingsScreen").then((m) => ({ default: m.SettingsScreen })));
const AdminScreen = lazy(() => import("../admin/AdminScreen").then((m) => ({ default: m.AdminScreen })));
const AddProjectScreen = lazy(() => import("../projects/AddProjectScreen").then((m) => ({ default: m.AddProjectScreen })));
const MachinesScreen = lazy(() => import("../projects/MachinesScreen").then((m) => ({ default: m.MachinesScreen })));
const StatusScreen = lazy(() => import("../status/StatusScreen").then((m) => ({ default: m.StatusScreen })));
const FactoryScreen = lazy(() => import("../factory/FactoryScreen").then((m) => ({ default: m.FactoryScreen })));
const TimeScreen = lazy(() => import("../time/TimeScreen").then((m) => ({ default: m.TimeScreen })));

/** Holds a screen's place, busy (which the QA gate waits out), while its chunk loads. */
const Loading = ({ children }: { children: ReactNode }) => <Suspense fallback={<div aria-busy="true" />}>{children}</Suspense>;

/** A screen in words, for its error card and the log, and its identity: a new key opens it afresh. */
export const screenPart = (screen: Screen): { key: string; words: string } => {
  switch (screen.id) {
    case "project":
      return { key: `project:${screen.project.machineId}/${screen.project.projectId}`, words: "the chat" };
    case "status":
      return { key: "status", words: "Status" };
    case "factory":
      return { key: "factory", words: "Factory" };
    case "time":
      return { key: "time", words: "Time" };
    case "settings":
      return { key: "settings", words: "Settings" };
    case "admin":
      return { key: "admin", words: "Administration" };
    case "machines":
      return { key: "machines", words: "Machines" };
    case "projects.add":
      return { key: "projects.add", words: "Add project" };
    case "onboarding":
      return { key: "onboarding", words: "the connect screen" };
    case "home":
      return { key: "home", words: "the home screen" };
    case "session":
      return { key: `session:${screen.session}`, words: "the screen" };
  }
};

export function ScreenHost({ screen }: { screen: Screen }) {
  return <Loading>{screenFor(screen)}</Loading>;
}

function screenFor(screen: Screen): ReactNode {
  switch (screen.id) {
    case "home":
      // Resolved by the frame to the last project; this shows only while the projects load or when there are none.
      return null;
    case "session":
      // A window of its own shows it (sessions/SessionWindow); the main window opens it in its project's panel.
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
    case "factory":
      return <FactoryScreen project={screen.project} />;
    case "machines":
      return <MachinesScreen />;
    case "time":
      return <TimeScreen order={screen.orderId ?? undefined} />;
    case "projects.add":
      return <AddProjectScreen />;
    case "settings":
      return <SettingsScreen />;
    case "admin":
      return <AdminScreen />;
    case "onboarding":
      return <OnboardingScreen hub={screen.hub ?? undefined} code={screen.code ?? undefined} />;
  }
}
