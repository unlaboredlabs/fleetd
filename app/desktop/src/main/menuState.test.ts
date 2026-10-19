import { describe, expect, it } from "vitest";
import { IPC } from "../shared/channels";
import { parseRequest } from "../shared/ipc";
import { applyMenuState } from "./menuState";

describe("menu state", () => {
  it("greys out the commands the screen doesn't offer (Stop Order on the board)", () => {
    const items = new Map(["order.stop", "order.next", "board.open", "settings.open"].map((id) => [id, { enabled: true }]));
    applyMenuState({ getMenuItemById: (id) => items.get(id) ?? null }, ["board.open", "settings.open"]);
    expect(Object.fromEntries([...items].map(([id, item]) => [id, item.enabled]))).toEqual({
      "order.stop": false,
      "order.next": false,
      "board.open": true,
      "settings.open": true,
    });
  });

  it("takes only known menu command ids from the page", () => {
    expect(parseRequest(IPC.appMenuState, [["order.stop", "inbox.toggle"]]).ok).toBe(true);
    expect(parseRequest(IPC.appMenuState, [["order.stop", "rm -rf"]]).ok).toBe(false);
    expect(parseRequest(IPC.appMenuState, ["order.stop"]).ok).toBe(false);
  });
});
