import { describe, expect, it } from "vitest";
import type { MemoryFile } from "../../../shared/contracts";
import { parseHash } from "../shell/routes";
import { capState, charCount, fileName, noteHref, projectCapState } from "./memoryModel";
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
    expect(capState("- concise\n", 4000)).toEqual({ line: "10 of 4,000 characters", over: false });
    expect(capState("x".repeat(4001), 4000).over).toBe(true);
  });

  it("checks the whole project against its cap with the draft in place of its file", () => {
    const files = [file({ chars: 3000 }), file({ topic: "deploys", chars: 8000, cap: 8000 }), file({ topic: "ci", chars: 8000, cap: 8000 })];
    expect(projectCapState(files, null, 32000)).toEqual({ line: "19,000 of 32,000 characters across this project", over: false });
    expect(projectCapState(files, { name: "MEMORY.md", text: "x".repeat(16001) }, 32000).over).toBe(true);
    expect(projectCapState(files, { name: "deploys.md", text: "" }, 32000).line).toBe("11,000 of 32,000 characters across this project");
  });

  it("links each remembered entry to its chat line", () => {
    const href = noteHref({ text: "No npm.", at: "2026-10-25T10:00:00.000Z", messageId: "m12", projectRef: { machineId: "devbox", projectId: "fleetd" } });
    expect(parseHash(href)).toMatchObject({ id: "project", project: { machineId: "devbox", projectId: "fleetd" }, message: "m12" });
  });

  it("is a Settings page that search finds by what people call it", () => {
    expect(parseRoute("#/settings/memory?for=devbox/fleetd")).toMatchObject({ tab: "memory", for: "devbox/fleetd" });
    expect(searchSettings("remember").map((o) => o.label)).toEqual(["Memory"]);
  });
});
