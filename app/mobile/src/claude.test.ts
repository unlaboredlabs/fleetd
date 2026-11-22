import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { boxesOf, claudeShown, endpointOk, geminiKeyWords, endpointShown, endpointToSave, keyOf, keyWords, sealEach, tailnetLine } from "./claude";
import { fromBase64, toBase64, utf8 } from "./bytes";
import { keyPairOf, openSealed } from "./seal";

const mine = keyPairOf(new Uint8Array(32).fill(3));
const box = toBase64(mine.publicKey);

describe("the phone's Claude row", () => {
  it("shows for admins only", () => {
    expect(claudeShown(true)).toBe(true);
    expect(claudeShown(false)).toBe(false);
    expect(claudeShown(undefined)).toBe(false);
  });

  it("seals the key to each machine that takes secrets, never the agents' Mac, so only that machine opens it", () => {
    const boxes = boxesOf([
      { machineId: "devbox", boxPubKey: box },
      { machineId: "mac", boxPubKey: box, agentsMac: true },
      { machineId: "old" },
      { machineId: "hosted", boxPubKey: box },
    ]);
    expect(boxes.map((b) => b.machineId)).toEqual(["devbox", "hosted"]);
    const sealed = sealEach("sk-ant-api03-standin", boxes, (n) => nacl.randomBytes(n));
    expect(sealed.map((s) => s.machineId)).toEqual(["devbox", "hosted"]);
    expect(utf8(openSealed(fromBase64(sealed[0]!.sealed)!, mine)!)).toBe("sk-ant-api03-standin");
    expect(JSON.stringify(sealed)).not.toContain("sk-ant");
  });

  it("takes one line as a key, and an http or https endpoint; Anthropic's own as prefilled is kept as none", () => {
    expect(keyOf(' "sk-ant-api03-x"\n')).toBe("sk-ant-api03-x");
    expect(keyOf("two words")).toBeNull();
    expect(endpointOk("http://100.104.249.49:8317")).toBe(true);
    expect(endpointOk("100.104.249.49:8317")).toBe(false);
    expect(endpointShown(undefined)).toBe("https://api.anthropic.com");
    expect(endpointToSave("https://api.anthropic.com")).toBeUndefined();
    expect(endpointToSave("http://100.104.249.49:8317/")).toBe("http://100.104.249.49:8317");
  });

  it("says so beside a tailnet endpoint while Tailscale isn't connected", () => {
    expect(tailnetLine("http://100.104.249.49:8317", false)).toBe("This endpoint is on your tailnet. Hosted agents reach it once Tailscale is connected.");
    expect(tailnetLine("http://100.104.249.49:8317", true)).toBeNull();
    expect(tailnetLine("https://api.anthropic.com", false)).toBeNull();
  });

  it("says where the key is and through what", () => {
    expect(keyWords(undefined)).toEqual({ value: "Not Set" });
    expect(keyWords({ sealedOn: [{ machineId: "devbox", fingerprint: "ab" }, { machineId: "hosted", fingerprint: "ab" }], updatedAt: "2026-11-19T00:00:00Z", endpoint: "http://100.104.249.49:8317" })).toEqual({
      value: "Set",
      footer: "Sealed on devbox, hosted sandboxes. Through http://100.104.249.49:8317.",
    });
    expect(keyWords({ sealedOn: [], updatedAt: "2026-11-19T00:00:00Z", lastTest: { at: "2026-11-19T00:00:00Z", machineId: "devbox", ok: false } }).value).toBe("Failed");
  });

  it("says where the team's Gemini key is sealed and through what, fleetd's computers by that name", () => {
    expect(geminiKeyWords(undefined)).toEqual({ value: "Not Set" });
    const key = { sealedOn: [{ machineId: "hosted", fingerprint: "ab" }, { machineId: "lab", fingerprint: "ab" }], updatedAt: "2026-11-22T10:00:00Z" };
    expect(geminiKeyWords(key)).toEqual({ value: "Set", footer: "Sealed on fleetd's computers, lab." });
    expect(geminiKeyWords({ ...key, sealedOn: [], endpoint: "https://gw.devbox.example" }).footer).toBe("On no machine yet. Through https://gw.devbox.example.");
  });
});
