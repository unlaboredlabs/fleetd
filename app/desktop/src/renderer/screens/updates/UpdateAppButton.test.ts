import { describe, expect, it } from "vitest";
import { appButton } from "./UpdateAppButton";

describe("the app's one Update button", () => {
  it("checks, downloads and restarts, saying which as it goes", () => {
    expect(appButton(undefined, false)).toEqual({ label: "Update the app", busy: false });
    expect(appButton({ kind: "checking" }, true)).toEqual({ label: "Checking for an update…", busy: true });
    expect(appButton({ kind: "available", version: "0.9.3", percent: 40, restart: false }, true)).toEqual({ label: "Downloading 40%", busy: true });
    expect(appButton({ kind: "available", version: "0.9.3", percent: null, restart: false }, false)).toEqual({ label: "Update the app", busy: false });
    expect(appButton({ kind: "ready", version: "0.9.3" }, false)).toEqual({ label: "Restart to update", busy: false });
    expect(appButton({ kind: "manual", version: "0.9.3" }, false)).toEqual({ label: "Download the update", busy: false });
  });

  it("never leaves the person stuck: nothing newer yet checks again when pressed", () => {
    expect(appButton({ kind: "current" }, true)).toEqual({ label: "No newer app yet: check again", busy: false });
    expect(appButton({ kind: "failed", during: "check", reason: "offline" }, true).busy).toBe(false);
  });
});
