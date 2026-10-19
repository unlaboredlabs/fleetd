import { MENU_COMMANDS, type MenuCommand } from "../shared/menu";

/** The part of an Electron Menu this needs. */
export interface MenuLike {
  getMenuItemById(id: string): { enabled: boolean } | null;
}

/** Greys out every menu command the renderer didn't report as enabled. */
export const applyMenuState = (menu: MenuLike | null, enabled: ReadonlyArray<MenuCommand>): void => {
  if (menu === null) return;
  const on = new Set<string>(enabled);
  for (const id of MENU_COMMANDS) {
    const item = menu.getMenuItemById(id);
    if (item !== null) item.enabled = on.has(id);
  }
};
