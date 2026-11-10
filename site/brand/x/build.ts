// Renders fleetd's X pictures from their sources (designs.ts) with headless Chrome, each at its exact size:
//
//   bun site/brand/x/build.ts
//
// It writes, beside itself, avatar-1024.png (the master), avatar-400.png (what X takes) and banner.png (1500×500).
// CHROME names the browser when it isn't `google-chrome`.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { avatar, banner } from "./designs";

const CHROME = process.env["CHROME"] ?? "google-chrome";

/** A page's screenshot, `width`×`height` px, as `name` beside this file. */
const shoot = (html: string, name: string, width: number, height: number): void => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleetd-x-"));
  try {
    const src = path.join(dir, "page.html");
    writeFileSync(src, html);
    const run = spawnSync(
      CHROME,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-color-profile=srgb",
        `--user-data-dir=${path.join(dir, "profile")}`,
        `--window-size=${String(width)},${String(height)}`,
        "--virtual-time-budget=2000",
        `--screenshot=${path.join(import.meta.dirname, name)}`,
        `file://${src}`,
      ],
      { encoding: "utf8" },
    );
    if (run.status !== 0) throw new Error(`chrome failed on ${name}: ${run.stderr}`);
    console.log(name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** An SVG as a page that fills its window. */
const svgPage = (svg: string): string => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden}svg{display:block;width:100%;height:100%}</style>${svg}`;

shoot(svgPage(avatar), "avatar-1024.png", 1024, 1024);
shoot(svgPage(avatar), "avatar-400.png", 400, 400);
shoot(banner, "banner.png", 1500, 500);
