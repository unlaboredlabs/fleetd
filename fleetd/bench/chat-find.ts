// A person's chat search on a big chat: a bot with 200,000 messages (and a second bot beside it), filled into the
// index as a hub from before the index would, then each kind of query's first page as chat_find answers it (hits, their
// lines and marks, and the count), timed. Everything is in a throwaway home under $TMPDIR, deleted at the end.
// `bun bench/chat-find.ts [--messages 200000] [--runs 30]`
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fillStep, find, type FindQuery, keepIndex, unfilled } from "../src/hub/chat/find.ts";
import { FIND_LIMIT, hitText, parseWords } from "../src/hub/chat/find_rules.ts";
import { HubDb } from "../src/hub/store/db.ts";
import type { ChatFindHas, ProjectRef } from "../src/shared/contracts.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const total = Number(arg("messages") ?? 200_000);
const runs = Number(arg("runs") ?? 30);
const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-chat-find-"));
const BOT: ProjectRef = { machineId: "devbox", projectId: "big" };
const NEIGHBOUR: ProjectRef = { machineId: "devbox", projectId: "neighbour" };

// A seeded generator, so every run searches the same chat.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const syllables = ["ka", "lo", "mi", "ne", "ru", "sa", "to", "vi", "de", "pl", "oy", "st", "ar", "en", "ch", "qu"];
const vocab = Array.from({ length: 6000 }, () => Array.from({ length: 2 + Math.floor(rand() * 3) }, () => syllables[Math.floor(rand() * syllables.length)]).join(""));
// Zipf-like: a few words are everywhere, most are rare.
const word = () => vocab[Math.floor(vocab.length * rand() ** 3)]!;

function message(n: number, r: ProjectRef, seq: number, ms: number) {
  const lead = rand() < 0.5;
  const words = Array.from({ length: 5 + Math.floor(rand() * (lead ? 120 : 30)) }, word);
  if (rand() < 0.08) words.push("https://github.com/acme/shop/pull/" + Math.floor(rand() * 2000));
  if (rand() < 0.05) words.push(`#${Math.floor(rand() * 2000)}`);
  if (n % 50_000 === 7) words.push("zanzibar quokka"); // a phrase few messages hold
  const attachments = rand() < 0.03 ? [{ attachmentId: `at_${n}`, name: `shot-${n}.png`, mime: rand() < 0.6 ? "image/png" : "application/pdf", bytes: 1000 }] : [];
  const person = lead ? undefined : { personId: rand() < 0.5 ? "p_aaaaaaaa" : "p_bbbbbbbb", name: "Ada" };
  return {
    messageId: `m${n}`,
    projectRef: r,
    seq,
    author: lead ? "lead" : "human",
    text: words.join(" "),
    attachments,
    createdAt: new Date(ms).toISOString(),
    state: "final",
    ...(person ? { person } : {}),
  };
}

const db = HubDb.open(home);
const conn = db.conn;
conn.run("PRAGMA synchronous = OFF");

// The chat as a hub from before the index has it: rows only, nothing indexed.
const t0 = performance.now();
const insert = conn.query("INSERT INTO chat_messages (n, machine_id, project_id, seq, created_ms, data) VALUES (?, ?, ?, ?, ?, ?)");
const start = Date.parse("2025-01-01T00:00:00Z");
const neighbours = Math.floor(total / 4);
let bigSeq = 0;
let nSeq = 0;
conn.transaction(() => {
  for (let n = 1; n <= total + neighbours; n++) {
    const mine = n % 5 !== 0 || bigSeq >= total;
    const r = mine && bigSeq < total ? BOT : NEIGHBOUR;
    const seq = r === BOT ? ++bigSeq : ++nSeq;
    const ms = start + n * 60_000;
    const m = message(n, r, seq, ms);
    insert.run(n, r.machineId, r.projectId, seq, ms, JSON.stringify(m));
  }
})();
conn.run("UPDATE chat_find_built SET below = (SELECT MAX(n) + 1 FROM chat_messages)");
const seeded = performance.now() - t0;

// Filling it, as the hub does between its other work: the whole, and the longest single step (what a step blocks).
keepIndex(conn, false);
let worstStep = 0;
const f0 = performance.now();
for (;;) {
  const s = performance.now();
  const more = fillStep(conn);
  worstStep = Math.max(worstStep, performance.now() - s);
  if (!more) break;
}
const filled = performance.now() - f0;
if (unfilled(conn) !== 1) throw new Error("the index isn't filled");

