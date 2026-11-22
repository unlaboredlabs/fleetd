// An Android screen's device controls (W804), through the emulator's own adb: a quarter turn left or right (rotation
// locked to the turn fleetd keeps, `settings put system user_rotation`, so the sensor never turns it back), Home and
// Back (`input keyevent`), and a screenshot (`screencap -p`). scrcpy's stream follows a turn with frames of the new
// shape by itself.
import type { ScreenControl, ScreenOrientation } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { ScreenDevice } from "../../shared/screens_wire.ts";
import { pngSize, type Shot } from "./ios/controls.ts";

export const ANDROID_CONTROLS: readonly ScreenControl[] = ["rotate_left", "rotate_right", "home", "back", "screenshot"];
/** Android's rotations, 0 to 3: each a quarter turn counter-clockwise from upright, a left turn of the device. */
const ORIENTATIONS: readonly ScreenOrientation[] = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"];

/** The adb commands `control` takes on an emulator at `rotation`, and the rotation after them. */
export function androidPlan(control: ScreenControl, rotation: number): { adb: string[][]; rotation: number } {
  switch (control) {
    case "rotate_left":
    case "rotate_right": {
      const next = (rotation + (control === "rotate_left" ? 1 : 3)) % 4;
      return {
        adb: [
          ["shell", "settings", "put", "system", "accelerometer_rotation", "0"],
          ["shell", "settings", "put", "system", "user_rotation", String(next)],
        ],
        rotation: next,
      };
    }
    case "home":
      return { adb: [["shell", "input", "keyevent", "KEYCODE_HOME"]], rotation };
    case "back":
      return { adb: [["shell", "input", "keyevent", "KEYCODE_BACK"]], rotation };
    case "screenshot":
      return { adb: [], rotation };
    default:
      throw new ToolError("invalid", `An Android screen has no ${control} control.`, `Its controls: ${ANDROID_CONTROLS.join(", ")}.`);
  }
}

/** adb on one emulator: a command's exit code and output, and screencap's bytes. */
export type Adb = {
  run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
  bytes(args: string[]): Promise<Uint8Array>;
};

/** One emulator's controls, and the turn fleetd keeps it at. */
export class AndroidDevice {
  private rotation = 0;
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly adb: Adb) {}

  report(): ScreenDevice {
    return { controls: [...ANDROID_CONTROLS], orientation: ORIENTATIONS[this.rotation]! };
  }

  /** Runs `control`, one at a time; a screenshot comes back as its PNG. */
  apply(control: ScreenControl): Promise<Shot | undefined> {
    const next = this.turn.then(() => this.now(control));
    this.turn = next.catch(() => {});
    return next;
  }

  private async now(control: ScreenControl): Promise<Shot | undefined> {
    const { adb, rotation } = androidPlan(control, this.rotation);
    for (const args of adb) {
      const ran = await this.adb.run(args);
      if (ran.code !== 0) throw new ToolError("failed", `The emulator's ${control} didn't go: ${(ran.stderr || ran.stdout).trim().slice(0, 300)}`);
    }
    this.rotation = rotation;
    if (control !== "screenshot") return undefined;
    const png = await this.adb.bytes(["exec-out", "screencap", "-p"]);
    const size = pngSize(png);
    if (!size) throw new ToolError("failed", "The emulator's screenshot didn't go: screencap wrote no PNG.");
    return { png, width: size[0], height: size[1] };
  }
}
