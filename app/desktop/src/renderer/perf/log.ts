// A deterministic conversation log for the scroll budget: mostly one-line tool and status lines, with a wrapped
// paragraph or a code line now and then, as an order's conversation reads.

export interface LogLine {
  readonly id: number;
  readonly kind: "tool" | "message" | "code";
  readonly text: string;
}

const WORDS =
  "the writer ran the tests again and the reviewer asked for a smaller change to the merge train before the verifier checked each page against its done-when criteria while the lead waited".split(
    " ",
  );
const TOOLS = ["Read", "Edit", "Bash", "Grep", "Write", "Glob"];

/** A small LCG, so every run scrolls the same rows. */
const random = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
};

export const makeLog = (count: number, seed = 20_261_019): Array<LogLine> => {
  const next = random(seed);
  const words = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(next() * WORDS.length)] ?? "").join(" ");
  return Array.from({ length: count }, (_, id) => {
    const roll = next();
    if (roll < 0.06) return { id, kind: "message", text: `${words(40 + Math.floor(next() * 80))}.` };
    if (roll < 0.12) return { id, kind: "code", text: `const step${id} = await run("${words(3)}", { attempt: ${Math.floor(next() * 4)} });` };
    const tool = TOOLS[Math.floor(next() * TOOLS.length)] ?? "Read";
    return { id, kind: "tool", text: `${tool} lab/pages/${words(2).replaceAll(" ", "-")}.md · ${words(4 + Math.floor(next() * 6))}` };
  });
};