// A message as the chat writes it with the index kept: the cost the triggers add per message.
const w0 = performance.now();
const extra = 2000;
conn.transaction(() => {
  for (let i = 1; i <= extra; i++) {
    const n = total + neighbours + i;
    const m = message(n, BOT, total + i, start + n * 60_000);
    insert.run(n, BOT.machineId, BOT.projectId, total + i, start + n * 60_000, JSON.stringify(m));
  }
})();
const perWrite = (performance.now() - w0) / extra;

// A few pins for has:pinned.
for (let i = 0; i < 20; i++) {
  conn.query("INSERT OR IGNORE INTO chat_message_pins VALUES (?, ?, ?, ?, 'p_aaaaaaaa', 'Ada')").run(BOT.machineId, BOT.projectId, 1 + i * 9_973, i);
}

const common = vocab[0]!;
const middling = vocab[300]!;
const rare = vocab[5990]!;
const queries: [string, Partial<FindQuery> & { words?: string; has?: ChatFindHas[] }][] = [
  ["a common word", { words: common }],
  ["a middling word", { words: middling }],
  ["a rare word", { words: rare }],
  ["two words", { words: `${common} ${middling}` }],
  ["a two-letter start (as you type)", { words: common.slice(0, 2) }],
  ["a one-letter start (as you type)", { words: common.slice(0, 1) }],
  ["a phrase", { words: '"zanzibar quokka"' }],
  ["from the lead", { words: middling, author: "lead" }],
  ["one person, no words", { personId: "p_bbbbbbbb" }],
  ["has a link", { words: middling, has: ["link"] }],
  ["has a pull request, no words", { has: ["pr"] }],
  ["has an image", { words: common, has: ["image"] }],
  ["pinned, no words", { has: ["pinned"] }],
  ["a day far back, no words", { sinceMs: start + 40_000 * 60_000, untilMs: start + 40_000 * 60_000 + 86_400_000 }],
  ["before a day far back, no words (one end)", { untilMs: start + 40_000 * 60_000 }],
  ["a word in a month far back", { words: common, sinceMs: start + 30_000 * 60_000, untilMs: start + 30_000 * 60_000 + 30 * 86_400_000 }],
];

/** chat_find's first page: the hits, their lines and marks, and the count. */
function firstPage(q: Partial<FindQuery> & { words?: string }) {
  const terms = parseWords(q.words ?? "");
  const found = find(conn, BOT, { ...q, terms, limit: FIND_LIMIT, count: true });
  const hits = found.messages.map((m) => hitText(m.text, m.attachments, terms));
  return { hits: hits.length, count: found.count, countMore: found.countMore };
}

const ms = (x: number) => `${x.toFixed(1)} ms`;
console.log(`chat: ${total.toLocaleString()} messages in the bot, ${neighbours.toLocaleString()} in a neighbour; seeded in ${ms(seeded)}`);
console.log(`index filled in ${ms(filled)} (${Math.ceil((total + neighbours) / 2000)} steps, the longest ${ms(worstStep)}); a message written with the index kept: ${perWrite.toFixed(3)} ms`);
console.log("");
console.log("| query | hits on the page | count | median | p95 | max |");
console.log("|---|---|---|---|---|---|");
let worst = 0;
for (const [name, q] of queries) {
  const times: number[] = [];
  let out = firstPage(q);
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    out = firstPage(q);
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]!;
  worst = Math.max(worst, p95);
  console.log(`| ${name} | ${out.hits} | ${out.count}${out.countMore ? "+" : ""} | ${ms(times[Math.floor(times.length / 2)]!)} | ${ms(p95)} | ${ms(times.at(-1)!)} |`);
}
console.log("");
console.log(`worst p95: ${ms(worst)} (budget 100 ms)`);
const one = (sql: string) => Object.values(conn.query(sql).get() as Record<string, number>)[0] ?? 0;
const mib = (n: number) => `${(n / 1048576).toFixed(0)} MiB`;
const text = one("SELECT SUM(length(json_extract(data, '$.text'))) FROM chat_messages");
console.log(`database: ${mib(one("PRAGMA page_count") * one("PRAGMA page_size"))}; the messages' text ${mib(text)}`);
db.close();
rmSync(home, { recursive: true, force: true });
if (worst > 100) process.exit(1);
