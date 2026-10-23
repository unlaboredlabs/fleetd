// The screen host: which component each route shows, so the router stays the one place routes meet screens.
import { lazy, Suspense, type ReactNode } from "react";
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
const PrsScreen = lazy(() => import("../prs/PrsScreen").then((m) => ({ default: m.PrsScreen })));
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
    case "agents":
      return { key: "agents", words: "Agents" };
    case "prs":
      return { key: `prs:${screen.project.machineId}/${screen.project.projectId}`, words: "Pull requests" };
    case "time":
      return { key: "time", words: "Time" };
    case "settings":
      return { key: "settings", words: "Settings" };
    case "machines":
      return { key: "machines", words: "Machines" };
    case "projects.add":
      return { key: "projects.add", words: "Add project" };
    case "onboarding":
      return { key: "onboarding", words: "the connect screen" };
    case "home":
      return { key: "home", words: "the home screen" };
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
    case "project":
      return (
        <ChatScreen
          key={`${screen.project.machineId}/${screen.project.projectId}`}
          project={screen.project}
          {...(screen.message !== null ? { message: screen.message } : {})}
        />
      );
    case "prs":
      return <PrsScreen key={`${screen.project.machineId}/${screen.project.projectId}`} project={screen.project} pr={screen.pr} />;
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
  }
}
