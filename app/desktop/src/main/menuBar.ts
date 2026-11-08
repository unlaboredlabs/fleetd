// The agents' Mac's menu bar (shared/macMenuBar.ts): once this Mac is joined as the hub's agents' Mac (node.json, as
// Set up this Mac for agents reads it: macSetup.ts joinedHere), the app keeps an icon in the menu bar for as long as it
// runs. A click opens the popover under it, the page's `#/menubar` in a small frameless window of its own that goes as
// soon as it loses focus, as a menu does; a right-click (or the popover's More) has the app's menu: Open fleetd, Open
// at Login, Quit. The first time the icon shows, the app is set to open at login, so the Mac's menu bar keeps it.
import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow, Menu, Rectangle, Tray } from "electron";

/** The popover's width; its height follows what it shows (`fit`), up to the screen's. */
export const POPOVER_WIDTH = 340;
/** Its height until the page says. */
const FIRST_HEIGHT = 420;
/** The gap between the menu bar and the popover, as macOS leaves under a status item's menu. */
const GAP = 5;
/** A click on the icon this soon after the popover hid on losing focus is the click that blurred it. */
const BLUR_CLICK_MS = 300;
/** How often a Mac not joined yet is looked at again: set up by the CLI while the app runs, the icon comes. */
export const LOOK_EVERY_MS = 30_000;

/** Where the popover goes: under the icon, centred on it, kept inside the screen; top right where the icon has no place (Linux). */
export const popoverBounds = (icon: Rectangle, height: number, area: Rectangle): Rectangle => {
  // A screen with no room to speak of (no display at all, as headless) doesn't cap it.
  const tall = area.height > 200 ? Math.min(Math.round(height), area.height - 2 * GAP) : Math.round(height);
  const placed = icon.width > 0 && icon.height > 0;
  const x = placed ? Math.round(icon.x + icon.width / 2 - POPOVER_WIDTH / 2) : area.x + area.width - POPOVER_WIDTH - GAP;
  const y = placed ? icon.y + icon.height + GAP : area.y + GAP;
  return { x: Math.max(area.x + GAP, Math.min(x, area.x + area.width - POPOVER_WIDTH - GAP)), y, width: POPOVER_WIDTH, height: tall };
};

export interface MenuBarDeps {
  /** This Mac is joined as the agents' Mac. */
  joined(): Promise<boolean>;
  tray(): Tray;
  popover(): BrowserWindow;
  /** The screen's work area around a point. */
  area(at: { x: number; y: number }): Rectangle;
  menu(items: MenuItems): Menu;
  openApp(): void;
  quit(): void;
  openAtLogin(): boolean;
  setOpenAtLogin(on: boolean): void;
  /** The file whose being there says the app set itself to open at login once already. */
  readonly marker: string;
}

export interface MenuItems {
  readonly openAtLogin: boolean;
  readonly open: () => void;
  readonly toggleLogin: (on: boolean) => void;
  readonly quit: () => void;
}

export class MenuBar {
  readonly #deps: MenuBarDeps;
  #tray: Tray | undefined;
  #popover: BrowserWindow | undefined;
  #height = FIRST_HEIGHT;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** A look is on its way: another waits for it rather than making a second icon. */
  #looking = false;
  #pinned = false;
  #blurredAt = 0;

  constructor(deps: MenuBarDeps) {
    this.#deps = deps;
  }

  /** Looks now and every LOOK_EVERY_MS until this Mac is joined, then keeps the icon. */
  start(): void {
    void this.look();
    this.#timer = setInterval(() => void this.look(), LOOK_EVERY_MS);
  }

  /** Puts the icon in the menu bar once this Mac is joined (a join that just finished calls it too). */
  async look(): Promise<void> {
    if (this.#tray !== undefined || this.#looking) return;
    this.#looking = true;
    const joined = await this.#deps.joined().finally(() => {
      this.#looking = false;
    });
    if (!joined) return;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    const tray = this.#deps.tray();
    tray.setToolTip("fleetd: the agents' Mac");
    tray.on("click", () => this.toggle());
    tray.on("right-click", () => this.showMenu());
    this.#tray = tray;
    if (!fs.existsSync(this.#deps.marker)) {
      this.#deps.setOpenAtLogin(true);
      fs.mkdirSync(path.dirname(this.#deps.marker), { recursive: true });
      fs.writeFileSync(this.#deps.marker, "");
    }
  }

  get shown(): boolean {
    return this.#tray !== undefined;
  }

  toggle(now = Date.now()): void {
    const open = this.#popover;
    if (open !== undefined && !open.isDestroyed() && open.isVisible()) {
      open.hide();
      return;
    }
    // A click on the icon while the popover shows blurs it first, which hides it: that click closes it, as a menu's does.
    if (now - this.#blurredAt < BLUR_CLICK_MS) return;
    this.show();
  }

  /** Opens the popover under the icon. `pinned`: it stays when it loses focus (QA, which has no menu bar to click). */
  show({ pinned = false }: { pinned?: boolean } = {}): void {
    this.#pinned = pinned;
    let win = this.#popover;
    if (win === undefined || win.isDestroyed()) {
      win = this.#deps.popover();
      win.on("blur", () => {
        if (this.#pinned) return;
        this.#blurredAt = Date.now();
        win?.hide();
      });
      this.#popover = win;
    }
    win.setBounds(this.#bounds());
    win.show();
    win.focus();
  }

  /** The page's height, as it lays out what it shows: the popover takes it, keeping its top. */
  fit(height: number): void {
    this.#height = height;
    const win = this.#popover;
    if (win !== undefined && !win.isDestroyed()) win.setBounds(this.#bounds());
  }

  hide(): void {
    const win = this.#popover;
    if (win !== undefined && !win.isDestroyed()) win.hide();
  }

  /** The app's menu, at the icon: from a right-click, or the popover's More. */
  showMenu(): void {
    const menu = this.#deps.menu({
      openAtLogin: this.#deps.openAtLogin(),
      open: () => {
        this.hide();
        this.#deps.openApp();
      },
      toggleLogin: (on) => this.#deps.setOpenAtLogin(on),
      quit: () => this.#deps.quit(),
    });
    if (this.#tray === undefined) menu.popup();
    else this.#tray.popUpContextMenu(menu);
  }

  #bounds(): Rectangle {
    const icon = this.#tray?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
    return popoverBounds(icon, this.#height, this.#deps.area({ x: icon.x, y: icon.y }));
  }
}

/** The menu the icon's right-click opens. */
export const menuTemplate = (items: MenuItems): Electron.MenuItemConstructorOptions[] => [
  { label: "Open fleetd", click: items.open },
  { label: "Open at Login", type: "checkbox", checked: items.openAtLogin, click: (item) => items.toggleLogin(item.checked) },
  { type: "separator" },
  { label: "Quit fleetd", accelerator: "CommandOrControl+Q", click: items.quit },
];
