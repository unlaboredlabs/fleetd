import { describe, expect, it } from "vitest";
import type { Profile, ProfileModel } from "./contracts/contracts";
import { byProvider, googleConnected, googleWords, modelShort, profileNameFor, providerOf, runsWords } from "./agentProviders";

const MODELS: ProfileModel[] = [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", fast: true },
  { id: "gemini-4-neon", displayName: "Gemini 4 Neon (Antigravity)", fast: false },
  { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", fast: false },
  { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash (Antigravity)", fast: false },
];
const devbox = { machineId: "devbox", projectId: "storefront" };

describe("agent providers", () => {
  it("tells each model's provider: Gemini and any antigravity/ model are Google's, the rest Anthropic's", () => {
    expect(["claude-opus-5-5", "gemini-4-neon", "antigravity/claude-opus-5-5", "some-new-model"].map((m) => providerOf(m).id)).toEqual(["anthropic", "google", "google", "anthropic"]);
  });

  it("groups by provider in the providers' order, each in the order given, and names Google's without (Antigravity)", () => {
    expect(byProvider(MODELS, (m) => m.id).map((g) => [g.provider.name, ...g.items.map(modelShort)])).toEqual([
      ["Anthropic", "Claude Opus 5.5", "Claude Sonnet 5.5"],
      ["Google", "Gemini 4 Neon", "Gemini 3.8 Flash"],
    ]);
    expect(byProvider(MODELS.slice(0, 1), (m) => m.id).map((g) => g.provider.id)).toEqual(["anthropic"]);
  });

  it("says what a provider runs, the first few then how many more", () => {
    expect(runsWords(MODELS, "google")).toBe("Gemini 4 Neon · Gemini 3.8 Flash");
    expect(runsWords(MODELS, "anthropic", 1)).toBe("Claude Opus 5.5 · 1 more");
    expect(runsWords([], "google")).toBe("");
  });

  it("knows Google connected once a machine is signed in or a bot holds a key, not while a machine couldn't say", () => {
    expect(googleConnected(undefined)).toBe("unknown");
    expect(googleConnected({ machines: [{ machineId: "devbox", checked: true }], keyIn: [] })).toBe("no");
    expect(googleConnected({ machines: [{ machineId: "devbox", checked: false }], keyIn: [] })).toBe("unknown");
    expect(googleConnected({ machines: [{ machineId: "devbox", checked: true, signedIn: "Google AI Pro" }], keyIn: [] })).toBe("yes");
    const keyed = { machines: [{ machineId: "devbox", checked: true }], keyIn: [devbox] };
    expect(googleConnected(keyed)).toBe("yes");
    // A bot's key is that bot's alone.
    expect(googleConnected(keyed, devbox)).toBe("yes");
    expect(googleConnected(keyed, { machineId: "devbox", projectId: "billing" })).toBe("no");
    // The team's key is every bot's.
    const team = { machines: [{ machineId: "devbox", checked: true }], keyIn: [], teamKey: { sealedOn: [{ machineId: "devbox", fingerprint: "ab12" }], updatedAt: "2026-11-22T10:00:00.000Z" } };
    expect(googleConnected(team, { machineId: "devbox", projectId: "billing" })).toBe("yes");
    expect(googleConnected({ ...team, teamKey: { ...team.teamKey, sealedOn: [] } })).toBe("no");
  });

  it("says how Google is connected in a few words", () => {
    expect(googleWords(undefined)).toBeUndefined();
    expect(googleWords({ machines: [{ machineId: "devbox", checked: true }], keyIn: [] })).toBeUndefined();
    expect(googleWords({ machines: [{ machineId: "devbox", checked: true, signedIn: "Google AI Pro" }], keyIn: [devbox, devbox] })).toBe("Signed in · Google AI Pro · API key in 2 bots");
    expect(googleWords({ machines: [], keyIn: [devbox] })).toBe("API key in 1 bot");
    expect(googleWords({ machines: [], keyIn: [devbox], teamKey: { sealedOn: [], updatedAt: "2026-11-22T10:00:00.000Z" } })).toBe("API key");
  });

  it("names a profile made from a model after it, past the names taken", () => {
    const taken = (...names: string[]): Pick<Profile, "name">[] => names.map((name) => ({ name }));
    expect(profileNameFor("gemini-4-neon", taken("high"))).toBe("gemini-4-neon");
    expect(profileNameFor("gemini-4-neon", taken("gemini-4-neon", "gemini-4-neon-2"))).toBe("gemini-4-neon-3");
    // Any model Antigravity offers: its own name, as a profile name takes it.
    expect(profileNameFor("antigravity/Claude Opus 5.5", [])).toBe("claude-opus-5.5");
  });
});
