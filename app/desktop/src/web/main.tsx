// The web app's entry (index.html): who is signed in first, then either the gate (Gate.tsx) or the desktop's own
// renderer, with window.fleetd made here (shell.ts) before the renderer's first module reads it.
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyTheme, UiProvider } from "../renderer/ui";
import "../renderer/src/styles.css";
import { browserDeps } from "./browser";
import { clearWebCache } from "./cache";
import { Gate, type GateView } from "./Gate";
import { createWebShell, followBrowser } from "./shell";
import { readSession, signInPath, teamHubIds, webCall, type WebFailure, type WebSession } from "./session";
import { startScreen, takeGithubReturn } from "../renderer/screens/start/kept";
import { toHash } from "../renderer/screens/shell/routes";

/** The build's version (VITE_FLEETD_VERSION, the commit), for an error card's Copy details. */
const VERSION = (import.meta.env["VITE_FLEETD_VERSION"] as string | undefined) ?? "web";

document.documentElement.dataset["shell"] = "web";
applyTheme();

const element = document.getElementById("root");
if (element === null) throw new Error("index.html has no #root");
let gate: Root | null = null;

const here = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
/** The invitations were answered (Join or Not now) in this tab: they're asked again at the next sign-in, not now. */
let answered = false;
/** The team last joined in this tab: the app opens on its Get started, its bots first (screens/start). */
let joinedTeam: string | null = null;

const teamOf = (body: unknown): string | null => {
  const team = typeof body === "object" && body !== null ? (body as { team?: unknown }).team : undefined;
  const id = typeof team === "object" && team !== null ? (team as { id?: unknown }).id : undefined;
  return typeof id === "string" && id !== "" ? id : null;
};

const show = (view: GateView) => {
  gate ??= createRoot(element);
  gate.render(
    <StrictMode>
      <UiProvider>
        <Gate
          view={view}
          actions={{
            signIn: () => window.location.assign(signInPath(here())),
            retry: () => void boot(),
            join: async (invitation): Promise<WebFailure | null> => {
              const out = await webCall(window.fetch.bind(window), "POST", "/web/accept", { json: { accept: invitation.accept } });
              if (out.ok) {
                joinedTeam = teamOf(out.body) ?? joinedTeam;
                return null;
              }
              if (out.signedOut === true) {
                window.location.assign(signInPath(here()));
                return null;
              }
              return out.failure;
            },
            later: () => {
              answered = true;
              void boot();
            },
            signOut: () => {
              clearWebCache(window.localStorage);
              void webCall(window.fetch.bind(window), "POST", "/web/sign-out").then(() => window.location.assign("/"));
            },
          }}
        />
      </UiProvider>
    </StrictMode>,
  );
};

const start = async (session: WebSession) => {
  gate?.unmount();
  gate = null;
  const { api, hubs } = createWebShell(session, browserDeps(VERSION));
  Object.defineProperty(window, "fleetd", { value: api, configurable: false, writable: false });
  followBrowser(hubs, window);
  // GitHub's trip back (`?github=…`): read before the app starts, the address cleaned whichever screen it came back to.
  takeGithubReturn();
  const joined = joinedTeam === null ? undefined : teamHubIds(session.teams.map((t) => t.id)).get(joinedTeam);
  if (joined !== undefined) window.location.hash = toHash(startScreen(joined));
  // The desktop's renderer, as it starts in the app: it reads window.fleetd as its modules load.
  await import("../renderer/src/main");
};

const boot = async () => {
  const read = await readSession(window.fetch.bind(window));
  if (!read.ok) {
    // Signed out: what the last account's teams left in this browser goes too.
    if (read.signedOut === true) clearWebCache(window.localStorage);
    show(read.signedOut === true ? { at: "signed-out" } : { at: "failed", failure: read.failure });
    return;
  }
  const { session } = read;
  if (session.invitations.length > 0 && !answered) show({ at: "invited", email: session.email, invitations: session.invitations });
  else if (session.teams.length === 0) show({ at: "no-team", email: session.email });
  else await start(session);
};

void boot();
