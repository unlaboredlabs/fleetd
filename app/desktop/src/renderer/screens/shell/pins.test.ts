// The sidebar's order: your pins on top in their order, then every other chat by its newest line, newest first; while
// the pointer is over the list (`held`), the unpinned rows stay where they were. The chats in one of your sections come
// after those in none, each section's together in your order. And each change to your pins, made to the hub's own list.
import { describe, expect, it } from "vitest";
import { arranged, inOrder, pinnedAt, unpinned } from "./pins";

const row = (key: string, at: string, title = key) => ({ key, at: `2026-11-08T${at}:00.000Z`, project: { title } });
const keys = (r: ReadonlyArray<{ key: string }>) => r.map((x) => x.key);

const ROWS = [row("m/api", "09:00"), row("m/docs", "11:00"), row("m/web", "10:00"), row("m/new", "08:00")];

describe("the sidebar's order", () => {
  it("puts the newest first, then by title when two are as new", () => {
    expect(keys(arranged(ROWS, undefined))).toEqual(["m/docs", "m/web", "m/api", "m/new"]);
    expect(keys(arranged([row("m/b", "09:00", "beta"), row("m/a", "09:00", "Alpha")], []))).toEqual(["m/a", "m/b"]);
  });

  it("puts your pins on top in your order, whatever moves, and skips one that is gone", () => {
    expect(keys(arranged(ROWS, ["m/new", "m/gone", "m/api"]))).toEqual(["m/new", "m/api", "m/docs", "m/web"]);
  });

  it("holds the unpinned rows where they were while held, a new one after them, the pins still live", () => {
    const later = [row("m/api", "12:00"), row("m/docs", "11:00"), row("m/web", "10:00"), row("m/new", "08:00"), row("m/fresh", "13:00")];
    expect(keys(arranged(later, ["m/new"], ["m/docs", "m/web", "m/api"]))).toEqual(["m/new", "m/docs", "m/web", "m/api", "m/fresh"]);
    // Let go, they take their places.
    expect(keys(arranged(later, ["m/new"]))).toEqual(["m/new", "m/fresh", "m/api", "m/docs", "m/web"]);
  });

  it("puts the chats in none of your sections first, then each section's together, newest first in each", () => {
    const inSection = (key: string, at: string, section?: string) => ({ ...row(key, at), section });
    const rows = [inSection("m/api", "09:00", "work"), inSection("m/docs", "11:00"), inSection("m/web", "10:00", "home"), inSection("m/new", "12:00", "work"), inSection("m/old", "07:00")];
    expect(keys(arranged(rows, [], undefined, ["work", "home"]))).toEqual(["m/docs", "m/old", "m/new", "m/api", "m/web"]);
    expect(keys(arranged(rows, [], undefined, ["home", "work"]))).toEqual(["m/docs", "m/old", "m/web", "m/new", "m/api"]);
    // A pinned chat is among the pins only; held, a section's rows keep their places among their own.
    expect(keys(arranged(rows, ["m/new"], undefined, ["work", "home"]))).toEqual(["m/new", "m/docs", "m/old", "m/api", "m/web"]);
    expect(keys(arranged(rows, [], ["m/old", "m/docs", "m/api", "m/new", "m/web"], ["work", "home"]))).toEqual(["m/old", "m/docs", "m/api", "m/new", "m/web"]);
  });
});

describe("a change to your pins", () => {
  const hubs = ["m/api", "m/docs", "m/web"];

  it("pins a chat before the pin it was let go on, last when that one is no longer pinned or none is named", () => {
    expect(pinnedAt(hubs, "m/new", "m/docs")).toEqual(["m/api", "m/new", "m/docs", "m/web"]);
    expect(pinnedAt(hubs, "m/new", "m/gone")).toEqual(["m/api", "m/docs", "m/web", "m/new"]);
    expect(pinnedAt(hubs, "m/new")).toEqual(["m/api", "m/docs", "m/web", "m/new"]);
  });

  it("unpins a chat, the others as they were", () => {
    expect(unpinned(hubs, "m/docs")).toEqual(["m/api", "m/web"]);
  });

  it("puts the pins in the order dragged, one pinned on another device since after them", () => {
    expect(inOrder(hubs, ["m/web", "m/api", "m/docs"])).toEqual(["m/web", "m/api", "m/docs"]);
    // docs was pinned on the phone, and isn't among the ones dragged here.
    expect(inOrder(hubs, ["m/web", "m/api"])).toEqual(["m/web", "m/api", "m/docs"]);
  });

  it("is the same list when nothing would change, so nothing is sent", () => {
    expect(pinnedAt(hubs, "m/docs", "m/api")).toBe(hubs);
    expect(unpinned(hubs, "m/new")).toBe(hubs);
    expect(inOrder(hubs, ["m/api", "m/docs", "m/web"])).toBe(hubs);
  });
});
