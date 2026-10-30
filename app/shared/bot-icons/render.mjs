// Renders the bot icon gallery: one SVG per being into svg/ (in Fleet), and the contact sheets into out/ as HTML and,
// through headless Chrome, PNG. Run: node app/shared/bot-icons/render.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE } from "./palette.mjs";
import { FAMILIES, SHAPES, iconSvg } from "./shapes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(join(here, "svg"), { recursive: true });
mkdirSync(out, { recursive: true });

const colour = Object.fromEntries(PALETTE.map((c) => [c.id, c]));
const shape = Object.fromEntries(SHAPES.map((s) => [s.id, s]));

for (const s of SHAPES) writeFileSync(join(here, "svg", `${s.id}.svg`), `${iconSvg(s, colour.fleet)}\n`);

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
svg { display: block; }
</style>${body}`;

function shoot(name, width, height, html) {
  const file = join(out, `${name}.html`);
  writeFileSync(file, html);
  execFileSync("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    `--window-size=${width},${height}`,
    `--screenshot=${join(out, `${name}.png`)}`,
    `file://${file}`,
  ], { stdio: "ignore" });
}

// One sheet per family: every shape at 120px, in three colours.
const FAMILY_COLOURS = {
  A: ["sun", "fleet", "mint"],
  B: ["graphite", "lime", "sky"],
  C: ["ember", "lilac", "teal"],
  D: ["plum", "sand", "rose"],
  E: ["teal", "sun", "fleet"],
};
for (const f of FAMILIES) {
  const width = 80 + 90 + 8 * 140;
  const height = 72 + 70 + 3 * 140 + 36;
  const head = f.shapes
    .map((s, i) => `<div style="width:140px"><span class="num">${f.letter}${i + 1}</span> ${s.name}<div class="name">${s.mood}</div></div>`)
    .join("");
  const rows = FAMILY_COLOURS[f.letter]
    .map((c) => {
      const icons = f.shapes
        .map((s, i) => `<div style="width:140px">${iconSvg({ ...s }, colour[c], 120)}</div>`)
        .join("");
      return `<div style="display:flex;align-items:center;height:140px"><div class="name" style="width:90px">${colour[c].name}</div>${icons}</div>`;
    })
    .join("");
  shoot(
    `family-${f.letter}`,
    width,
    height,
    page(
      width,
      height,
      `<h1>${f.letter} · ${f.name}</h1><div class="about">${f.about}</div>` +
        `<div style="display:flex;margin:28px 0 8px 90px">${head}</div>${rows}`,
    ),
  );
}

// Every colour: a handful of shapes in the whole palette.
{
  const picks = ["A1", "B1", "C1", "D1", "E1", "E8"];
  const width = 80 + 60 + PALETTE.length * 104;
  const height = 72 + 120 + picks.length * 104 + 40;
  const head = PALETTE.map(
    (c) =>
      `<div style="width:104px"><div style="display:flex;gap:4px;margin-bottom:6px">` +
      `<span style="width:16px;height:16px;border-radius:8px;background:${c.field}"></span>` +
      `<span style="width:16px;height:16px;border-radius:8px;background:${c.mark};box-shadow:inset 0 0 0 1px #0002"></span></div>` +
      `<div class="num">${c.name}</div><div class="name" style="font-size:11px">${c.field}<br>${c.mark}</div></div>`,
  ).join("");
  const rows = picks
    .map(
      (id) =>
        `<div style="display:flex;align-items:center;height:104px"><div class="num" style="width:60px">${id}</div>` +
        PALETTE.map((c) => `<div style="width:104px">${iconSvg(shape[id], c, 88)}</div>`).join("") +
        `</div>`,
    )
    .join("");
  shoot(
    "palette",
    width,
    height,
    page(
      width,
      height,
      `<h1>Palette · 12 colours</h1><div class="about">Each colour is a field and a mark; any shape takes any colour.</div>` +
        `<div style="display:flex;margin:22px 0 4px 60px">${head}</div>${rows}`,
    ),
  );
}

