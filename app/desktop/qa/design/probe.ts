// W580 design exploration, temporary: prints each option's measured sizes (the proposal quotes them).
// `node qa/design/probe.ts`; not part of the QA suite.
import { launch, setView, settle, show } from "../harness.ts";
import type { FixtureName } from "../registry.ts";

const SECTIONS = [
  { name: "Clients", titles: ["checkout", "inventory", "mobile"] },
  { name: "Later", titles: ["search", "docs"] },
];

for (const design of ["today", "a", "b", "c"]) {
  const { app, page, settled, close } = await launch("design-pins-two" as FixtureName);
  try {
    await settled();
    await page.evaluate(
      (v) => {
        window.localStorage.setItem("fleetd.sidebar.width", "285");
        if (v.design === "today") window.localStorage.removeItem("fleetd.sidebarDesign");
        else window.localStorage.setItem("fleetd.sidebarDesign", v.design);
        window.localStorage.setItem("fleetd.sidebarSections", JSON.stringify(v.design === "today" ? [] : v.sections));
      },
      { design, sections: SECTIONS },
    );
    await page.reload();
    await setView(app, page, "medium", "dark");
    await show(page, "shell", "#/project/devbox/6e8e753c-fe9a-4b79-aec3-5812d498c197");
    await settle(page);
    const sizes = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Sidebar"]');
      if (nav === null) return {};
      const all = (part: string) => [...nav.querySelectorAll<HTMLElement>(`[class*="_${part}_"]`)];
      const box = (el: Element | undefined) => el?.getBoundingClientRect();
      const type = (el: Element | undefined) => {
        if (el === undefined) return "";
        const c = getComputedStyle(el);
        return `${c.fontSize}/${c.lineHeight} ${c.fontWeight}`;
      };
      const r = (n: number | undefined) => (n === undefined ? -1 : Math.round(n * 10) / 10);
      const [cells, pics, rows, avatars, heads] = [all("pinCell"), all("pinPic"), all("row"), all("avatar"), all("sectionHead")];
      const pic = (i: number) => box(pics[i]?.firstElementChild ?? pics[i]);
      return {
        place: `${String(r(box(cells[0])?.width))}x${String(r(box(cells[0])?.height))}`,
        picture: r(pic(0)?.width),
        betweenPictures: r((pic(1)?.left ?? 0) - (pic(0)?.right ?? 0)),
        betweenPlaces: r((box(cells[1])?.left ?? 0) - (box(cells[0])?.right ?? 0)),
        pictureToName: r((box(all("pinName")[0])?.top ?? 0) - (pic(0)?.bottom ?? 0)),
        pinName: type(all("pinTitle")[0]),
        pinsToList: r((box(rows[0])?.top ?? 0) - (box(cells[0])?.bottom ?? 0)),
        row: r(box(rows[0])?.height),
        rowPitch: r((box(rows[2])?.top ?? 0) - (box(rows[1])?.top ?? 0)),
        avatar: r(box(avatars[0]?.firstElementChild ?? undefined)?.width),
        name: type(all("name")[0]),
        line: type(all("line")[0]),
        label: type(heads[0]),
        labelHeight: r(box(heads[0])?.height),
        aboveLabel: r((box(heads[0])?.top ?? 0) - (box(rows[0])?.bottom ?? 0)),
        belowLabel: r((box(rows[1])?.top ?? 0) - (box(heads[0])?.bottom ?? 0)),
      };
    });
    console.log(design, JSON.stringify(sizes));
  } finally {
    await close();
  }
}
