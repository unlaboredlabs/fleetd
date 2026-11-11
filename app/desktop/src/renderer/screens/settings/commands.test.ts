// @vitest-environment happy-dom
// Settings in the palette: every command still opens the page that holds what it names, a page that became a part of
// another (route.ts) opening that page, and a member is offered no Hub page.
import { afterEach, expect, it } from "vitest";
import type { DataLayer } from "../../src/data/queries";
import { commandFor, runCommand } from "../palette";
import { registerSettingsCommands } from "./commands";
import { pageOf, parseRoute } from "./route";

const layer = (admin: boolean): DataLayer =>
  ({
    toolQuery: (tool: string) => ({ queryKey: [tool] }),
    queryClient: { getQueryData: ([tool]: [string]) => (tool === "hub_info" ? { admin, me: { role: admin ? "owner" : "member" } } : { requiredLeft: 0 }) },
  }) as unknown as DataLayer;

/** Where a command goes: the tab its link names, and the page that tab is on. */
const lands = (id: string) => {
  window.location.hash = "";
  if (!runCommand(id)) return null;
  const { tab } = parseRoute(window.location.hash);
  return [tab, pageOf(tab)];
};

let off: (() => void) | undefined;
afterEach(() => {
  off?.();
  window.location.hash = "";
});

it("opens each Settings command on the page that holds it now", () => {
  off = registerSettingsCommands(layer(true));
  expect(lands("settings.open")).toEqual(["general", "general"]);
  expect(lands("go:settings.accounts")).toEqual(["accounts", "accounts"]);
  expect(lands("go:settings.your-memory")).toEqual(["your-memory", "your-memory"]);
  // Your devices is a part of Hubs & devices, and the hub's Tools & skills of Every project › Agents.
  expect(lands("go:settings.devices")).toEqual(["devices", "hubs"]);
  expect(lands("go:settings.hubs")).toEqual(["hubs", "hubs"]);
  expect(lands("setting:Hub")).toEqual(["hubs", "hubs"]);
  expect(lands("go:hub.machines")).toEqual(["hub.machines", "hub.machines"]);
  expect(lands("go:hub.profiles")).toEqual(["hub.profiles", "hub.profiles"]);
  expect(lands("go:hub.tools")).toEqual(["hub.tools", "hub.profiles"]);
  expect(lands("go:hub.instructions")).toEqual(["hub.instructions", "hub.instructions"]);
  // Hub accounts is a part of Hub › Setup: its command still opens it, by its old name, and Setup has one of its own.
  expect(lands("go:hub.accounts")).toEqual(["hub.accounts", "hub.setup"]);
  expect(commandFor("go:hub.accounts")?.title).toBe("Hub accounts");
  expect(lands("go:hub.setup")).toEqual(["hub.setup", "hub.setup"]);
  expect(commandFor("go:settings.hubs")?.title).toBe("Hubs & devices");
});

it("offers a member no Hub page", () => {
  off = registerSettingsCommands(layer(false));
  for (const id of ["go:hub.machines", "go:hub.profiles", "go:hub.tools", "go:hub.instructions", "go:hub.accounts", "go:hub.setup"]) expect(commandFor(id), id).toBeUndefined();
  expect(lands("go:settings.devices")).toEqual(["devices", "hubs"]);
});
