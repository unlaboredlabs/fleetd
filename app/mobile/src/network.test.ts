import { describe, expect, it } from "vitest";
import { networkNudges } from "./network";

describe("network changes", () => {
  it("nudge the link on a move to another network, or back onto one, never for the one it started on", () => {
    let nudges = 0;
    const seen = networkNudges(() => nudges++);
    seen({ type: "WIFI", isConnected: true, isInternetReachable: true });
    seen({ type: "WIFI", isConnected: true, isInternetReachable: true });
    expect(nudges).toBe(0);
    seen({ type: "CELLULAR", isConnected: true, isInternetReachable: true });
    expect(nudges).toBe(1);
    // Gone, then back: only coming back dials.
    seen({ type: "NONE", isConnected: false, isInternetReachable: false });
    expect(nudges).toBe(1);
    seen({ type: "CELLULAR", isConnected: true });
    expect(nudges).toBe(2);
    // A hotel Wi-Fi with no internet yet, then with it.
    seen({ type: "WIFI", isConnected: true, isInternetReachable: false });
    expect(nudges).toBe(2);
    seen({ type: "WIFI", isConnected: true, isInternetReachable: true });
    expect(nudges).toBe(3);
  });
});
