// The share sheet draws each bot as the app does at rest (BotLook.swift, from botLook.ts): the file is what the
// desktop's shared/bot.ts gives today, so a new shape, color or eye change reaches the sheet too.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { botLookSwift, restEyes, SIZES } from "./botLook";

const FILE = join(__dirname, "BotLook.swift");

describe("the share sheet's bots", () => {
  it("are the app's bots: BotLook.swift is what botLook.ts makes of shared/bot.ts", () => {
    if (process.env.UPDATE_BOT_LOOK === "1") writeFileSync(FILE, botLookSwift());
    expect(readFileSync(FILE, "utf8")).toBe(botLookSwift());
  });

  it("rest still, the same eyes whatever the bot's seed, at each size the sheet draws", () => {
    for (const box of SIZES) for (const seed of [99, 12345]) expect(restEyes(box, seed)).toEqual(restEyes(SIZES[0]));
    // Drawn only with the commands the sheet reads (PathData in Shared.swift).
    for (const box of SIZES) for (const d of restEyes(box)) expect(d).toMatch(/^M[\d.\s-]+(C[\d.\s-]+)+Z$/u);
  });
});
