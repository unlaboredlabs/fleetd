import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, Menu, Tray } from "electron";
import { MenuBar, menuTemplate, POPOVER_WIDTH, popoverBounds, type MenuBarDeps, type MenuItems } from "./menuBar";

const AREA = { x: 0, y: 25, width: 1512, height: 920 };

describe("where the popover goes", () => {
  it("under the icon, centred on it, inside the screen", () => {
    expect(popoverBounds({ x: 1200, y: 0, width: 24, height: 24 }, 460, AREA)).toEqual({ x: 1042, y: 29, width: POPOVER_WIDTH, height: 460 });
    // An icon near the right edge: kept inside it.
    expect(popoverBounds({ x: 1490, y: 0, width: 22, height: 24 }, 460, AREA).x).toBe(1512 - POPOVER_WIDTH - 5);
  });

  it("no taller than the screen, and top right where the icon has no place", () => {
    expect(popoverBounds({ x: 1200, y: 0, width: 24, height: 24 }, 2000, AREA).height).toBe(910);
    expect(popoverBounds({ x: 0, y: 0, width: 0, height: 0 }, 400, AREA)).toEqual({ x: 1512 - POPOVER_WIDTH - 5, y: 30, width: POPOVER_WIDTH, height: 400 });
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

const fake = (joined: () => boolean) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-menubar-"));
  dirs.push(dir);
  const handlers = new Map<string, () => void>();
  const tray = { setToolTip: vi.fn(), on: vi.fn((event: string, f: () => void) => handlers.set(event, f)), getBounds: () => ({ x: 1200, y: 0, width: 24, height: 24 }), popUpContextMenu: vi.fn() };
  let visible = false;
  const winHandlers = new Map<string, () => void>();
  const win = {
    isDestroyed: () => false,
    isVisible: () => visible,
    on: vi.fn((event: string, f: () => void) => winHandlers.set(event, f)),
    setBounds: vi.fn(),
    show: vi.fn(() => {
      visible = true;
    }),
    hide: vi.fn(() => {
      visible = false;
    }),
    focus: vi.fn(),
  };
  const logins: boolean[] = [];
  const made = { tray: vi.fn(() => tray as unknown as Tray), popover: vi.fn(() => win as unknown as BrowserWindow), menu: vi.fn((_items: MenuItems) => ({ popup: vi.fn() }) as unknown as Menu), openApp: vi.fn() };
  const deps: MenuBarDeps = {
    joined: () => Promise.resolve(joined()),
    tray: made.tray,
    popover: made.popover,
    area: () => AREA,
    menu: made.menu,
    openApp: made.openApp,
    quit: vi.fn(),
    openAtLogin: () => logins.at(-1) ?? false,
    setOpenAtLogin: (on) => logins.push(on),
    marker: path.join(dir, "desktop", "menu-bar-login"),
  };
  return { deps, made, tray, win, handlers, winHandlers, logins };
};

describe("the icon", () => {
  it("comes once this Mac is joined, opens at login the first time only, and toggles the popover", async () => {
    let joined = false;
    const f = fake(() => joined);
    const bar = new MenuBar(f.deps);
    await bar.look();
    expect(bar.shown).toBe(false);
    joined = true;
    await Promise.all([bar.look(), bar.look()]);
    expect(f.made.tray).toHaveBeenCalledTimes(1);
    expect(f.logins).toEqual([true]);
    // Another start of the app: the person's choice stands.
    const again = fake(() => true);
    await new MenuBar({ ...again.deps, marker: f.deps.marker }).look();
    expect(again.logins).toEqual([]);

    f.handlers.get("click")?.();
    expect(f.win.show).toHaveBeenCalled();
    expect(f.win.setBounds).toHaveBeenLastCalledWith({ x: 1042, y: 29, width: POPOVER_WIDTH, height: 420 });
    bar.fit(388);
    expect(f.win.setBounds).toHaveBeenLastCalledWith({ x: 1042, y: 29, width: POPOVER_WIDTH, height: 388 });
    // It goes as soon as it loses focus, as a menu does: the click on the icon that blurred it doesn't open it again.
    f.winHandlers.get("blur")?.();
    expect(f.win.hide).toHaveBeenCalledTimes(1);
    f.handlers.get("click")?.();
    expect(f.win.show).toHaveBeenCalledTimes(1);
    // A click a moment later opens it; another closes it.
    bar.toggle(Date.now() + 1000);
    expect(f.win.show).toHaveBeenCalledTimes(2);
    f.handlers.get("click")?.();
    expect(f.win.hide).toHaveBeenCalledTimes(2);
    expect(f.made.popover).toHaveBeenCalledTimes(1);
  });

  it("stays open on blur when pinned (QA)", async () => {
    const f = fake(() => true);
    const bar = new MenuBar(f.deps);
    await bar.look();
    bar.show({ pinned: true });
    f.winHandlers.get("blur")?.();
    expect(f.win.hide).not.toHaveBeenCalled();
  });

  it("has the app's menu on a right-click: Open fleetd, Open at Login, Quit", async () => {
    const f = fake(() => true);
    const bar = new MenuBar(f.deps);
    await bar.look();
    f.handlers.get("right-click")?.();
    expect(f.tray.popUpContextMenu).toHaveBeenCalled();
    const items = f.made.menu.mock.calls[0]?.[0];
    if (items === undefined) throw new Error("no menu");
    const template = menuTemplate(items);
    expect(template.map((t) => t.label ?? t.type)).toEqual(["Open fleetd", "Open at Login", "separator", "Quit fleetd"]);
    expect(template[1]).toMatchObject({ type: "checkbox", checked: true });
    items.open();
    expect(f.made.openApp).toHaveBeenCalled();
    items.toggleLogin(false);
    expect(f.logins.at(-1)).toBe(false);
  });
});
