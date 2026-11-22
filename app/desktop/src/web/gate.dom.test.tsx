// @vitest-environment happy-dom
// The web app's gate in Get started's look: each screen its bot, its title and one box with its one thing to do;
// an invitation joined or put off in turn, a refusal said in the box.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UiProvider } from "../renderer/ui";
import { Gate, type GateActions, type GateView } from "./Gate";
import type { WebFailure } from "./session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const actions = {
  signIn: vi.fn(),
  retry: vi.fn(),
  join: vi.fn(),
  later: vi.fn(),
  makeTeam: vi.fn(() => Promise.resolve<WebFailure | null>(null)),
  signOut: vi.fn(),
} satisfies GateActions;

const show = async (view: GateView) => {
  await act(async () => {
    root.render(
      <UiProvider>
        <Gate view={view} actions={actions} />
      </UiProvider>,
    );
    await Promise.resolve();
  });
};
const press = async (name: string) =>
  act(async () => {
    [...host.querySelectorAll("button")].find((b) => b.textContent === name)?.click();
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const f of Object.values(actions)) f.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("signed out: Welcome to fleetd, and Sign in in the box", async () => {
  await show({ at: "signed-out" });
  expect(host.querySelector("[data-screen]")?.getAttribute("data-screen")).toBe("web.sign-in");
  expect(host.querySelector("h1")?.textContent).toBe("Welcome to fleetd");
  await press("Sign in");
  expect(actions.signIn).toHaveBeenCalledOnce();
});

it("each invitation in turn: Join, a refusal said in the box, then Not now goes on to the app", async () => {
  const invitations = [
    {
      name: "inkwell",
      invitedBy: "sam@example.com",
      role: "member",
      accept: "a1",
    },
    { name: "acme", invitedBy: "ada@example.com", role: "admin", accept: "a2" },
  ];
  actions.join.mockResolvedValueOnce(null).mockResolvedValueOnce({
    code: "gone",
    message: "That invitation was taken back.",
  });
  await show({ at: "invited", email: "lee@example.com", invitations });
  expect(host.querySelector("h1")?.textContent).toBe("Join inkwell");
  expect(host.textContent).toContain("Invited by sam@example.com");
  await press("Join");
  expect(host.querySelector("h1")?.textContent).toBe("Join acme");
  expect(host.textContent).toContain("You'd join as an admin.");
  await press("Join");
  expect(host.querySelector("[role=alert]")?.textContent).toBe("That invitation was taken back.");
  await press("Not now");
  expect(actions.later).toHaveBeenCalledOnce();
});

it("no team (one who came by an invitation and passed), and a failure, each with its way on", async () => {
  await show({ at: "no-team", email: "lee@example.com" });
  expect(host.textContent).toContain("lee@example.com isn't in a fleetd team");
  // A team of their own, on asking; a refusal says why, in place.
  await press("Make a team");
  expect(actions.makeTeam).toHaveBeenCalledOnce();
  actions.makeTeam.mockResolvedValueOnce({ code: "rate_limited", message: "fleetd cloud is taking in too many new teams right now.", fix: "Try again in an hour." });
  await press("Make a team");
  expect(host.textContent).toContain("fleetd cloud is taking in too many new teams right now. Try again in an hour.");
  await press("Sign out");
  expect(actions.signOut).toHaveBeenCalledOnce();
  await show({
    at: "failed",
    failure: {
      code: "offline",
      message: "Can't reach fleetd cloud.",
      fix: "Check your connection, then try again.",
    },
  });
  expect(host.textContent).toContain("Check your connection");
  await press("Try again");
  expect(actions.retry).toHaveBeenCalledOnce();
});
