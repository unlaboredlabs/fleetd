import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setupLine } from "./setupChanged";

describe("a lead's setup change in the chat", () => {
  it("is a line only for a message that is one", () => {
    expect(setupLine(undefined)).toBeUndefined();
    expect(setupLine({ text: "Remembered: deploys freeze on Fridays." })).toBeUndefined();
    expect(setupLine({ text: "Added the repo api", setupChanged: { kind: "repo_added", names: ["api"] } })).toEqual({ text: "Added the repo api", undone: false, label: "Added the repo api" });
  });

  it("says a change a person took back is undone", () => {
    expect(setupLine({ text: "Archived the project", setupChanged: { kind: "archived", undone: true } })).toEqual({ text: "Archived the project", undone: true, label: "Archived the project. Undone" });
  });

  it("shows a change of a kind a newer hub makes, as its text", () => {
    expect(setupLine({ text: "Changed the project's `schedule`", setupChanged: { kind: "schedule" } })?.text).toBe("Changed the project's schedule");
  });
});

describe("the chat's rows", () => {
  const chat = readFileSync(new URL("./Chat.tsx", import.meta.url), "utf8");
  const line = readFileSync(new URL("./SetupChangedLine.tsx", import.meta.url), "utf8");

  it("draw a setup change as its line, which opens the project's Info, ahead of a plain system line", () => {
    const at = chat.indexOf("<SetupChangedLine ");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(chat.indexOf('if (side === "center") return <Event text={item.text} />;'));
    expect(chat).toMatch(/<SetupChangedLine [^>]*onOpen=\{actions\.openInfo\}/u);
  });

  it("Undo asks the hub to put back what was there, for this project and line", () => {
    expect(line).toMatch(/session\.call\("project_setup_undo", \{ projectRef: refOf\(chatKey\), messageId \}\)/u);
  });
});
