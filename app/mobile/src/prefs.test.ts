import { describe, expect, it } from "vitest";
import { MAX_PINNED, noPrefs, parsePrefs, reducePrefs, togglePin, unreadCount, type Prefs } from "./prefs";

const msg = (seq: number, author: "human" | "lead" = "lead") => ({ seq, author });

describe("reducePrefs", () => {
  it("pins in the order pinned, and no more than the most", () => {
    const keys = Array.from({ length: MAX_PINNED + 1 }, (_, i) => `k${String(i)}`);
    let pinned: readonly string[] = [];
    for (const k of keys.slice(0, MAX_PINNED)) pinned = togglePin(pinned, k, true) ?? pinned;
    expect(pinned).toEqual(keys.slice(0, MAX_PINNED));
    // The tenth doesn't take; unpinning one makes room, and the next pin goes last.
    expect(togglePin(pinned, keys[MAX_PINNED] ?? "", true)).toBeNull();
    expect(togglePin(pinned, "k1", false)).toEqual(keys.slice(0, MAX_PINNED).filter((k) => k !== "k1"));
    // Pinning one already pinned changes nothing.
    expect(togglePin(pinned, "k0", true)).toBe(pinned);
  });

  it("keeps the pins as they are now, each once and no more than the most", () => {
    const p = reducePrefs(noPrefs, { t: "pins", keys: ["b", "a", "b"] });
    expect(p.pinned).toEqual(["b", "a"]);
    // The same again is no change: nothing is written.
    expect(reducePrefs(p, { t: "pins", keys: ["b", "a"] })).toBe(p);
    expect(reducePrefs(p, { t: "pins", keys: Array.from({ length: 12 }, (_, i) => String(i)) }).pinned).toHaveLength(MAX_PINNED);
  });

  it("mutes and unmutes", () => {
    const muted = reducePrefs(noPrefs, { t: "mute", key: "a", on: true });
    expect(muted.muted).toEqual(["a"]);
    expect(reducePrefs(muted, { t: "mute", key: "a", on: false }).muted).toEqual([]);
  });

  it("reads forward only, and reading clears a mark of unread", () => {
    const marked = reducePrefs({ ...noPrefs, read: { a: 5 } }, { t: "unread", key: "a" });
    expect(marked.unread).toEqual(["a"]);
    const read = reducePrefs(marked, { t: "read", key: "a", seq: 3 });
    expect(read.read.a).toBe(5);
    expect(read.unread).toEqual([]);
    expect(reducePrefs(read, { t: "read", key: "a", seq: 3 })).toBe(read);
  });

  it("counts chats seen for the first time as read up to what they hold, and leaves known ones", () => {
    const p = reducePrefs({ ...noPrefs, read: { a: 2 } }, { t: "seen", lastSeqs: { a: 9, b: 4 } });
    expect(p.read).toEqual({ a: 2, b: 4 });
    expect(reducePrefs(p, { t: "seen", lastSeqs: { a: 9, b: 7 } })).toBe(p);
  });
});

describe("parsePrefs", () => {
  it("keeps what has the right shape and drops the rest", () => {
    expect(parsePrefs({ pinned: ["a", 3], muted: "x", read: { a: 4, b: "5" }, unread: ["c"] })).toEqual({ pinned: ["a"], muted: [], read: { a: 4 }, unread: ["c"] });
    expect(parsePrefs(null)).toEqual(noPrefs);
  });
});

describe("unreadCount", () => {
  const p: Prefs = { ...noPrefs, read: { a: 3 } };

  it("is nothing for a chat this phone hasn't seen, or one read to its end", () => {
    expect(unreadCount(noPrefs, "a", 9, [msg(9)])).toBe(0);
    expect(unreadCount(p, "a", 3, [msg(3)])).toBe(0);
  });

  it("counts the other side's messages after what was read, not yours", () => {
    expect(unreadCount(p, "a", 6, [msg(2), msg(4), msg(5, "human"), msg(6)])).toBe(1);
    expect(unreadCount(p, "a", 6, [msg(4), msg(5), msg(6)])).toBe(3);
  });

  it("counts again what comes after a chat was marked read up to its newest", () => {
    const read = reducePrefs(p, { t: "read", key: "a", seq: 6 });
    expect(unreadCount(read, "a", 6, [msg(4), msg(5), msg(6)])).toBe(0);
    expect(unreadCount(read, "a", 8, [msg(4), msg(5), msg(6), msg(7), msg(8)])).toBe(2);
  });

  it("counts messages past what the phone holds", () => {
    expect(unreadCount(p, "a", 8, [msg(4)])).toBe(5);
  });
});
