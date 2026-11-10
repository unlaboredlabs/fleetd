// @vitest-environment happy-dom
// Settings › You › General, Name: the field holds the name the hub has for you, a member's too; Enter or leaving the
// field saves what was typed (person_name_set) and shows the hub's cleaned name; Escape puts the saved name back and
// asks the hub nothing; what the hub refuses shows in the row with the field kept as typed; a change made on another
// device (people.changed) shows by itself.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Person } from "../../../shared/contracts";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { YourName } from "./Name";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-19T10:00:00.000Z";

let host: HTMLDivElement;
let root: Root;
let me: Person | undefined;
let sets: string[];
/** What the hub answers a name with; the default keeps it, trimmed, as the hub does. */
let answer: (name: string) => CallOutcome;
let send: (frame: HubFrame) => void;

beforeEach(() => {
  me = { personId: "p_aaaaaaaa", name: "Sam Rivera", role: "member", createdAt: AT };
  sets = [];
  answer = (name) => {
    if (me !== undefined) me = { ...me, name: name.trim() };
    return { ok: true, output: { person: me } };
  };
  vi.stubGlobal("fleetd", { platform: "linux", fixture: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async () => {
  send = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "hub_info") return Promise.resolve({ ok: true, output: { version: "0.0.0", protocol: 1, busy: [], admin: false, ...(me === undefined ? {} : { me }) } });
      if (tool === "person_name_set") {
        const { name } = input as { name: string };
        sets.push(name);
        return Promise.resolve(answer(name));
      }
      return Promise.resolve({ ok: true, output: {} });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <YourName />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    send({ t: "state", state: { phase: "live", hub: "http://devbox.tail1234.ts.net:4790", protocol: 1 } });
    send({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 3; i++) await settle();
};

const field = () => {
  const input = host.querySelector<HTMLInputElement>("input[aria-label='Name']");
  if (input === null) throw new Error("no name field");
  return input;
};
/** Click into the field and type `value` over what it holds. */
const type = async (value: string) => {
  const input = field();
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};
const press = async (key: string) => {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i++) await settle();
};
const leave = async () => {
  await act(async () => {
    field().blur();
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i++) await settle();
};
const alert = () => host.querySelector("[role='alert']")?.textContent;

it("holds a member's name, and saves a new one on Enter as the hub cleaned it", async () => {
  await render();
  expect(field().value).toBe("Sam Rivera");
  await type("  Sam R. Rivera ");
  await press("Enter");
  expect(sets).toEqual(["  Sam R. Rivera "]);
  expect(field().value).toBe("Sam R. Rivera");
  expect(document.activeElement).not.toBe(field());
  expect(alert()).toBeUndefined();
});

it("saves on leaving the field, and asks the hub nothing when the name is the same", async () => {
  await render();
  await type("Samuel Rivera");
  await leave();
  expect(sets).toEqual(["Samuel Rivera"]);
  expect(field().value).toBe("Samuel Rivera");
  // Typed and put back, with a space after it: nothing to save.
  await type("Samuel Rivera ");
  await leave();
  expect(sets).toEqual(["Samuel Rivera"]);
  expect(field().value).toBe("Samuel Rivera");
});

it("puts the saved name back on Escape and asks the hub nothing", async () => {
  await render();
  await type("Somebody Else");
  await press("Escape");
  expect(field().value).toBe("Sam Rivera");
  expect(document.activeElement).not.toBe(field());
  expect(sets).toEqual([]);
  // The next edit saves as any other.
  await type("Sam");
  await leave();
  expect(sets).toEqual(["Sam"]);
});

it("shows what the hub refuses in the row, keeps what was typed, and Escape clears both", async () => {
  answer = () => ({ ok: false, error: { code: "invalid", message: "The name is empty.", fix: "Type the name you go by." } });
  await render();
  await type("   ");
  await press("Enter");
  expect(sets).toEqual(["   "]);
  expect(alert()).toBe("The name is empty. Type the name you go by.");
  expect(field().value).toBe("   ");
  expect(field().getAttribute("aria-invalid")).toBe("true");
  await act(async () => {
    field().focus();
    await Promise.resolve();
  });
  await press("Escape");
  expect(alert()).toBeUndefined();
  expect(field().value).toBe("Sam Rivera");
  expect(sets).toEqual(["   "]);
});

it("shows a name changed on another device, and has no field on a hub from before people", async () => {
  await render();
  me = { ...(me as Person), name: "Sam from the phone" };
  await act(async () => {
    send({ t: "event", event: { seq: 2, at: AT, type: "people.changed", summary: "Sam Rivera changed their name to Sam from the phone", data: { change: "renamed" } } });
    await new Promise((r) => setTimeout(r, 300));
  });
  for (let i = 0; i < 3; i++) await settle();
  expect(field().value).toBe("Sam from the phone");

  act(() => root.unmount());
  root = createRoot(host);
  me = undefined;
  await render();
  expect(host.querySelector("input")).toBeNull();
});
