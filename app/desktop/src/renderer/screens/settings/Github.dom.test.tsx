// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubAccount, GithubApp } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { GithubSettings } from "./Github";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-27T10:00:00.000Z";
const app: GithubApp = {
  appId: 4242,
  slug: "fleetd-on-devbox",
  name: "fleetd on devbox",
  clientId: "Iv23liTEST",
  owner: "acme",
  htmlUrl: "https://github.com/apps/fleetd-on-devbox",
  settingsUrl: "https://github.com/organizations/acme/settings/apps/fleetd-on-devbox",
  createdAt: AT,
};
const sam: GithubAccount = { login: "sam-rivera", userId: 583231, connectedAt: AT };

let host: HTMLDivElement;
let root: Root;
let calls: string[];
let hasApp: boolean;
let me: GithubAccount | undefined;
let connects: number;
let connectAnswer: CallOutcome;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  hasApp = true;
  me = undefined;
  connects = 0;
  connectAnswer = { ok: true, output: { me: sam } };
  vi.stubGlobal("fleetd", {
    platform: "linux",
    github: {
      connect: (): Promise<CallOutcome> => {
        connects += 1;
        if (connectAnswer.ok) me = sam;
        return Promise.resolve(connectAnswer);
      },
      cancel: () => Promise.resolve(),
    },
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const answer = (tool: string): CallOutcome => {
  calls.push(tool);
  switch (tool) {
    case "github_app_get":
      return { ok: true, output: { ...(hasApp ? { app } : {}), ...(me === undefined ? {} : { me }), permissions: [], authorizeUrl: "https://github.com/login/oauth/authorize" } };
    case "github_disconnect":
      me = undefined;
      return { ok: true, output: { revoked: true } };
    default:
      return { ok: true, output: {} };
  }
};

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool) => Promise.resolve(answer(tool)),
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <GithubSettings />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  await settle();
};

const button = (text: string) => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text} in: ${document.body.textContent}`);
  return b;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
  await settle();
};

describe("Settings › GitHub", () => {
  it("asks to connect before a first PR, and connects through main", async () => {
    await render();
    expect(document.body.textContent).toContain("Not connected");
    expect(document.body.textContent).toContain("Connect before your first PR");
    await click(button("Connect GitHub"));
    expect(connects).toBe(1);
    expect(document.body.textContent).toContain("Connected as sam-rivera");
  });

  it("says what went wrong, but not a cancel", async () => {
    connectAnswer = { ok: false, error: { code: "refused", message: "GitHub didn't connect: the sign-in was cancelled." } };
    await render();
    await click(button("Connect GitHub"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("the sign-in was cancelled");
  });

  it("offers Connect again on a lapsed connection, and Disconnect revokes", async () => {
    me = { ...sam, lapsed: true };
    await render();
    expect(document.body.textContent).toContain("GitHub no longer takes your connection as sam-rivera");
    await click(button("Connect again"));
    expect(document.body.textContent).toContain("Connected as sam-rivera");
    await click(button("Disconnect"));
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent.trim() === "Disconnect");
    if (confirm === undefined) throw new Error("no confirm");
    await click(confirm);
    expect(calls).toContain("github_disconnect");
    expect(document.body.textContent).toContain("Not connected");
  });

  it("says when the hub has no App", async () => {
    hasApp = false;
    await render();
    expect(document.body.textContent).toContain("This hub has no GitHub App yet");
    expect([...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Connect GitHub")).toBe(false);
  });
});
