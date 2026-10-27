// The task profiles' settings as Settings edits them: what a draft sends, and what an empty field follows.
import { describe, expect, it } from "vitest";
import type { ProfilesGetOutput } from "../../../shared/contracts";
import { changed, draftOf, follows, runLine, settingFrom } from "./profilesModel";

const view: ProfilesGetOutput = {
  fleet: { high: { model: "claude-sonnet-5-5", effort: "max" }, medium: { model: "claude-nope", refused: "claude on devbox refused claude-nope" } },
  project: { high: {}, medium: {} },
  runs: { high: { model: "claude-sonnet-5-5", effort: "max" }, medium: { model: "claude-opus-5-5", effort: "medium" } },
  defaults: { high: { model: "claude-opus-5-5", effort: "high" }, medium: { model: "claude-opus-5-5", effort: "medium" } },
};

describe("profile settings", () => {
  it("send only the fields set", () => {
    expect(settingFrom({ model: "", effort: "default" })).toEqual({ ok: true, setting: {} });
    expect(settingFrom({ model: " claude-fable-5-1 ", effort: "low" })).toEqual({ ok: true, setting: { model: "claude-fable-5-1", effort: "low" } });
    expect(settingFrom({ model: "claude-opus-5-5[1m]", effort: "default" })).toEqual({ ok: true, setting: { model: "claude-opus-5-5[1m]" } });
    const bad = settingFrom({ model: "claude opus", effort: "default" });
    expect(bad.ok).toBe(false);
  });

  it("read a saved setting back, its refusal left out", () => {
    const saved = view.fleet.medium;
    expect(draftOf(saved)).toEqual({ model: "claude-nope", effort: "default" });
    expect(changed({ model: "claude-nope", effort: "default" }, saved)).toBe(false);
    expect(changed({ model: "claude-nope", effort: "max" }, saved)).toBe(true);
    expect(changed({ model: "", effort: "default" }, undefined)).toBe(false);
  });

  it("follow the fleet's from a project, the own from the fleet, never a refused model", () => {
    expect(follows(view, "high", true)).toEqual({ model: "claude-sonnet-5-5", effort: "max" });
    expect(follows(view, "high", false)).toEqual({ model: "claude-opus-5-5", effort: "high" });
    expect(follows(view, "medium", true)).toEqual({ model: "claude-opus-5-5", effort: "medium" });
    expect(runLine(view.runs.high)).toBe("claude-sonnet-5-5 at max effort");
  });
});
