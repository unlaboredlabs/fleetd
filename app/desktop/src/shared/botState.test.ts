import { describe, expect, it } from "vitest";
import { botStateOf, type BotIn } from "./bot";

const of = (b: Partial<BotIn>) => botStateOf({ needs: false, blocked: false, running: 0, doing: undefined, done: false, ...b });

describe("a project's bot", () => {
  it("shows what matters most: you, a block, work, thinking, a new reply, else idle", () => {
    expect(of({})).toBe("idle");
    expect(of({ done: true })).toBe("done");
    expect(of({ doing: "thinking" })).toBe("thinking");
    expect(of({ doing: "planning" })).toBe("thinking");
    expect(of({ doing: "editing `a.ts`" })).toBe("working");
    // Its agents at work outweigh the lead's thinking, and a reply waiting while they work.
    expect(of({ doing: "thinking", running: 2 })).toBe("working");
    expect(of({ running: 1, done: true })).toBe("working");
    expect(of({ blocked: true, running: 1 })).toBe("error");
    expect(of({ needs: true, blocked: true, doing: "thinking" })).toBe("needs");
  });
});
