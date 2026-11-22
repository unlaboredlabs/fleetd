// scripts/net-app/web-drop.ts: the web app in a real Chrome across a drop, through netem: the chat open, a lead reply
// streaming, then the link cut (open connections lost silently, as a sleep or a network switch leaves them) for
// --cut seconds a moment into it. Measured from the link coming back: when the page says it is offline (if it does),
// when its socket is live again, and when the reply's final text shows; then whether every message of the chat shows
// once (none lost, none twice). Needs hub.ts with --web; reads its JSON line from --rig.
//
//   bun scripts/net-app/web-drop.ts --rig $TMPDIR/hub.out [--profile 3g] [--cut 5] [--runs 3] [--out file.json]
import { readFileSync, writeFileSync } from "node:fs";
import { startNetem } from "../netem.ts";

const flag = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? d : process.argv[i + 1];
};
const rig = JSON.parse(readFileSync(flag("rig")!, "utf8")) as { web: number; control: number };
const profile = flag("profile", "3g")!;
const cutS = Number(flag("cut", "5"));
const runs = Number(flag("runs", "3"));
const kind = flag("kind", "cut") as "cut" | "drop";

const browser = async (...args: string[]) => {
  const r = Bun.spawn(["agent-browser", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(r.stdout).text();
  await r.exited;
  return out.trim();
};
const evalJson = async <T>(js: string): Promise<T | undefined> => {
  const out = await browser("eval", js);
  try {
    const once = JSON.parse(out) as unknown;
    return (typeof once === "string" ? JSON.parse(once) : once) as T;
  } catch {
    return undefined;
  }
};
const control = (path: string) => fetch(`http://127.0.0.1:${rig.control}${path}`).then((r) => r.json());

/** What the page says about its link: any of the words the screens use for a link that's away. */
const AWAY = /Reconnecting|Offline|offline|Can.t reach|Connecting|isn.t answering|Trying again|Retry now/u;
const PAGE = `JSON.stringify({ text: document.body.innerText, at: performance.now() })`;

const rows: Array<Record<string, number | string>> = [];
for (let i = 0; i < runs; i++) {
  const n = await startNetem({ target: rig.web, profile, seed: i + 1 });
  await browser("open", `${n.url}/`);
  // The chat is up and settled.
  for (let k = 0; k < 600; k++) {
    const p = await evalJson<{ text: string }>(`JSON.stringify({ text: document.querySelector('[aria-label="Message the lead"]') ? "up" : "" })`);
    if (p?.text === "up") break;
    await Bun.sleep(100);
  }
  await Bun.sleep(2000);
  n.reset();
  // A reply streams for ~6 s (3000 chars, 40 every 80 ms); the link goes 1.5 s into it.
  const reply = control(`/lead?chars=3000&every=80&chunk=40`) as Promise<{ text: string; seq: number }>;
  await Bun.sleep(1500);
  const cutAt = performance.now();
  if (kind === "drop") n.drop(cutS);
  else n.cut(cutS);
  const backAt = cutAt + cutS * 1000;
  const final = await reply;
  const tail = final.text.replace(/\s+/gu, " ").trim().slice(-40);
  let awaySeen: number | undefined;
  let shown: number | undefined;
  const t0 = performance.now();
  while (performance.now() - t0 < 90_000) {
    const p = await evalJson<{ text: string }>(PAGE);
    const now = performance.now();
    if (p !== undefined) {
      if (awaySeen === undefined && AWAY.test(p.text)) awaySeen = now;
      if (now > backAt && p.text.replace(/\s+/gu, " ").includes(tail)) {
        shown = now;
        break;
      }
    }
    await Bun.sleep(100);
  }
  await Bun.sleep(1500);
  // Every message once: each one's last words, counted in the page (the chat's newest page of messages).
  const truth = (await control("/truth")) as Array<{ text: string; seq: number }>;
  // Whitespace as one space both sides: the page draws paragraphs its own way.
  const flat = (t: string) => t.replace(/\s+/gu, " ").trim();
  const page = flat((await evalJson<{ text: string }>(PAGE))?.text ?? "");
  const lastPage = truth.slice(-5);
  const counts = lastPage.map((m) => page.split(flat(m.text).slice(-40)).length - 1);
  const missing = lastPage.filter((_, k) => counts[k] === 0).map((m) => m.seq).join(",");
  const stats = n.stats();
  rows.push({
    awayShownAfterCutMs: awaySeen === undefined ? "never" : Math.round(awaySeen - cutAt),
    finalShownAfterBackMs: shown === undefined ? "never" : Math.round(shown - backAt),
    lost: counts.filter((c) => c === 0).length,
    twice: counts.filter((c) => c > 1).length,
    missing,
    conns: stats.conns,
    down: stats.down,
    up: stats.up,
  });
  process.stderr.write(`${profile} run ${i + 1}: ${JSON.stringify(rows.at(-1))}\n`);
  await browser("open", "about:blank");
  await n.close();
}
const file = flag("out");
if (file !== undefined) writeFileSync(file, `${JSON.stringify({ profile, cutS, kind, rows }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ profile, cutS, kind, rows })}\n`);
