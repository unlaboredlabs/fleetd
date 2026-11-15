// The screens' one question of the shell seam (web.ts), and what it changes: on the web, pairing a hub is never a way.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHash } from "../screens/shell/routes";
import { hubLine } from "../screens/shell/youMenu";
import { onWeb } from "./web";

const refused = { phase: "refused", hub: "https://acme.fleetd.dev", message: "unauthorized" } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onWeb", () => {
  it("is the desktop without a bridge or without `shell`, as tests and older bridges have it", () => {
    expect(onWeb()).toBe(false);
    vi.stubGlobal("window", {});
    expect(onWeb()).toBe(false);
    vi.stubGlobal("window", { fleetd: { platform: "linux" } });
    expect(onWeb()).toBe(false);
    vi.stubGlobal("window", { fleetd: { shell: "desktop" } });
    expect(onWeb()).toBe(false);
  });

  it("sends the pairing screen home and a refused key to Sign in, on the web only", () => {
    vi.stubGlobal("window", { fleetd: { shell: "desktop" } });
    expect(parseHash("#/onboarding?add").id).toBe("onboarding");
    expect(hubLine(refused, "acme", null, 0).action).toBe("Pair again");
    vi.stubGlobal("window", { fleetd: { shell: "web" } });
    expect(onWeb()).toBe(true);
    expect(parseHash("#/onboarding?add").id).toBe("home");
    expect(hubLine(refused, "acme", null, 0).action).toBe("Sign in again");
  });
});
