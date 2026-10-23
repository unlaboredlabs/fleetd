// FLEETD_DEMO_TYPE=<order> (tests/lab/demoFanout.ts, scripts/demo-mac.sh): once the composer is ready, opens the
// recording's clip, then types the order into the composer at a person's pace and sends it with Enter. The keys go
// through Chromium's input pipeline (sendInputEvent), as a person's would, so the composer needs no demo code.
//
// The contract with the composer: its input is the textarea under [data-composer], and Enter sends.
import type { BrowserWindow } from "electron";
import { keyDelayMs } from "./recordConfig";

const COMPOSER = "[data-composer] textarea";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Focuses the ready composer; false while there is none. */
const focusComposer = (win: BrowserWindow): Promise<boolean> =>
  win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(COMPOSER)}); if (!(el instanceof HTMLElement)) return false; el.focus(); return document.activeElement === el; })()`,
  ) as Promise<boolean>;

export const demoType = async (win: BrowserWindow, text: string, clipStart: () => void): Promise<void> => {
  while (!(await focusComposer(win).catch(() => false))) {
    if (win.isDestroyed()) return;
    await sleep(100);
  }
  // The screen settles first; the clip opens on it half a second before the first key.
  await sleep(1000);
  clipStart();
  await sleep(500);
  console.error(`FLEETD_DEMO typing chars=${Array.from(text).length}`);
  win.webContents.focus();
  await focusComposer(win);
  let index = 0;
  for (const ch of text) {
    if (win.isDestroyed()) return;
    win.webContents.sendInputEvent({ type: "char", keyCode: ch });
    await sleep(keyDelayMs(index, ch));
    index += 1;
  }
  await sleep(700);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  console.error("FLEETD_DEMO sent");
};
