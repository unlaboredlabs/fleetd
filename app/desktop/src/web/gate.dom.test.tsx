// @vitest-environment happy-dom
// The web app's gate in Get started's look: each screen its bot, its title and one box with its one thing to do;
// an invitation joined or put off in turn, a refusal said in the box.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UiProvider } from "../renderer/ui";
import { Gate, type GateActions, type GateView } from "./Gate";
import type { AccountPreviewOutcome, DeleteAccountOutcome } from "../shared/cloud";
import type { WebFailure } from "./session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const actions = {
  signIn: vi.fn(),
  signUp: vi.fn(),
  retry: vi.fn(),
  join: vi.fn(),
  later: vi.fn(),
  makeTeam: vi.fn(() => Promise.resolve<WebFailure | null>(null)),
  accountPreview: vi.fn(() => Promise.resolve<AccountPreviewOutcome>({ ok: true, preview: { email: "ada@example.com", deletes: [], leaves: [], blocked: [] } })),
  deleteAccount: vi.fn(() => Promise.resolve<DeleteAccountOutcome>({ ok: true, workspaces: [] })),
  deleted: vi.fn(),
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

it("signed out: Welcome to fleetd, and Sign in or Make an account in the box", async () => {
  await show({ at: "signed-out" });
  expect(host.querySelector("[data-screen]")?.getAttribute("data-screen")).toBe("web.sign-in");
  expect(host.querySelector("h1")?.textContent).toBe("Welcome to fleetd");
  // The terms and privacy policy, before WorkOS's page: the App Store and the law ask for them where an account is made.
  const links = [...host.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
  expect(links).toEqual([
    ["terms of service", "https://fleetd.sh/terms"],
    ["privacy policy", "https://fleetd.sh/privacy"],
  ]);
  await press("Sign in");
  expect(actions.signIn).toHaveBeenCalledOnce();
  // The site's Sign up lands here: making an account is a button of its own, not a link under Sign in on WorkOS's page.
  await press("Make an account");
  expect(actions.signUp).toHaveBeenCalledOnce();
  expect(actions.signIn).toHaveBeenCalledOnce();
});

// S10: after Delete account the page was only the welcome, with no word that the account was gone.
it("signed out just after Delete account: says the account is deleted, and what a joined machine does", async () => {
  await show({ at: "signed-out", deleted: true });
  expect(host.querySelector("[data-deleted]")?.textContent).toBe(
    "Your fleetd account is deleted, with its workspaces.A machine you joined stops fleetd by itself. To remove fleetd there, run fleetd uninstall on it.",
  );
  await show({ at: "signed-out" });
  expect(host.querySelector("[data-deleted]")).toBeNull();
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
  expect(host.textContent).toContain("lee@example.com isn't in a fleetd workspace");
  // A team of their own, on asking; a refusal says why, in place, and it can be asked again.
  actions.makeTeam.mockResolvedValueOnce({ code: "rate_limited", message: "fleetd cloud is taking in too many new workspaces right now.", fix: "Try again in an hour." });
  await press("Make a workspace");
  expect(host.textContent).toContain("fleetd cloud is taking in too many new workspaces right now. Try again in an hour.");
  actions.makeTeam.mockResolvedValueOnce(null);
  await press("Make a workspace");
  expect(actions.makeTeam).toHaveBeenCalledTimes(2);
  // Made: the app opens on it, and a second press in the meantime would make another, so the button stays off.
  const make = [...host.querySelectorAll("button")].find((b) => b.textContent === "Make a workspace");
  expect(make?.disabled).toBe(true);
  await press("Make a workspace");
  expect(actions.makeTeam).toHaveBeenCalledTimes(2);
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

it("removed from a team since the last sign-in: the no-team and invited screens say it, in one line", async () => {
  await show({ at: "no-team", email: "lee@example.com", removed: "You were removed from acme." });
  // The removal is the headline: it is why there is no workspace.
  expect(host.querySelector("h1")?.textContent).toBe("You were removed from acme");
  expect(host.textContent).toContain("Signed in as lee@example.com");
  expect(host.textContent).toContain("Make a workspace of your own, or ask a teammate to invite this email.");
  expect(host.textContent).not.toContain("isn't in a fleetd workspace");
  await show({
    at: "invited",
    email: "lee@example.com",
    invitations: [{ name: "side", invitedBy: "ada@example.com", role: "member", accept: "a1" }],
    removed: "You were removed from acme.",
  });
  expect(host.textContent).toContain("You were removed from acme.");
  expect(host.textContent).toContain("Invited by ada@example.com");
  await show({ at: "no-team", email: "lee@example.com" });
  expect(host.textContent).not.toContain("removed");
});

it("no workspace: Delete account reads what goes, asks for the email typed back, and starts the page over", async () => {
  await show({ at: "no-team", email: "lee@example.com", removed: "You were removed from acme." });
  actions.accountPreview.mockResolvedValueOnce({ ok: true, preview: { email: "lee@example.com", deletes: [], leaves: [], blocked: [] } });
  await press("Delete account…");
  expect(actions.accountPreview).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Your sign-in and its history are erased.");
  const input = document.body.querySelector<HTMLInputElement>("input[type=email]");
  if (input === null) throw new Error("no email field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "lee@example.com");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  const remove = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Delete account");
  await act(async () => {
    remove?.click();
    await Promise.resolve();
  });
  expect(actions.deleteAccount).toHaveBeenCalledWith("lee@example.com");
  expect(actions.deleted).toHaveBeenCalledOnce();
});
