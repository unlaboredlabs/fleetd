// Renders the Rounds in glass with Blender Cycles (scene.py), then lays the renders out as sheets with headless
// Chrome. Renders that already exist are kept, and one run renders at most about three minutes' worth, so run it
// again until it says the sheets are done.
//   BLENDER=/path/to/blender node app/shared/bot-icons/glass/render.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE } from "../palette.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "out", "glass");
const blender = process.env.BLENDER ?? "blender";
const { beings } = JSON.parse(readFileSync(join(here, "beings.json"), "utf8"));
const colour = Object.fromEntries(PALETTE.map((c) => [c.id, c]));
const being = Object.fromEntries(beings.map((b) => [b.id, b]));

const SHOWN = ["fleet", "sun", "mint"];
const HERO = [
  ["A6", "fleet"],
  ["A1", "mint"],
  ["A9", "sun"],
];
const SAME = ["A7", ["plum", "rose", "sky", "graphite"]];

const file = (set, id, c) => join(out, set, `${c}-${id}.png`);
const jobs = [
  ...SHOWN.flatMap((c) => beings.map((b) => ({ being: b.id, c, size: 240, samples: 64, out: file("grid", b.id, c) }))),
  ...HERO.map(([id, c]) => ({ being: id, c, size: 480, samples: 80, out: file("hero", id, c) })),
  ...SAME[1].map((c) => ({ being: SAME[0], c, size: 400, samples: 64, out: file("same", SAME[0], c) })),
];

// Rough seconds per render on two threads, to keep each Blender run short.
const cost = (j) => 20 + (j.size / 240) ** 2 * (j.samples / 64) * 20;
const todo = jobs.filter((j) => !existsSync(j.out));
let batch = [];
let spent = 0;
for (const j of todo) {
  if (spent + cost(j) > 120 && batch.length) break;
  batch.push({ being: j.being, colour: { field: colour[j.c].field }, size: j.size, samples: j.samples, out: j.out });
  spent += cost(j);
}
if (batch.length) {
  for (const j of batch) mkdirSync(dirname(j.out), { recursive: true });
  const list = join(out, "jobs.json");
  writeFileSync(list, JSON.stringify({ jobs: batch }));
  execFileSync(blender, ["-b", "--factory-startup", "-t", "2", "--python", join(here, "scene.py"), "--", list], { stdio: "ignore", timeout: 230_000 });
  const left = jobs.filter((j) => !existsSync(j.out)).length;
  console.log(`rendered ${batch.length}, ${left} left`);
  if (left) process.exit(0);
}

const LIGHT = { bg: "#ffffff", side: "#f5f5f3", text: "#1c1c1a", quiet: "#63635d", faint: "#96968f", line: "#e6e6e2" };
const DARK = { bg: "#1c1c1b", side: "#232322", text: "#ededea", quiet: "#ababa5", faint: "#74746e", line: "#323230" };

const page = (width, height, body, t = LIGHT) => `<!doctype html><meta charset="utf-8"><style>
* { box-sizing: border-box; margin: 0; }
body { width: ${width}px; height: ${height}px; overflow: hidden; background: ${t.side}; color: ${t.text};
  font: 14px/1.35 "Noto Sans", "Liberation Sans", sans-serif; padding: 36px 40px; }
h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
.about { color: ${t.quiet}; margin-top: 4px; }
.num { font-weight: 600; }
.name { color: ${t.quiet}; }
img { display: block; }
</style>${body}`;

function shoot(name, width, height, html) {
  const sheet = join(out, `${name}.html`);
  writeFileSync(sheet, html);
  execFileSync(
    "google-chrome",
    ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", `--window-size=${width},${height}`, `--screenshot=${join(out, `${name}.png`)}`, `file://${sheet}`],
    { stdio: "ignore" },
  );
}

const img = (path, size) => `<img src="${path.slice(out.length + 1)}" width="${size}" height="${size}">`;
const label = (b) => `<span class="num">${b.id}</span> ${b.name}<div class="name">${b.mood}</div>`;

