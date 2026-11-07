// The drafts on a fake disk: typing in one chat leaves every other chat's draft as it was (its composer doesn't draw
// again), and the file is written once the typing stops, not with each letter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writes: string[] = [];
vi.mock("expo-file-system", () => ({
  Paths: { document: "/documents" },
  File: class {
    exists = false;
    textSync = () => "{}";
    write = async (text: string) => void writes.push(text);
  },
}));

const { changeDraft, draftOf } = await import("./draftsStore");

beforeEach(() => {
  vi.useFakeTimers();
  writes.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("the drafts store", () => {
  it("changes only the chat typed in", () => {
    changeDraft("m1/b", (d) => ({ ...d, text: "elsewhere" }));
    const other = draftOf("m1/b");
    changeDraft("m1/a", (d) => ({ ...d, text: "h" }));
    changeDraft("m1/a", (d) => ({ ...d, text: "hi" }));
    expect(draftOf("m1/a").text).toBe("hi");
    expect(draftOf("m1/b")).toBe(other);
  });

  it("writes the file once the typing stops", () => {
    for (const text of ["d", "de", "dep", "depl", "deploy"]) changeDraft("m1/c", (d) => ({ ...d, text }));
    vi.advanceTimersByTime(399);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(writes).toHaveLength(1);
    expect((JSON.parse(writes[0]!) as Record<string, { text: string }>)["m1/c"]?.text).toBe("deploy");
  });
});
