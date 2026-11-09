import { describe, expect, it } from "vitest";
import { IPC } from "../shared/channels";
import { parseRequest } from "../shared/ipc";
import { applyMenuState } from "./menuState";

describe("menu state", () => {
  it("greys out the commands the screen doesn't offer (Focus Composer away from a chat)", () => {
    const items = new Map(["composer.focus", "project.next", "go:time", "settings.open"].map((id) => [id, { enabled: true }]));
    applyMenuState({ getMenuItemById: (id) => items.get(id) ?? null }, ["go:time", "settings.open"]);
    expect(Object.fromEntries([...items].map(([id, item]) => [id, item.enabled]))).toEqual({
      "composer.focus": false,
      "project.next": false,
      "go:time": true,
      "settings.open": true,
    });
  });

  it("hides the Factory, rather than greying it, on a hub that reports no metrics", () => {
    const items = new Map(["factory.open", "go:time"].map((id) => [id, { enabled: true, visible: true }]));
    applyMenuState({ getMenuItemById: (id) => items.get(id) ?? null }, ["go:time"]);
    expect(items.get("factory.open")).toEqual({ enabled: false, visible: false });
    expect(items.get("go:time")).toEqual({ enabled: true, visible: true });
    applyMenuState({ getMenuItemById: (id) => items.get(id) ?? null }, ["go:time", "factory.open"]);
    expect(items.get("factory.open")).toEqual({ enabled: true, visible: true });
  });

  it("takes only known menu command ids from the page", () => {
    expect(parseRequest(IPC.appMenuState, [["project.next", "go:time"]]).ok).toBe(true);
    expect(parseRequest(IPC.appMenuState, [["project.next", "rm -rf"]]).ok).toBe(false);
    expect(parseRequest(IPC.appMenuState, ["project.next"]).ok).toBe(false);
  });
});
