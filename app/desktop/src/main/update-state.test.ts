import { describe, expect, it } from "vitest";
import type { AppUpdate } from "../shared/updates";
import { step, type UpdateInput } from "./update-state";

const run = (inputs: readonly UpdateInput[], deb = false, from: AppUpdate = { kind: "idle" }) => {
  let app = from;
  const effects: string[] = [];
  for (const input of inputs) {
    const [next, effect] = step({ app, deb }, input);
    app = next;
    if (effect !== null) effects.push(effect);
  }
  return { app, effects };
};

describe("the app update", () => {
  it("shows a background check only once it finds something", () => {
    expect(run([{ type: "check", manual: false }]).app).toEqual({ kind: "idle" });
    expect(run([{ type: "check", manual: false }, { type: "none" }]).app).toEqual({ kind: "current" });
    expect(run([{ type: "check", manual: true }]).app).toEqual({ kind: "checking" });
  });

  it("downloads, then offers the restart with what's new", () => {
    const { app, effects } = run([
      { type: "check", manual: false },
      { type: "available", version: "0.6.0" },
      { type: "notes", notes: ["Updates show in the app"] },
      { type: "progress", percent: 41.7 },
    ]);
    expect(app).toEqual({ kind: "available", version: "0.6.0", notes: ["Updates show in the app"], percent: 41, restart: false });
    expect(effects).toEqual([]);
    expect(run([{ type: "downloaded", version: "0.6.0" }], false, app)).toEqual({
      app: { kind: "ready", version: "0.6.0", notes: ["Updates show in the app"] },
      effects: [],
    });
  });

  it("restarts the moment the download is in once asked, and not once taken back", () => {
    const asked = run([{ type: "available", version: "0.6.0" }, { type: "install" }, { type: "downloaded", version: "0.6.0" }]);
    expect(asked.effects).toEqual(["quit-and-install"]);
    const kept = run([{ type: "available", version: "0.6.0" }, { type: "install" }, { type: "keep" }, { type: "downloaded", version: "0.6.0" }]);
    expect(kept.effects).toEqual([]);
    expect(run([{ type: "install" }], false, kept.app).effects).toEqual(["quit-and-install"]);
  });

  it("keeps a ready update offered while a newer one downloads", () => {
    const ready: AppUpdate = { kind: "ready", version: "0.6.0", notes: [] };
    expect(run([{ type: "check", manual: true }, { type: "available", version: "0.7.0" }], false, ready).app).toBe(ready);
    expect(run([{ type: "downloaded", version: "0.7.0" }], false, ready).app).toEqual({ kind: "ready", version: "0.7.0", notes: [] });
  });

  it("says a failure only for a download or an asked-for check", () => {
    const reason = "The release server didn't answer. Check your connection and try again.";
    expect(run([{ type: "check", manual: false }, { type: "error", reason }], false, { kind: "current" }).app).toEqual({ kind: "current" });
    expect(run([{ type: "check", manual: true }, { type: "error", reason }]).app).toEqual({ kind: "failed", during: "check", reason });
    expect(run([{ type: "available", version: "0.6.0" }, { type: "error", reason }]).app).toEqual({ kind: "failed", during: "download", reason });
    expect(run([{ type: "error", reason }], false, { kind: "ready", version: "0.6.0", notes: [] }).app.kind).toBe("ready");
  });

  it("offers the deb's download instead of downloading it", () => {
    const { app, effects } = run([{ type: "available", version: "0.6.0" }, { type: "install" }], true);
    expect(app).toEqual({ kind: "manual", version: "0.6.0", notes: [] });
    expect(effects).toEqual(["open-download"]);
  });
});
