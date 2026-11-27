// Tests' way into a Settings row's "…" (parts.tsx RowMenu): open the menu named `<row>: more` and pick an item.
import { act } from "react";

/** The labels of the open menu's items. */
export const menuItems = () => [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].map((i) => i.textContent.trim());

/** Opens the row's "…" menu, as a mouse press does, and leaves it open. */
export function openRowMenu(row: string) {
  const trigger = document.querySelector<HTMLElement>(`button[aria-label='${row}: more']`);
  if (trigger === null) throw new Error(`no menu ${row}`);
  act(() => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  });
}

/** Opens the row's "…" menu and picks `item`, then lets what it started settle. */
export async function chooseFromRow(row: string, item: string) {
  openRowMenu(row);
  const found = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent.trim() === item);
  if (found === undefined) throw new Error(`no ${item} in ${row}'s menu: ${menuItems().join(", ")}`);
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
}

/** Opens a plus's menu (parts.tsx AddMenu), named `label`, and picks `item`. */
export async function chooseFromAdd(label: string, item: string) {
  const trigger = document.querySelector<HTMLElement>(`button[aria-label='${label}']`);
  if (trigger === null) throw new Error(`no plus ${label}`);
  act(() => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  });
  const found = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent.trim() === item);
  if (found === undefined) throw new Error(`no ${item} in ${label}'s menu: ${menuItems().join(", ")}`);
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
}