// Everything at once: every being at 88px, the palette cycling, for picking by number.
{
  const cols = 8;
  const width = 80 + cols * 132;
  const height = 72 + 20 + FAMILIES.length * 170 + 30;
  const order = ["fleet", "sun", "teal", "rose", "plum", "lime", "ember", "sky", "graphite", "mint", "lilac", "sand"];
  const rows = FAMILIES.map(
    (f, r) =>
      `<div style="display:flex;height:170px;align-items:center">` +
      f.shapes
        .map(
          (s, i) =>
            `<div style="width:132px">${iconSvg(s, colour[order[(r * 3 + i) % order.length]], 88)}` +
            `<div style="margin-top:6px"><span class="num">${f.letter}${i + 1}</span> ${s.name}<div class="name">${s.mood}</div></div></div>`,
        )
        .join("") +
      `</div>`,
  ).join("");
  shoot(
    "overview",
    width,
    height,
    page(
      width,
      height,
      `<h1>All ${SHAPES.length} beings</h1><div class="about">${FAMILIES.map((f) => `${f.letter} ${f.name}`).join(" · ")}</div>` +
        `<div style="margin-top:20px">${rows}</div>`,
    ),
  );
}

// Real size: a chat list at 40px and a sidebar at 24px, light and dark, then every shape at 24px.
{
  const chats = [
    ["C3", "sun", "Scout", "Booked the venue for Thursday, the invite is out.", "9:41"],
    ["B1", "graphite", "fleetd", "Merged #851: the list stays still under the menu.", "9:12"],
    ["A1", "fleet", "site", "Showcase clips render at 60 fps now.", "8:57"],
    ["D3", "ember", "Ledger", "Your card statement is in; nothing odd this month.", "Yesterday"],
    ["B2", "teal", "relay", "Push relay is up: apns and fcm both true.", "Yesterday"],
    ["E1", "plum", "Atlas", "Three flights fit; the 7:10 is the cheapest.", "Tue"],
    ["C1", "rose", "Pixel", "Here are four takes on the header art.", "Mon"],
    ["D1", "mint", "docs", "Rebuilt site/docs after the settings page edit.", "Sun"],
  ];
  const panel = (t) => {
    const list = chats
      .map(
        ([id, c, name, line, when]) =>
          `<div style="display:flex;gap:12px;align-items:center;height:64px;border-bottom:1px solid ${t.line}">` +
          `${iconSvg(shape[id], colour[c], 40)}<div style="flex:1;min-width:0"><div style="display:flex">` +
          `<span style="font-weight:600;flex:1">${name}</span><span style="color:${t.faint};font-size:12px">${when}</span></div>` +
          `<div style="color:${t.quiet};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${line}</div></div></div>`,
      )
      .join("");
    const side = chats
      .map(
        ([id, c, name]) =>
          `<div style="display:flex;gap:8px;align-items:center;height:32px">${iconSvg(shape[id], colour[c], 24)}<span>${name}</span></div>`,
      )
      .join("");
    const order = PALETTE.map((c) => c.id);
    const all = SHAPES.map(
      (s, i) => `<div title="${s.id}">${iconSvg(s, colour[order[(i * 5) % order.length]], 24)}</div>`,
    ).join("");
    return (
      `<div style="background:${t.bg};color:${t.text};width:560px;padding:20px 24px;border-radius:14px">` +
      `<div class="name" style="color:${t.quiet};margin-bottom:6px">Chat list · 40px</div>${list}` +
      `<div style="display:flex;gap:28px;margin-top:22px"><div style="width:180px;background:${t.side};border-radius:10px;padding:8px 10px">` +
      `<div style="color:${t.quiet};margin-bottom:4px">Sidebar · 24px</div>${side}</div>` +
      `<div style="flex:1"><div style="color:${t.quiet};margin-bottom:10px">All ${SHAPES.length} at 24px</div>` +
      `<div style="display:grid;grid-template-columns:repeat(8,24px);gap:14px 15px">${all}</div></div></div></div>`
    );
  };
  const width = 80 + 2 * 560 + 32;
  const height = 72 + 20 + 40 + 8 * 64 + 22 + 300 + 70;
  shoot(
    "real-size",
    width,
    height,
    page(
      width,
      height,
      `<h1>At real size</h1><div class="about">Light and dark grounds from the app's tokens.</div>` +
        `<div style="display:flex;gap:32px;margin-top:20px">${panel(LIGHT)}${panel(DARK)}</div>`,
    ),
  );
}
