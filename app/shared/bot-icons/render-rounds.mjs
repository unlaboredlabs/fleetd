// Renders the polished Rounds into out/: a sheet per finish, a close-up of the three finishes, and the Rounds at real
// size in light and dark. Run: node app/shared/bot-icons/render-rounds.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE } from "./palette.mjs";
import { FINISHES, ROUNDS, roundSvg } from "./rounds.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(out, { recursive: true });

const colour = Object.fromEntries(PALETTE.map((c) => [c.id, c]));
const being = Object.fromEntries(ROUNDS.map((b) => [b.id, b]));
const SHOWN = ["fleet", "sun", "mint"];

const LIGHT = { bg: "#ffffff", side: "#f5f5f3", text: "#1c1c1a", quiet: "#63635d", faint: "#96968f", line: "#e6e6e2" };
const DARK = { bg: "#1c1c1b", side: "#232322", text: "#ededea", quiet: "#ababa5", faint: "#74746e", line: "#323230" };

const page = (width, height, body) => `<!doctype html><meta charset="utf-8"><style>
* { box-sizing: border-box; margin: 0; }
body { width: ${width}px; height: ${height}px; overflow: hidden; background: ${LIGHT.side}; color: ${LIGHT.text};
  font: 14px/1.35 "Noto Sans", "Liberation Sans", sans-serif; padding: 36px 40px; }
h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
.about { color: ${LIGHT.quiet}; margin-top: 4px; }
.num { font-weight: 600; }
.name { color: ${LIGHT.quiet}; }
.new { color: #2360c4; font-size: 12px; font-weight: 600; }
svg { display: block; }
</style>${body}`;

function shoot(name, width, height, html) {
  const file = join(out, `${name}.html`);
  writeFileSync(file, html);
  execFileSync(
    "google-chrome",
    ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", `--window-size=${width},${height}`, `--screenshot=${join(out, `${name}.png`)}`, `file://${file}`],
    { stdio: "ignore" },
  );
}

const label = (b) => `<span class="num">${b.id}</span> ${b.name}${b.fresh ? ` <span class="new">new</span>` : ""}<div class="name">${b.mood}</div>`;

// One sheet per finish: every Round at 120px in three colours.
for (const [n, f] of FINISHES.entries()) {
  const width = 80 + 90 + ROUNDS.length * 140;
  const height = 72 + 70 + SHOWN.length * 140 + 36;
  const head = ROUNDS.map((b) => `<div style="width:140px">${label(b)}</div>`).join("");
  const rows = SHOWN.map(
    (c) =>
      `<div style="display:flex;align-items:center;height:140px"><div class="name" style="width:90px">${colour[c].name}</div>` +
      ROUNDS.map((b) => `<div style="width:140px">${roundSvg(b, colour[c], 120, f.id)}</div>`).join("") +
      `</div>`,
  ).join("");
  shoot(
    `rounds-${n + 1}-${f.id}`,
    width,
    height,
    page(width, height, `<h1>${n + 1} · ${f.name}</h1><div class="about">${f.about}</div><div style="display:flex;margin:24px 0 6px 90px">${head}</div>${rows}`),
  );
}

// A close-up: three Rounds at 200px in each finish, to see the craft.
{
  const picks = [
    ["A1", "fleet"],
    ["A6", "sun"],
    ["A9", "mint"],
  ];
  const width = 80 + 150 + picks.length * 230;
  const height = 72 + 40 + FINISHES.length * 230 + 20;
  const rows = FINISHES.map(
    (f, n) =>
      `<div style="display:flex;align-items:center;height:230px"><div style="width:150px"><span class="num">${n + 1}</span> ${f.name}</div>` +
      picks.map(([id, c]) => `<div style="width:230px">${roundSvg(being[id], colour[c], 200, f.id)}</div>`).join("") +
      `</div>`,
  ).join("");
  shoot("rounds-closeup", width, height, page(width, height, `<h1>The three finishes, up close</h1><div class="about">A1 Mo in Fleet, A6 Wink in Sun, A9 Wow in Mint, at 200px.</div><div style="margin-top:16px">${rows}</div>`));
}

// Real size: per finish, a few chat rows at 40px and every Round at 24px, on light and dark.
{
  const chats = [
    ["A1", "fleet", "site", "Showcase clips render at 60 fps now."],
    ["A6", "sun", "Scout", "Booked the venue for Thursday, the invite is out."],
    ["A3", "mint", "relay", "Push relay is up: apns and fcm both true."],
  ];
  const panel = (t) =>
    `<div style="background:${t.bg};color:${t.text};width:540px;padding:18px 24px 8px;border-radius:14px">` +
    FINISHES.map(
      (f, n) =>
        `<div style="color:${t.quiet};margin-bottom:2px">${n + 1} · ${f.name}</div>` +
        chats
          .map(
            ([id, c, name, line]) =>
              `<div style="display:flex;gap:12px;align-items:center;height:56px;border-bottom:1px solid ${t.line}">${roundSvg(being[id], colour[c], 40, f.id)}` +
              `<div style="min-width:0"><div style="font-weight:600">${name}</div><div style="color:${t.quiet};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${line}</div></div></div>`,
          )
          .join("") +
        `<div style="display:flex;gap:14px;margin:12px 0 22px">${ROUNDS.map((b, i) => roundSvg(b, colour[SHOWN[i % 3]], 24, f.id)).join("")}</div>`,
    ).join("") +
    `</div>`;
  const width = 80 + 2 * 540 + 32;
  const height = 72 + 20 + 26 + FINISHES.length * (22 + 3 * 56 + 58) + 40;
  shoot(
    "rounds-real-size",
    width,
    height,
    page(width, height, `<h1>At real size</h1><div class="about">40px chat rows and 24px icons, on the app's light and dark grounds.</div><div style="display:flex;gap:32px;margin-top:20px">${panel(LIGHT)}${panel(DARK)}</div>`),
  );
}
