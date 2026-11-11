// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, SetupChanged } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { pageOf, SetupChangedLine } from "./SetupChanged";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { machineId: "devbox", projectId: "shop" };
const line = (text: string, setupChanged: SetupChanged) =>
  ({ messageId: "m9", projectRef: project, seq: 9, author: "system", text, createdAt: "2026-11-11T10:00:00.000Z", state: "final", attachments: [], setupChanged }) as ChatMessage;

let host: HTMLDivElement;
let root: Root;
let calls: { tool: string; input: unknown }[];
let answer: Awaited<ReturnType<HubApi["call"]>>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  answer = { ok: true, output: { ok: true } };
  window.location.hash = "#/";
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async (message: ChatMessage) => {
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve(answer);
    },
    subscribe: () => () => undefined,
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <SetupChangedLine project={project} message={message} changed={message.setupChanged ?? { kind: "title" }} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
};

const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const click = async (text: string) => {
  const b = button(text);
  if (b === undefined) throw new Error(`no button ${text}`);
  await act(async () => {
    b.click();
    await Promise.resolve();
  });
};

describe("a lead's setup change in the chat", () => {
  it("says what changed, with Open and Undo", async () => {
    await render(line("Added the repo api", { kind: "repo_added", names: ["api"] }));
    expect(host.textContent).toContain("Added the repo api");
    expect(button("Open")).toBeDefined();
    expect(button("Undo")).toBeDefined();
  });

  it("Undo asks the hub to put back what was there, for this line", async () => {
    await render(line("Renamed the project to Storefront", { kind: "title" }));
    await click("Undo");
    expect(calls).toEqual([{ tool: "project_setup_undo", input: { projectRef: project, messageId: "m9" } }]);
  });

  it("an undone line says so in place of the button, and still opens", async () => {
    await render(line("Archived the project", { kind: "archived", undone: true }));
    expect(button("Undo")).toBeUndefined();
    expect(host.textContent).toContain("Undone");
    expect(button("Open")).toBeDefined();
  });

  it("a refused Undo says why, with the fix", async () => {
    answer = { ok: false, error: { code: "not_found", message: "The repo api is gone.", fix: "Add it again in the project's settings." } };
    await render(line("Set the setup commands of api", { kind: "setup" }));
    await click("Undo");
    expect(host.textContent).toContain("The repo api is gone. Add it again in the project's settings.");
    expect(button("Undo")).toBeDefined();
  });

  it("Open goes to the page of the project's settings that shows the change", async () => {
    expect(pageOf({ kind: "repo_added" })).toBe("projects");
    expect(pageOf({ kind: "instructions" })).toBe("instructions");
    expect(pageOf({ kind: "env", names: ["API_BASE"] })).toBe("project-vault");
    expect(pageOf({ kind: "a newer hub's" })).toBe("projects");
    await render(line("Set the variable API_BASE", { kind: "env", names: ["API_BASE"] }));
    await click("Open");
    expect(window.location.hash).toBe("#/settings/project-vault?for=devbox/shop");
  });
});
