// A pushed page's or a sheet's bar on iOS 26 has no ground of its own: the grouped page runs under it and iOS's edge
// effect blurs what scrolls there. An opaque bar took the system's white ground, a white band over every small-title
// page and sheet's grey (Info, Devices, New Bot, Icon, New Screen), seen on the agents' Mac's simulator (W801). So each
// such screen keeps its scroll view clear of the bar by its automatic insets, or takes an opaque bar on its own ground.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".tsx") && !e.name.includes(".test.") ? [join(dir, e.name)] : []));
const sources = [join(ROOT, "App.tsx"), ...files(join(ROOT, "src"))].map((path) => readFileSync(path, "utf8"));
const bars = readFileSync(join(import.meta.dirname, "index.tsx"), "utf8");

/** Each `<X.Screen name=… component={C} … options=… pushed(…)|sheet(…) …>` line: its component and its options. */
const barred = sources.flatMap((src) =>
  [...src.matchAll(/<\w+\.Screen name="\w+" component=\{(\w+)\}[^\n]*?options=([^\n]*)/gu)]
    .filter((m) => /\b(pushed|sheet)\(t,/u.test(m[2]!))
    .map((m) => ({ component: m[1]!, options: m[2]! })),
);
const sourceOf = (component: string): string | undefined => sources.find((src) => new RegExp(`export function ${component}\\(`, "u").test(src));

describe("a pushed page's and a sheet's bar on iOS", () => {
  it("has no ground of its own", () => {
    for (const name of ["sheet", "pushed"]) {
      const body = new RegExp(`export const ${name} = [^]*?\\n\\}\\);`, "u").exec(bars)?.[0] ?? "";
      expect(body).toContain('Platform.OS === "ios" ? { headerTransparent: true }');
    }
  });

  it("never covers a screen: each keeps its scroll view clear by its automatic insets, or takes an opaque bar on its ground", () => {
    expect(barred.length).toBeGreaterThan(30);
    for (const { component, options } of barred) {
      const src = sourceOf(component);
      expect(src, component).toBeDefined();
      const clear = src!.includes('contentInsetAdjustmentBehavior="automatic"');
      const opaque = /headerTransparent: false, headerStyle: \{ backgroundColor: t\.grouped \}/u.test(options);
      expect(clear || opaque, component).toBe(true);
    }
    expect(barred.find((b) => b.component === "SkillEdit")?.options).toContain("headerTransparent: false");
  });
});

describe("New Screen", () => {
  const sheet = readFileSync(join(import.meta.dirname, "NewScreen.tsx"), "utf8");
  it("reads at a glance, as the desktop's: no explaining line under the kinds, the browser's row says its profile", () => {
    expect(sheet).toContain('<ListSection header="Kind">');
    expect(sheet).not.toMatch(/own browser profile|Yours from the start/u);
    expect(sheet).toContain("kindLine(k, busyProfile)");
  });
});
