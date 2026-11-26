// What a screen's browser downloads, as its Chrome tells of it: each one that completed, under a name unique in the
// list, copied into the session's own folder when the agent's agent-browser saved it elsewhere; and gone a day after.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Downloads, DOWNLOADS_KEPT_MS, downloadPath, downloadsDir, sweepDownloads } from "../src/node/browser/downloads.ts";
import { tempHome } from "./helpers.ts";

const homes: { done: () => void }[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.done();
});
const home = () => {
  const h = tempHome();
  homes.push(h);
  return h.dir;
};
const AT = new Date("2026-11-26T12:00:00.000Z");

test("lists each download that completed, by the name Chrome saved it under, unique in the list", () => {
  const dir = downloadsDir(home(), "B1");
  mkdirSync(dir, { recursive: true });
  const d = new Downloads(dir, () => AT);
  d.began({ guid: "g1", suggestedFilename: "dummy.pdf", url: "https://example.org/dummy.pdf" });
  expect(d.progress({ guid: "g1", state: "inProgress", receivedBytes: 3, totalBytes: 9 })).toBe(false);
  writeFileSync(join(dir, "dummy.pdf"), "%PDF-1.7");
  expect(d.progress({ guid: "g1", state: "completed", receivedBytes: 8, totalBytes: 8, filePath: join(dir, "dummy.pdf") })).toBe(true);
  // A second file of the same name, which Chrome wrote over the first: listed apart, under a name of its own.
  d.began({ guid: "g2", suggestedFilename: "dummy.pdf" });
  writeFileSync(join(dir, "dummy.pdf"), "%PDF-1.7 again");
  expect(d.progress({ guid: "g2", state: "completed" })).toBe(true);
  // A canceled one, and one Chrome never announced, list nothing.
  d.began({ guid: "g3", suggestedFilename: "big.zip" });
  expect(d.progress({ guid: "g3", state: "canceled" })).toBe(false);
  expect(d.progress({ guid: "g4", state: "completed" })).toBe(false);
  expect(d.list()).toEqual([
    { name: "dummy.pdf", bytes: 8, at: AT.toISOString() },
    { name: "dummy (2).pdf", bytes: 14, at: AT.toISOString() },
  ]);
  expect(readFileSync(join(dir, "dummy (2).pdf"), "utf8")).toBe("%PDF-1.7 again");
});

test("a download the agent's agent-browser saved elsewhere is copied into the session's folder", () => {
  const h = home();
  const dir = downloadsDir(h, "B1");
  const elsewhere = join(h, "work");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, "report.csv"), "a,b\n1,2\n");
  const d = new Downloads(dir, () => AT);
  d.began({ guid: "g1", suggestedFilename: "report.csv" });
  expect(d.progress({ guid: "g1", state: "completed", filePath: join(elsewhere, "report.csv") })).toBe(true);
  expect(readFileSync(join(dir, "report.csv"), "utf8")).toBe("a,b\n1,2\n");
  expect(d.list()).toEqual([{ name: "report.csv", bytes: 8, at: AT.toISOString() }]);
});

test("a download's path is only a plain name in its session's own folder", () => {
  const h = home();
  expect(downloadPath(h, "B1", "dummy.pdf")).toBe(join(downloadsDir(h, "B1"), "dummy.pdf"));
  for (const [id, name] of [["B1", "../x.pdf"], ["B1", ".."], ["B1", ""], ["../B1", "x.pdf"], ["B1/..", "x.pdf"]] as const) {
    expect(downloadPath(h, id, name)).toBeUndefined();
  }
});

test("an ended screen's downloads go a day after their last file; a live one's stay", () => {
  const h = home();
  const now = Date.now();
  for (const id of ["Bold", "Blive", "Bnew"]) mkdirSync(downloadsDir(h, id), { recursive: true });
  const old = (now - DOWNLOADS_KEPT_MS - 1_000) / 1000;
  utimesSync(downloadsDir(h, "Bold"), old, old);
  utimesSync(downloadsDir(h, "Blive"), old, old);
  sweepDownloads(h, ["Blive"], now);
  expect([existsSync(downloadsDir(h, "Bold")), existsSync(downloadsDir(h, "Blive")), existsSync(downloadsDir(h, "Bnew"))]).toEqual([false, true, true]);
});
