import { describe, expect, it, vi } from "vitest";
import type { Notice } from "./model";
import { noticeOnce, type NoticeDeps } from "./notice";

const notice = (version: string): Notice => ({ version, title: `fleetd ${version} is ready`, notes: { lines: ["Status loads faster"], more: false } });

const deps = () => {
  let seen: string | null = null;
  return {
    seen: () => seen,
    mark: vi.fn((v: string) => {
      seen = v;
    }),
    show: vi.fn((_n: Notice) => undefined),
  } satisfies NoticeDeps;
};

describe("the ready notice", () => {
  it("shows once per version, never again for it, and again for the next one", () => {
    const d = deps();
    expect(noticeOnce(notice("1.2.0"), false, d)).toBe(true);
    expect(noticeOnce(notice("1.2.0"), false, d)).toBe(false);
    expect(d.show).toHaveBeenCalledOnce();
    expect(noticeOnce(notice("1.3.0"), false, d)).toBe(true);
    expect(d.show.mock.calls.map(([n]) => n.title)).toEqual(["fleetd 1.2.0 is ready", "fleetd 1.3.0 is ready"]);
  });

  it("counts as seen while the sheet is open, which says the same", () => {
    const d = deps();
    expect(noticeOnce(notice("1.2.0"), true, d)).toBe(false);
    expect(d.mark).toHaveBeenCalledWith("1.2.0");
    expect(noticeOnce(notice("1.2.0"), false, d)).toBe(false);
    expect(d.show).not.toHaveBeenCalled();
  });

  it("shows nothing without a ready build", () => {
    const d = deps();
    expect(noticeOnce(null, false, d)).toBe(false);
    expect(d.mark).not.toHaveBeenCalled();
  });
});
