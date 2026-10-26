import { describe, expect, it } from "vitest";
import type { TodoItem } from "../../../shared/contracts";
import { groupItems, openItems, prOf, progressOf } from "./model";

const AT = "2026-10-25T10:00:00.000Z";
const item = (id: number, state: TodoItem["state"], text = `Item ${String(id)}`): TodoItem => ({ id, text, state, updatedAt: AT });

describe("the checklist tab's model", () => {
  const items = [item(1, "done"), item(2, "todo"), item(3, "doing"), item(4, "todo"), item(5, "done")];

  it("groups doing, to do and done, each in the lead's order", () => {
    expect(groupItems(items).map((g) => [g.title, g.items.map((i) => i.id)])).toEqual([
      ["Doing", [3]],
      ["To do", [2, 4]],
      ["Done", [1, 5]],
    ]);
  });

  it("counts how far along it is, and what is still open for the badge", () => {
    expect(progressOf(items)).toEqual({ done: 2, doing: 1, total: 5 });
    expect(openItems(items)).toBe(3);
    expect(openItems([item(1, "done")])).toBe(0);
    expect(openItems(undefined)).toBe(0);
  });

  it("opens a GitHub PR link in the panel by its repo and number", () => {
    expect(prOf("https://github.com/acme/storefront/pull/11")).toEqual({ repo: "acme/storefront", number: 11 });
    expect(prOf("https://github.com/acme/storefront/pull/11/files")).toEqual({ repo: "acme/storefront", number: 11 });
    expect(prOf("https://example.com/acme/storefront/pull/11")).toBeNull();
    expect(prOf("https://github.com/acme/storefront/pull/0")).toBeNull();
  });
});
