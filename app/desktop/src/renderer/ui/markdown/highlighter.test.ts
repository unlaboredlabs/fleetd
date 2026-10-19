import { describe, expect, it } from "vitest";
import { canHighlight, highlight, MAX_CHARS, MAX_LINE, MAX_LINES, resolveLang } from "./highlighter";

describe("highlight", () => {
  it("leaves a very long line plain instead of freezing (50k chars took 3.6 s unbounded)", async () => {
    const line = `const blob = "${"x".repeat(90_000)}";`;
    const code = `const a = 1;\n${line}\nconst b = 2;`;
    const started = performance.now();
    const tokens = await highlight(code, "typescript");
    expect(performance.now() - started).toBeLessThan(5000);
    expect(tokens).toHaveLength(3);
    // The long line comes back as one plain token holding all of it; its neighbours are still coloured.
    expect(tokens?.[1]?.map((t) => t.content).join("")).toBe(line);
    expect(tokens?.[1]).toHaveLength(1);
    expect(tokens?.[0]?.length).toBeGreaterThan(1);
  }, 20_000);

  it("colours lines up to the limit", async () => {
    const tokens = await highlight(`const s = "${"y".repeat(MAX_LINE - 20)}";`, "typescript");
    expect(tokens?.[0]?.length).toBeGreaterThan(1);
  });

  it("skips blocks past the size caps entirely", async () => {
    expect(canHighlight("x".repeat(MAX_CHARS + 1))).toBe(false);
    expect(canHighlight("a\n".repeat(MAX_LINES + 1))).toBe(false);
    expect(canHighlight("a\n".repeat(10))).toBe(true);
    expect(await highlight("x".repeat(MAX_CHARS + 1), "typescript")).toBeNull();
  });
});

describe("resolveLang", () => {
  it("maps fence tags and aliases, and ignores object keys", () => {
    expect(resolveLang("ts")).toBe("typescript");
    expect(resolveLang("Rust")).toBe("rust");
    expect(resolveLang("constructor")).toBeNull();
    expect(resolveLang("toString")).toBeNull();
    expect(resolveLang("brainfuck")).toBeNull();
  });
});
