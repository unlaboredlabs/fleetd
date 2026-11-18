// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Code } from "./Code";
import { highlight, joinTokens, PLAIN } from "./highlighter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = Array.from({ length: 150 }, (_, i) => `export const step${i} = (x: number) => x * ${i} + Math.max(${i}, x); // step ${i}`).join("\n");

it("joins a line's tokens that look alike, every character keeping its colour and style", async () => {
  const { createHighlighterCore, createCssVariablesTheme } = await import("shiki/core");
  const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
  const h = await createHighlighterCore({
    themes: [createCssVariablesTheme({ name: "fleetd", variablePrefix: "--shiki-", fontStyle: true })],
    langs: [(await import("shiki/langs/typescript.mjs")).default],
    engine: createJavaScriptRegexEngine(),
  });
  const raw = h.codeToTokensBase(source, { lang: "typescript", theme: "fleetd" });
  const styleOf = (line: { content: string; color?: string | undefined; italic?: boolean; fontStyle?: number | undefined }[]) =>
    line.flatMap((t) => Array.from(t.content).map((c) => (c.trim() === "" ? c : `${c}${t.color ?? ""}${(t.italic ?? ((t.fontStyle ?? 0) & 1) === 1) ? "i" : ""}`)));
  let before = 0;
  let after = 0;
  for (const line of raw) {
    const joined = joinTokens(line);
    expect(styleOf(joined)).toEqual(styleOf(line));
    before += line.length;
    after += joined.length;
  }
  expect(after).toBeLessThan(before * 0.75);
});

it("draws a highlighted block in few elements: its text's own colour as bare text", async () => {
  await highlight(source, "typescript");
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<Code code={source} lang="ts" />));
  const code = host.querySelector("pre code");
  // A span for every token was 28 elements a line here (its own and 27 tokens'), 4,200 for the block.
  expect(code?.querySelectorAll("span").length).toBeLessThan(150 * 16);
  expect(code?.textContent).toBe(source.split("\n").join(""));
  const plain = [...(code?.querySelectorAll("span span") ?? [])].filter((e) => (e as HTMLElement).style.color === PLAIN);
  expect(plain).toHaveLength(0);
  act(() => root.unmount());
});
