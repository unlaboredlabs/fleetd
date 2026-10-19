// Global teardown: gathers every shot into findings.json and a contact sheet (index.html) beside the PNGs, so the
// CI artifact opens straight into a reviewable page.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Shot } from "./harness.ts";
import { resultsDir } from "./harness.ts";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export function readShots(dir = resultsDir): Shot[] {
  const shotsDir = path.join(dir, "shots");
  if (!existsSync(shotsDir)) return [];
  return readdirSync(shotsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(shotsDir, f), "utf8")) as Shot);
}

export function contactSheet(shots: Shot[]) {
  const total = shots.reduce((n, s) => n + s.findings.length, 0);
  const byScreen = Map.groupBy(shots, (s) => s.screen);
  const sections = [...byScreen].map(([screen, list]) => {
    const tiles = list.map((s) => {
      const label = `${s.fixture} · ${s.size} · ${s.theme} · ${s.platform} @${s.scale}x`;
      const img = s.overlay ?? s.png;
      const items = s.findings
        .map((f, i) => `<li><b>${i + 1} ${esc(f.check)}</b> ${esc(f.message)}<br><code>${esc(f.where)}</code><br>“${esc(f.text)}”</li>`)
        .join("");
      return `<figure class="${s.findings.length ? "bad" : "ok"}">
  <a href="${esc(img)}"><img loading="lazy" src="${esc(img)}" alt="${esc(label)}"></a>
  <figcaption>${esc(label)} — ${s.findings.length ? `<b>${s.findings.length} finding${s.findings.length === 1 ? "" : "s"}</b> · <a href="${esc(s.png)}">clean shot</a>` : "no findings"}</figcaption>
  ${items ? `<ol>${items}</ol>` : ""}
</figure>`;
    });
    const count = list.reduce((n, s) => n + s.findings.length, 0);
    return `<section><h2>${esc(screen)} <small>${list.length} shots, ${count} findings</small></h2><div class="grid">${tiles.join("\n")}</div></section>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>fleetd desktop QA: ${total} findings</title>
<style>
  body { font: 14px/1.45 system-ui, sans-serif; margin: 24px; color: #1c2024; background: #fcfcfd; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 32px; } small { color: #60646c; font-weight: 400; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
  figure { margin: 0; border: 1px solid #d9d9e0; border-radius: 8px; padding: 8px; background: #fff; }
  figure.bad { border-color: #e5484d; }
  img { width: 100%; height: auto; display: block; border-radius: 4px; }
  figcaption { margin-top: 6px; } ol { margin: 6px 0 0; padding-left: 20px; font-size: 12px; overflow-wrap: anywhere; }
  code { font-size: 11px; color: #60646c; }
</style></head>
<body><h1>fleetd desktop QA — ${shots.length} shots, ${total} findings</h1>
<p>Red frames have findings; each image opens with the findings drawn on it. Raw data: <a href="findings.json">findings.json</a>.</p>
${sections.join("\n")}
</body></html>`;
}

export default function writeReport() {
  const shots = readShots();
  if (shots.length === 0) return;
  const total = shots.reduce((n, s) => n + s.findings.length, 0);
  writeFileSync(
    path.join(resultsDir, "findings.json"),
    JSON.stringify({ shots: shots.length, findings: total, results: shots }, null, 2),
  );
  writeFileSync(path.join(resultsDir, "index.html"), contactSheet(shots));
  console.log(`QA contact sheet: ${path.join(resultsDir, "index.html")} (${shots.length} shots, ${total} findings)`);
}
