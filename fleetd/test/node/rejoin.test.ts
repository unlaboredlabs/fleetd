// A node moving with its hub (src/node/rejoin.ts): the hub's ask checked, the enrolment at the new hub on a link of its
// own with the same identity key and the code, a refusal or a hub not reached said plainly, and node.json naming the
// new hub only once it has enrolled there.
import { expect, test } from "bun:test";
import { loadOrCreateIdentity } from "../../src/node/identity.ts";
import { enrolAt, movedConfig, readRejoin } from "../../src/node/rejoin.ts";
import type { NodeConfig } from "../../src/node/config.ts";
import { tempHome } from "../helpers.ts";

const config: NodeConfig = { hub: "http://127.0.0.1:4790", machineId: "devbox", name: "devbox", enrolled: true };

/** A hub that welcomes each hello (or closes with `refuse`), keeping every hello it got. */
function fakeHub(refuse?: [number, string]) {
  const hellos: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open: (ws) => void ws.send(JSON.stringify({ t: "challenge", nonce: "nonce-1" })),
      message(ws, data) {
        const frame = JSON.parse(String(data));
        if (frame.t !== "hello") return;
        hellos.push(frame);
        if (refuse) return ws.close(refuse[0], refuse[1]);
        ws.send(JSON.stringify({ t: "welcome", hubId: "fleetd-team", protocol: 1, capabilities: [] }));
      },
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hellos, stop: () => server.stop(true) };
}

test("the hub's ask is a team's address and a code, never this machine's own hub", () => {
  expect(readRejoin({ hub: "https://acme.fleetd.dev", code: "fle_abcdefgh123" }, config.hub)).toEqual({ hub: "https://acme.fleetd.dev", code: "fle_abcdefgh123" });
  expect(readRejoin({ hub: "http://acme.fleetd.dev", code: "fle_abcdefgh123" }, config.hub)).toBe("the new hub's address isn't one");
  expect(readRejoin({ hub: "https://acme.fleetd.dev/x?y", code: "fle_abcdefgh123" }, config.hub)).toBe("the new hub's address isn't one");
  expect(readRejoin({ hub: "https://acme.fleetd.dev", code: "a b" }, config.hub)).toBe("the code isn't one");
  expect(readRejoin({ hub: "http://127.0.0.1:4790", code: "fle_abcdefgh123" }, config.hub)).toBe("that is this machine's hub already");
  expect(readRejoin(undefined, config.hub)).toBe("the new hub's address isn't one");
});

test("the node enrols at the new hub with its own key and the code, and node.json then names that hub", async () => {
  const home = tempHome();
  const hub = fakeHub();
  try {
    const identity = loadOrCreateIdentity(home.dir);
    const out = await enrolAt({ hub: hub.url, code: "fle_code12345" }, { config, identity, nodeVersion: "1.2.3" });
    expect(out).toEqual({ ok: true });
    expect(hub.hellos[0]).toMatchObject({ machineId: "devbox", enrollToken: "fle_code12345", pubKey: identity.pubKey() });
    expect(movedConfig({ ...config, removed: true }, hub.url)).toEqual({ hub: hub.url, machineId: "devbox", name: "devbox", enrolled: true });
  } finally {
    hub.stop();
    home.done();
  }
});

test("a code the new hub refuses is said, and the node stays on its hub", async () => {
  const home = tempHome();
  const hub = fakeHub([4001, "invalid, used or expired enroll token"]);
  try {
    const out = await enrolAt({ hub: hub.url, code: "fle_code12345" }, { config, identity: loadOrCreateIdentity(home.dir), nodeVersion: "1.2.3" });
    expect(out).toEqual({ ok: false, message: "the new hub refused it: invalid, used or expired enroll token" });
  } finally {
    hub.stop();
    home.done();
  }
});

test("a new hub that doesn't answer is given up on, the node staying on its hub", async () => {
  const home = tempHome();
  try {
    const out = await enrolAt({ hub: "http://127.0.0.1:9", code: "fle_code12345" }, { config, identity: loadOrCreateIdentity(home.dir), nodeVersion: "1.2.3", waitMs: 300 });
    expect(out).toEqual({ ok: false, message: "the new hub didn't answer within a minute" });
  } finally {
    home.done();
  }
});
