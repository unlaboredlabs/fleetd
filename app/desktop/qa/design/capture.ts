// W580 design exploration, temporary: shoots the sidebar's list in each design option (Sidebar.tsx's `fleetd.sidebarDesign`
// switch) for the proposal. `node qa/design/capture.ts <out dir> [filter…]`, a shot taken when its name holds every
// filter; not part of the QA suite.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { launch, setView, settle, show } from "../harness.ts";
import type { FixtureName, Theme } from "../registry.ts";

const [out = "", ...filters] = process.argv.slice(2);
if (out === "") throw new Error("usage: capture.ts <out dir> [filter…]");
mkdirSync(out, { recursive: true });

const project = (id: string) => `#/project/${id}`;
const STOREFRONT = project("devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22");
const CHECKOUT = project("devbox/6e8e753c-fe9a-4b79-aec3-5812d498c197");
/** Docs has a message you haven't seen. */
const UNSEEN = { "devbox/4c469516-17b7-449d-a361-4e23576ca7ba": 0 };

interface Section {
  readonly name: string;
  readonly titles: readonly string[];
  readonly collapsed?: boolean;
}
const SECTIONS: readonly Section[] = [
  { name: "Clients", titles: ["checkout", "inventory", "mobile"] },
  { name: "Later", titles: ["search", "docs"] },
];
const FOLDED: readonly Section[] = [SECTIONS[0] ?? { name: "", titles: [] }, { name: "Later", titles: ["search", "docs"], collapsed: true }];

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Sidebar" });
const chat = (page: Page, title: string) => sidebar(page).getByRole("button", { name: title }).first();
const hover = (title: string) => async (page: Page) => {
  await chat(page, title).hover();
};

interface Scene {
  readonly name: string;
  readonly fixture: string;
  readonly route: string;
  readonly sections?: readonly Section[];
  readonly act?: (page: Page) => Promise<void>;
  /** Only at the person's width, and not for today's. */
  readonly extra?: true;
  /** A menu is open beside the sidebar: this much more of the window is in the picture. */
  readonly beside?: number;
  /** Today's has it too. */
  readonly today?: boolean;
}

const scenes: readonly Scene[] = [
  // A lone pin at rest, a row open.
  { name: "pins1", fixture: "design-pins-one", route: CHECKOUT },
  // A pin open, the one beside it under the pointer.
  { name: "pins2", fixture: "design-pins-two", route: STOREFRONT, act: hover("billing") },
  // Three pins, docs with a new message; a row open and one under the pointer.
  { name: "pins3", fixture: "design-pins-three", route: CHECKOUT, act: hover("inventory") },
  { name: "sections", fixture: "design-pins-two", route: CHECKOUT, sections: SECTIONS, act: hover("search"), today: false },
  // The whole of it in one picture: a pin open, sections, a row under the pointer.
  { name: "all", fixture: "design-pins-two", route: STOREFRONT, sections: SECTIONS, act: hover("inventory"), extra: true },
  { name: "long", fixture: "design-pins-long", route: CHECKOUT, extra: true },
  { name: "hubs", fixture: "design-hubs", route: CHECKOUT, sections: SECTIONS, extra: true },
  {
    name: "folded",
    fixture: "design-pins-two",
    route: CHECKOUT,
    sections: FOLDED,
    extra: true,
    today: false,
    act: async (page) => {
      await sidebar(page).locator('[data-section="Clients"]').hover();
    },
  },
  {
    name: "menu",
    fixture: "design-pins-two",
    route: CHECKOUT,
    sections: SECTIONS,
    extra: true,
    today: false,
    beside: 300,
    act: async (page) => {
      await chat(page, "Rewrite the pricing").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Move to section" }).hover();
      await page.getByRole("menuitem", { name: "New section…" }).waitFor();
    },
  },
  {
    name: "label-menu",
    fixture: "design-pins-two",
    route: CHECKOUT,
    sections: SECTIONS,
    extra: true,
    today: false,
    beside: 120,
    act: async (page) => {
      await sidebar(page).locator('[data-section="Clients"]').click({ button: "right" });
      await page.getByRole("menuitem", { name: "Remove section" }).waitFor();
    },
  },
];

const DESIGNS = ["today", "a", "b", "c"] as const;

for (const design of DESIGNS) {
  for (const scene of scenes) {
    if (design === "today" && scene.today === false) continue;
    for (const width of scene.extra === true ? [285] : [285, 420]) {
      const name = `${design}-${String(width)}-${scene.name}`;
      if (!filters.every((f) => `${name}-`.includes(f))) continue;
      const { app, page, settled, close } = await launch(scene.fixture as FixtureName);
      try {
        await settled();
        await page.evaluate(
          (v) => {
            window.localStorage.setItem("fleetd.sidebar.width", JSON.stringify(v.width));
            window.localStorage.setItem("fleetd.seenChats", JSON.stringify(v.seen));
            if (v.design === "today") window.localStorage.removeItem("fleetd.sidebarDesign");
            else window.localStorage.setItem("fleetd.sidebarDesign", v.design);
            window.localStorage.setItem("fleetd.sidebarSections", JSON.stringify(v.design === "today" ? [] : v.sections));
          },
          { width, design, sections: scene.sections ?? [], seen: UNSEEN },
        );
        await page.reload();
        for (const theme of ["dark", "light"] as Theme[]) {
          await setView(app, page, "medium", theme);
          await show(page, "shell", scene.route);
          // A menu left open from the other theme's shot.
          await page.keyboard.press("Escape");
          await page.mouse.move(900, 500);
          await settle(page);
          const box = await sidebar(page).boundingBox();
          const last = await sidebar(page).locator('[class*="rows"] > :last-child').last().boundingBox();
          if (box === null || last === null) throw new Error("no sidebar");
          await scene.act?.(page);
          await settle(page);
          await page.screenshot({
            path: path.join(out, `${name}-${theme}.png`),
            clip: { x: 0, y: 0, width: box.x + box.width + (scene.beside ?? 0), height: Math.min(900, Math.ceil(last.y + last.height) + 20) },
          });
        }
        console.log(name);
      } finally {
        await close();
      }
    }
  }
}
