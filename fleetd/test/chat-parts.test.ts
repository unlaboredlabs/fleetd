import { expect, test } from "bun:test";
import { block, CHAT_PARTS_MAX, parts, unshown } from "../src/hub/chat/parts.ts";

const sliced = (text: string) => (parts(text) ?? []).map((p) => [text.slice(p.start, p.end), p.block?.kind] as const);
const texts = (text: string) => sliced(text).map(([s]) => s);

test("a one-liner is one bubble and blank lines split the rest", () => {
  expect(parts("merged, it's in the next Edge build")).toBeUndefined();
  expect(parts("line one\nline two")).toBeUndefined();
  expect(texts("oof 😬\n\nCI's red on `main`: `cargo test` fails in `hub::chat`.\n\n\nwant me to revert?")).toEqual([
    "oof 😬",
    "CI's red on `main`: `cargo test` fails in `hub::chat`.",
    "want me to revert?",
  ]);
});

test("code, lists, tables and diffs are never split", () => {
  const text =
    "here's the fix:\n```diff\n-let ttl = 60;\n\n+let ttl = 3600;\n```\nthree left:\n\n- one\n\n- two\n  still two\n\n- three\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nnice";
  expect(texts(text)).toEqual([
    "here's the fix:",
    "```diff\n-let ttl = 60;\n\n+let ttl = 3600;\n```",
    "three left:",
    "- one\n\n- two\n  still two\n\n- three",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "nice",
  ]);
  expect(texts("ugh\n```\na\n\nb\n")).toEqual(["ugh", "```\na\n\nb"]);
});

test("a valid block is a block and anything else shows as its fence", () => {
  const chart = `{"v":1,"kind":"chart","chart":"bar","title":"PRs merged","x":["Mon","Tue"],"series":[{"name":"main","values":[3,5]}]}`;
  const got = sliced(`nice week\n\n\`\`\`fleetd-block\n${chart}\n\`\`\``);
  expect(got[1]).toEqual([`\`\`\`fleetd-block\n${chart}\n\`\`\``, "chart"]);
  expect(sliced(`\`\`\`fleetd-block\n${chart}\n\`\`\``).length).toBe(1);
  const fallback = (json: string) => sliced(`ok\n\n\`\`\`fleetd-block\n${json}\n\`\`\``)[1]?.[1];
  expect(fallback(chart.replace("[3,5]", "[3]"))).toBeUndefined();
  expect(fallback('{"v":1,')).toBeUndefined();
  expect(fallback(chart.replace('"v":1', '"v":2'))).toBeUndefined();
  expect(fallback('{"v":1,"kind":"map","lat":52.1}')).toBeUndefined();
  for (const bad of ["<script>alert(1)</script>", "javascript:alert(1)", "see https://evil.example"]) {
    expect(fallback(chart.replace("PRs merged", bad))).toBeUndefined();
  }
  const diff = `{"v":1,"kind":"diff","files":[{"path":"index.html","hunks":["@@ -1 +1 @@\\n-<p>a</p>\\n+<p>b</p>"]}]}`;
  expect(fallback(diff)).toBe("diff");
  const over = `{"v":1,"kind":"ask","question":"go?","pad":"${" ".repeat(16_000)}"}`;
  expect(fallback(over)).toBeUndefined();
  expect(sliced(`ok\n\n\`\`\`ts\n${chart}\n\`\`\``)[1]?.[1]).toBeUndefined();
});

test("past the bubble cap the lead hears of each block that didn't show", () => {
  const image = (n: number) => `\`\`\`fleetd-block\n{"v":1,"kind":"image","attachmentId":"F${n}"}\n\`\`\``;
  const nine = Array.from({ length: 9 }, (_, i) => image(i + 1)).join("\n\n");
  expect(sliced(nine).every(([, k]) => k === "image")).toBe(true);
  expect(unshown(nine)).toBeUndefined();
  const many = Array.from({ length: CHAT_PARTS_MAX + 1 }, (_, i) => image(i + 1)).join("\n\n");
  const got = sliced(many);
  expect(got.length).toBe(CHAT_PARTS_MAX);
  expect(got[CHAT_PARTS_MAX - 1]?.[1]).toBeUndefined();
  const past = "a message shows at most 24 bubbles (paragraphs, fences and blocks); send the rest in another";
  expect(unshown(many)).toBe(
    `- in your last message, block 24 didn't show: ${past}; block 25 didn't show: ${past}; the person sees a "couldn't show this" chip for each block that didn't show: fix and send again if it matters`,
  );
});

test("a broken rule is named", () => {
  const table = `{"v":1,"kind":"table","columns":["PR",""],"rows":[["#1","ok"]]}`;
  expect(unshown(`ok\n\n\`\`\`fleetd-block\n${table}\n\`\`\``)).toBe(
    `- in your last message, block 1 didn't show: columns[1]: expected a non-empty string; the person sees a "couldn't show this" chip for each block that didn't show: fix and send again if it matters`,
  );
  expect(block(`{"v":1,"kind":"table","columns":["a","b"],"rows":[["1"]]}`).why).toBe("each row has one cell per column");
});
