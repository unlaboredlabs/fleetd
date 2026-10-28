import { describe, expect, it } from "vitest";
import { pair, type Fetch } from "./pair";

const answering =
  (status: number, body: unknown, seen: Array<{ url: string; body: unknown }> = []): Fetch =>
  async (url, init) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };

describe("pair", () => {
  it("trades a code for a key at the typed hub's /pair, over plain HTTP", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const result = await pair(answering(200, { key: "key_1", hubUrl: "http://elsewhere:4790", hubName: "devbox" }, seen), "devbox:4790", "abcd 2345", "Pixel");
    expect(result).toEqual({ ok: true, paired: { hub: "http://devbox:4790", key: "key_1", hubName: "devbox" } });
    expect(seen).toEqual([{ url: "http://devbox:4790/pair", body: { code: "ABCD-2345", deviceName: "Pixel" } }]);
  });

  it("refuses a code that can't be one before asking the hub", async () => {
    const result = await pair(answering(200, {}), "devbox:4790", "nope", "Pixel");
    expect(result).toMatchObject({ ok: false, failure: { message: expect.stringContaining("8 letters and digits") } });
  });

  it("passes on the hub's own words", async () => {
    const result = await pair(answering(400, { code: "pair_code_expired", message: "That code expired.", fix: "Run fleetd pair again." }), "http://devbox:4790", "ABCD2345", "Pixel");
    expect(result).toEqual({ ok: false, failure: { code: "pair_code_expired", message: "That code expired.", fix: "Run fleetd pair again." } });
  });

  it("says when nothing answers", async () => {
    const down: Fetch = () => Promise.reject(new TypeError("Network request failed"));
    const result = await pair(down, "http://devbox:4790", "ABCD2345", "Pixel");
    expect(result).toMatchObject({ ok: false, failure: { message: "Can't reach http://devbox:4790." } });
  });

  it("refuses an answer that isn't a hub's", async () => {
    const result = await pair(answering(200, { hello: "world" }), "http://devbox:4790", "ABCD2345", "Pixel");
    expect(result).toMatchObject({ ok: false, failure: { message: "http://devbox:4790 answered, but not like a fleetd hub." } });
  });
});
