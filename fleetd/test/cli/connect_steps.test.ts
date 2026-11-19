// `fleetd init`'s own Tailscale and Claude steps against a stand-in hub client: Connect shows Tailscale's sign-in page
// and waits for it, and the hub's API key is sealed here to each machine (never the agents' Mac), with Anthropic's own
// endpoint kept as none; an endpoint on the tailnet while Tailscale isn't connected says so and offers Connect.
import { expect, test } from "bun:test";
import { boxesOf, claudeKey, connectTailscale, endpointProblem, keyOf, sealTo } from "../../src/cli/setup/connect_steps.ts";
import { Checklist } from "../../src/cli/setup/checklist.ts";
import type { Ui } from "../../src/cli/setup/wizard.ts";
import type { McpClient } from "../../src/cli/mcp_client.ts";
import { openSealed, publicKeyOf } from "../../src/shared/sealed_box.ts";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const secretA = new Uint8Array(32).fill(7);
const secretB = new Uint8Array(32).fill(9);
const machines = [
  { machineId: "devbox", boxPubKey: b64(publicKeyOf(secretA)) },
  { machineId: "hosted", boxPubKey: b64(publicKeyOf(secretB)), runner: true },
  { machineId: "mac", boxPubKey: b64(publicKeyOf(secretB)), agentsMac: true },
  { machineId: "old" },
];

/** A hub that answers `tools` in turn per tool, recording each call. */
function hub(tools: Record<string, unknown[]>) {
  const calls: [string, any][] = [];
  const client = {
    callTool: async (tool: string, input: unknown) => {
      calls.push([tool, input]);
      const answers = tools[tool];
      if (answers === undefined || answers.length === 0) throw new Error(`${tool} not found`);
      return { isError: false, body: answers.length > 1 ? answers.shift() : answers[0] };
    },
  } as unknown as McpClient;
  return { client, calls };
}

const ui = (answers: { endpoint?: string; key?: string; confirm?: boolean }): Ui =>
  ({
    interactive: true,
    input: async (_l: unknown, _p: string, fallback: string) => answers.endpoint ?? fallback,
    secret: async () => answers.key ?? "",
    confirm: async () => answers.confirm ?? false,
  }) as unknown as Ui;

test("the key is sealed to each machine's box key, the agents' Mac never; a pasted line is trimmed", () => {
  const boxes = boxesOf(machines);
  expect(boxes.map((b) => b.machineId)).toEqual(["devbox", "hosted"]);
  const sealed = sealTo(boxes, "sk-ant-api03-standin");
  expect(new TextDecoder().decode(openSealed(secretA, Buffer.from(sealed[0]!.sealed, "base64"))!)).toBe("sk-ant-api03-standin");
  expect(new TextDecoder().decode(openSealed(secretB, Buffer.from(sealed[1]!.sealed, "base64"))!)).toBe("sk-ant-api03-standin");
  expect(keyOf(' "sk-ant-api03-x"\n')).toBe("sk-ant-api03-x");
  expect(keyOf("two words")).toBeUndefined();
  expect(keyOf("")).toBeUndefined();
  expect(endpointProblem("http://100.104.249.49:8317")).toBeUndefined();
  expect(endpointProblem("100.104.249.49:8317")).toBe("an http:// or https:// URL");
});

test("Anthropic's own endpoint, as prefilled, is saved as none", async () => {
  const { client, calls } = hub({ fleetd_status: [{ machines }], claude_hub_api_set: [{}] });
  expect(await claudeKey(ui({ key: "sk-ant-api03-standin" }), new Checklist(), client)).toBe(true);
  const set = calls.find(([t]) => t === "claude_hub_api_set")?.[1];
  expect(set.endpoint).toBeUndefined();
  expect(set.sealed.map((s: { machineId: string }) => s.machineId)).toEqual(["devbox", "hosted"]);
  expect(JSON.stringify(calls)).not.toContain("sk-ant-api03-standin");
  expect(calls.some(([t]) => t === "tailnet_get")).toBe(false);
});

test("a tailnet endpoint with Tailscale off says so and offers Connect, which shows the sign-in page and waits for it", async () => {
  const { client, calls } = hub({
    fleetd_status: [{ machines }],
    claude_hub_api_set: [{}],
    tailnet_get: [{ status: "off" }, { status: "login", loginUrl: "https://login.tailscale.com/a/standin" }, { status: "connected", tailnet: "acme.com", device: "fleetd-devbox" }],
    tailnet_connect: [{ status: "login", loginUrl: "https://login.tailscale.com/a/standin" }],
  });
  const list = new Checklist();
  const said: string[] = [];
  list.note = (t: string) => void said.push(t);
  list.warn = (_t: string, d: string) => void said.push(d);
  const orig = Bun.sleep;
  (Bun as { sleep: unknown }).sleep = async () => undefined;
  try {
    expect(await claudeKey(ui({ endpoint: "http://100.104.249.49:8317/", key: "sk-ant-api03-standin", confirm: true }), list, client)).toBe(true);
  } finally {
    (Bun as { sleep: unknown }).sleep = orig;
  }
  expect(calls.find(([t]) => t === "claude_hub_api_set")?.[1].endpoint).toBe("http://100.104.249.49:8317");
  expect(said[0]).toBe("This endpoint is on your tailnet. Hosted agents reach it once Tailscale is connected.");
  expect(said[1]).toContain("https://login.tailscale.com/a/standin");
  expect(calls.filter(([t]) => t === "tailnet_connect")).toHaveLength(1);
});

test("Connect on a hub already connected says so at once", async () => {
  const { client } = hub({ tailnet_connect: [{ status: "connected", tailnet: "acme.com" }] });
  expect(await connectTailscale(ui({}), new Checklist(), client)).toBe(true);
});

test("no key typed saves nothing", async () => {
  const { client, calls } = hub({});
  expect(await claudeKey(ui({ key: "" }), new Checklist(), client)).toBe(false);
  expect(calls).toEqual([]);
});