// The hero: three of them, large.
{
  const width = 80 + HERO.length * 260;
  const height = 72 + 30 + 240 + 60;
  const cells = HERO.map(([id, c]) => `<div style="width:260px">${img(file("hero", id, c), 240)}<div style="margin-top:10px">${label(being[id])}</div></div>`).join("");
  shoot("glass-hero", width, height, page(width, height, `<h1>The Rounds, in glass</h1><div class="about">Rendered in Blender Cycles: frosted glass with the face cut into it, over a lit disc.</div><div style="display:flex;margin-top:24px">${cells}</div>`));
}

// All nine in three colours.
{
  const width = 80 + 90 + beings.length * 136;
  const height = 72 + 64 + SHOWN.length * 136 + 30;
  const head = beings.map((b) => `<div style="width:136px">${label(b)}</div>`).join("");
  const rows = SHOWN.map(
    (c) =>
      `<div style="display:flex;align-items:center;height:136px"><div class="name" style="width:90px">${colour[c].name}</div>` +
      beings.map((b) => `<div style="width:136px">${img(file("grid", b.id, c), 120)}</div>`).join("") +
      `</div>`,
  ).join("");
  shoot("glass-all", width, height, page(width, height, `<h1>All nine Rounds</h1><div class="about">At 120px in Fleet, Sun and Mint.</div><div style="display:flex;margin:22px 0 6px 90px">${head}</div>${rows}`));
}

// One being in four more colours.
{
  const [id, cs] = SAME;
  const width = 80 + cs.length * 236;
  const height = 72 + 30 + 220 + 50;
  const cells = cs.map((c) => `<div style="width:236px">${img(file("same", id, c), 210)}<div class="name" style="margin-top:10px">${colour[c].name}</div></div>`).join("");
  shoot("glass-colours", width, height, page(width, height, `<h1>${id} ${being[id].name}, in four more colours</h1><div class="about">Pale fields take a deeper disc, so the glass stands off them at 24px.</div><div style="display:flex;margin-top:24px">${cells}</div>`));
}

// Real size: chat rows at 40px and every Round at 24px, light and dark.
{
  const chats = [
    ["A6", "fleet", "Scout", "Booked the venue for Thursday, the invite is out.", "9:41"],
    ["A1", "mint", "relay", "Push relay is up: apns and fcm both true.", "9:12"],
    ["A9", "sun", "Pixel", "Here are four takes on the header art.", "8:57"],
    ["A3", "fleet", "site", "Showcase clips render at 60 fps now.", "Yesterday"],
    ["A4", "mint", "Ledger", "Your card statement is in; nothing odd this month.", "Yesterday"],
    ["A7", "sun", "Atlas", "Three flights fit; the 7:10 is the cheapest.", "Tue"],
  ];
  const panel = (t) =>
    `<div style="background:${t.bg};color:${t.text};width:540px;padding:18px 24px 20px;border-radius:14px">` +
    `<div style="color:${t.quiet};margin-bottom:4px">Chat list · 40px</div>` +
    chats
      .map(
        ([id, c, name, line, when]) =>
          `<div style="display:flex;gap:12px;align-items:center;height:62px;border-bottom:1px solid ${t.line}">${img(file("grid", id, c), 40)}` +
          `<div style="flex:1;min-width:0"><div style="display:flex"><span style="font-weight:600;flex:1">${name}</span><span style="color:${t.faint};font-size:12px">${when}</span></div>` +
          `<div style="color:${t.quiet};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${line}</div></div></div>`,
      )
      .join("") +
    `<div style="color:${t.quiet};margin:18px 0 10px">Sidebar · 24px</div>` +
    SHOWN.map((c) => `<div style="display:flex;gap:16px;margin-bottom:12px">${beings.map((b) => img(file("grid", b.id, c), 24)).join("")}</div>`).join("") +
    `</div>`;
  const width = 80 + 2 * 540 + 32;
  const height = 72 + 20 + 40 + 6 * 62 + 40 + 3 * 36 + 60;
  shoot("glass-real-size", width, height, page(width, height, `<h1>At real size</h1><div class="about">On the app's light and dark grounds.</div><div style="display:flex;gap:32px;margin-top:20px">${panel(LIGHT)}${panel(DARK)}</div>`));
}
console.log("sheets done");
