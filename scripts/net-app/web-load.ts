// scripts/net-app/web-load.ts: the web app's first load in a real Chrome (agent-browser's session), through netem, per
// profile: from navigation to the first usable screen (the chat's newest message drawn, the composer there), cold (a
// netem port of its own, so nothing of it is in the HTTP cache: the cache keys on the URL, port included) and warm (a
// reload). Bytes are netem's, payload both ways. Needs hub.ts running with --web; reads its JSON line from --rig.
//
//   bun scripts/net-app/web-load.ts --rig $TMPDIR/hub.out [--profiles 3g,satellite] [--runs 3] [--out file.json]
import { readFileSync, writeFileSync } from "node:fs";
import { startNetem } from "../netem.ts";

const flag = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? d : process.argv[i + 1];
};
const rig = JSON.parse(readFileSync(flag("rig")!, "utf8")) as { web: number; control: number };
const profiles = (flag("profiles") ?? "clean,3g,satellite,lossy-wifi,tiny-bandwidth").split(",");
const runs = Number(flag("runs") ?? 3);

/** Async: netem runs in this process, and a blocking spawn would stall the link it measures. */
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

const last = ((await (await fetch(`http://127.0.0.1:${rig.control}/truth`)).json()) as Array<{ text: string }>).at(-1)!.text.trim().slice(-30);
const USABLE = `JSON.stringify({ ok: !!document.querySelector('[aria-label="Message the lead"]') && document.body.innerText.includes(${JSON.stringify(last)}), at: performance.now(), url: location.href })`;

/** Navigates (without waiting on load) and polls until the chat is usable; ms from navigation start. */
const load = async (url: string, timeoutMs = 120_000) => {
  await browser("eval", `setTimeout(() => location.assign(${JSON.stringify(url)}), 0); 1`);
  const t0 = performance.now();
  // An eval sent while the old page is going waits out CDP's own timeout: start once the new one has begun.
  await Bun.sleep(150);
  for (;;) {
    const r = await evalJson<{ ok: boolean; at: number; url: string }>(USABLE);
    if (r?.ok === true && r.url.startsWith(url)) return r.at;
    if (performance.now() - t0 > timeoutMs) return Number.NaN;
    await Bun.sleep(100);
  }
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const out: Record<string, unknown> = {};
for (const profile of profiles) {
  const rows: Array<Record<string, number>> = [];
  for (let i = 0; i < runs; i++) {
    const n = await startNetem({ target: rig.web, profile, seed: i + 1 });
    // A page on another origin first, so the next navigation starts from nothing of this one.
    await browser("open", "about:blank");
    // --path: a route to open (the measured chat's, `#/project/lab-a/p1`, on a rig with many bots).
    const url = `${n.url}/${flag("path") ?? ""}`;
    const cold = await load(url);
    await Bun.sleep(3000);
    const coldBytes = n.stats();
    n.reset();
    await browser("open", "about:blank");
    const warm = await load(url);
    await Bun.sleep(3000);
    const warmBytes = n.stats();
    rows.push({ coldMs: Math.round(cold), coldDown: coldBytes.down, coldUp: coldBytes.up, coldConns: coldBytes.conns, warmMs: Math.round(warm), warmDown: warmBytes.down, warmUp: warmBytes.up });
    await browser("open", "about:blank");
    await n.close();
  }
  out[profile] = { median: Object.fromEntries(Object.keys(rows[0]!).map((k) => [k, median(rows.map((r) => r[k]!))])), rows };
  process.stderr.write(`${profile}: ${JSON.stringify((out[profile] as { median: unknown }).median)}\n`);
}
const file = flag("out");
if (file !== undefined) writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(out)}\n`);
