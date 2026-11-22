// A pushed page's or a sheet's bar stands on the page's own ground, on iOS too. Left to iOS, an opaque bar took the
// system's white: a white band over every small-title page and sheet's grey (Info, Devices, New Bot, Icon, New
// Screen), seen on the agents' Mac's simulator (W801). A bar with no ground instead would lay each page out under it,
// where a page's spinner, error or web view, in no scroll view kept clear of it, would hide.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".tsx") && !e.name.includes(".test.") ? [join(dir, e.name)] : []));
const sources = [join(ROOT, "App.tsx"), ...files(join(ROOT, "src"))].map((path) => readFileSync(path, "utf8"));
const bars = readFileSync(join(import.meta.dirname, "index.tsx"), "utf8");

/** Each `<X.Screen … options=… pushed(…)|sheet(…) …>` line's options. */
const barred = sources.flatMap((src) => [...src.matchAll(/<\w+\.Screen name="\w+"[^\n]*?options=([^\n]*)/gu)].map((m) => m[1]!).filter((o) => /\b(pushed|sheet)\(t,/u.test(o)));

describe("a pushed page's and a sheet's bar", () => {
  it("stands on the page's own ground on every platform, its large title's too", () => {
    for (const name of ["sheet", "pushed"]) {
      const body = new RegExp(`export const ${name} = [^]*?\\n\\}\\);`, "u").exec(bars)?.[0] ?? "";
      expect(body).toContain("headerStyle: { backgroundColor: t.grouped },");
      expect(body).toContain("headerLargeStyle: { backgroundColor: t.grouped },");
      expect(body).not.toMatch(/Platform\.OS|headerTransparent/u);
    }
  });

  it("never lays a page out under it", () => {
    expect(barred.length).toBeGreaterThan(30);
    for (const options of barred) expect(options).not.toContain("headerTransparent: true");
  });
});

describe("a page pushed with a large title of its own", () => {
  // iOS 26 draws a large title invisible over a bar with a ground of its own: Connections, Machines, Memory, Billing
  // and the Vault showed a blank gap where their title stood (W822), while the Settings page, its bar with none, showed its.
  const app = sources[0]!;
  it("has the Settings page's bar on iOS, with no ground of a pushed page's", () => {
    expect(app).toContain('...(Platform.OS === "ios" ? { headerStyle: {}, headerLargeStyle: {}, ...stripBars } : {}),');
    const large = [...app.matchAll(/<SettingsStack\.Screen name="(\w+)"[^\n]*options=\{large\("\1"\)\}/gu)].map((m) => m[1]);
    expect(large).toEqual(["Memory", "Connections", "Machines", "Billing", "Providers", "Vault"]);
    expect(sources.join("\n")).not.toMatch(/(pushed|sheet)\(t, [^)]*\), headerLargeTitleEnabled: true/u);
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
