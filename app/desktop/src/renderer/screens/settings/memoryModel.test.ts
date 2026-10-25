import { describe, expect, it } from "vitest";
import type { MemoryFile } from "../../../shared/contracts";
import { parseHash } from "../shell/routes";
import { capState, charCount, entryText, fileName, lineMatches, LineGone, memoryLines, noteHref, projectCapState, restoreLine, withLine } from "./memoryModel";
import { parseRoute } from "./route";
import { searchSettings } from "./search";

const file = (over: Partial<MemoryFile>): MemoryFile => ({ scope: "project", text: "", chars: 0, cap: 4000, notes: [], ...over });

describe("Settings → Memory", () => {
  it("names the files as the hub does", () => {
    expect(fileName({ scope: "user" })).toBe("user.md");
    expect(fileName({ scope: "project" })).toBe("MEMORY.md");
    expect(fileName({ scope: "project", topic: "deploys" })).toBe("deploys.md");
  });

  it("counts characters as the hub's cap does, and stops a save past it", () => {
    // An emoji is two UTF-16 units but one character to the hub.
    expect(charCount("no 🚀")).toBe(4);
    expect(capState("- concise\n", 4000)).toEqual({ chars: 10, cap: 4000, line: "10 of 4,000 characters", over: false });
    expect(capState("x".repeat(4001), 4000).over).toBe(true);
  });

  it("checks the whole project against its cap with the draft in place of its file", () => {
    const files = [file({ chars: 3000 }), file({ topic: "deploys", chars: 8000, cap: 8000 }), file({ topic: "ci", chars: 8000, cap: 8000 })];
    expect(projectCapState(files, null, 32000)).toEqual({ chars: 19000, cap: 32000, line: "19,000 of 32,000 characters across this project", over: false });
    expect(projectCapState(files, { name: "MEMORY.md", text: "x".repeat(16001) }, 32000).over).toBe(true);
    expect(projectCapState(files, { name: "deploys.md", text: "" }, 32000).line).toBe("11,000 of 32,000 characters across this project");
  });

  it("links each remembered entry to its chat line", () => {
    const href = noteHref({ text: "No npm.", at: "2026-10-25T10:00:00.000Z", messageId: "m12", projectRef: { machineId: "devbox", projectId: "fleetd" } });
    expect(parseHash(href)).toMatchObject({ id: "project", project: { machineId: "devbox", projectId: "fleetd" }, message: "m12" });
  });

  const ref = { machineId: "devbox", projectId: "fleetd" };
  const note = (text: string, messageId: string) => ({ text, at: "2026-10-25T10:00:00.000Z", messageId, projectRef: ref });

  it("lists a file's lines as entries, each with its note only when the lead wrote it as it reads now", () => {
    const text = "# Style\n- Concise.\n\n* No npm: use pnpm.\n- Staging first,\n  always.\n";
    const lines = memoryLines(file({ scope: "user", text, notes: [note("Concise.", "m2"), note("Staging first, always.", "m1")] }));
    expect(lines.map((l) => [l.at, l.kind, l.text, l.note?.messageId])).toEqual([
      [0, "heading", "Style", undefined],
      [1, "entry", "Concise.", "m2"],
      [3, "entry", "No npm: use pnpm.", undefined],
      // Edited since the lead wrote it (here, split in two): no note, rather than a guess.
      [4, "entry", "Staging first,", undefined],
      [5, "entry", "always.", undefined],
    ]);
    // A line remembered twice gets its newest note.
    expect(memoryLines(file({ text: "- Concise.\n", notes: [note("Concise.", "m9"), note("Concise.", "m2")] }))[0]?.note?.messageId).toBe("m9");
  });

  it("leaves MEMORY.md's topic lines out, since each topic is listed as its own file", () => {
    const text = "- No npm here.\n- [deploys](deploys.md)\n";
    expect(memoryLines(file({ text })).map((l) => l.text)).toEqual(["No npm here."]);
    expect(memoryLines(file({ topic: "links", text })).map((l) => l.text)).toEqual(["No npm here.", "[deploys](deploys.md)"]);
  });

  it("finds entries by every word searched, in any case", () => {
    expect(lineMatches({ text: "Releases go out Tuesdays." }, "tuesday RELEASE")).toBe(true);
    expect(lineMatches({ text: "Releases go out Tuesdays." }, "friday")).toBe(false);
    expect(lineMatches({ text: "anything" }, "  ")).toBe(true);
  });

  it("edits one entry in place, keeping its bullet and the rest of the file as it was", () => {
    const text = "# Style\n- Concise.\n  * Nested one.\n- [deploys](deploys.md)\n";
    const [, concise, nested] = memoryLines(file({ text }));
    if (!concise || !nested) throw new Error("no lines");
    expect(withLine(text, "MEMORY.md", concise, "  Concise; state first.\n")).toBe("# Style\n- Concise; state first.\n  * Nested one.\n- [deploys](deploys.md)\n");
    expect(withLine(text, "MEMORY.md", nested, "Still nested.")).toBe("# Style\n- Concise.\n  * Still nested.\n- [deploys](deploys.md)\n");
    // Typed with line breaks, it stays one line.
    expect(entryText("one\n two \n")).toBe("one two");
  });

  it("finds the entry where it moved, and refuses one that is gone rather than change another", () => {
    const line = { at: 0, raw: "- Concise." };
    // The lead added a line above it since the page read the file.
    expect(withLine("- New.\n- Concise.\n", "user.md", line, "Short.")).toBe("- New.\n- Short.\n");
    expect(() => withLine("- Something else.\n", "user.md", line, "Short.")).toThrow(LineGone);
    expect(() => withLine("- Something else.\n", "user.md", line, null)).toThrow("user.md changed since this was shown");
  });

  it("deletes an entry, and undo puts it back where it was", () => {
    const text = "- One.\n- Two.\n- Three.\n";
    const two = { at: 1, raw: "- Two." };
    const deleted = withLine(text, "user.md", two, null);
    expect(deleted).toBe("- One.\n- Three.\n");
    expect(restoreLine(deleted, two)).toBe(text);
    // Already back (another window undid it too): nothing changes.
    expect(restoreLine(text, two)).toBe(text);
  });

  it("undoes into the file as it is now, and brings back a file its last entry emptied", () => {
    const only = { at: 0, raw: "- Staging first." };
    // The hub deletes an emptied file; undo writes it again.
    expect(withLine("- Staging first.\n", "deploys.md", only, null)).toBe("");
    expect(restoreLine("", only)).toBe("- Staging first.\n");
    // The lead remembered something after the delete: both stay.
    expect(restoreLine("- One.\n- Three.\n- Four.\n", { at: 1, raw: "- Two." })).toBe("- One.\n- Two.\n- Three.\n- Four.\n");
    // The file got shorter: the entry goes at the end.
    expect(restoreLine("- One.\n", { at: 5, raw: "- Six." })).toBe("- One.\n- Six.\n");
  });

  it("is a Settings page that search finds by what people call it", () => {
    expect(parseRoute("#/settings/memory?for=devbox/fleetd")).toMatchObject({ tab: "memory", for: "devbox/fleetd" });
    expect(searchSettings("remember").map((o) => o.label)).toEqual(["Memory"]);
  });
});
