// `fleetd init`'s own Claude step against a stand-in hub client: the hub's API key is sealed here to each machine (never
// the agents' Mac), with Anthropic's own endpoint kept as none.
import { expect, test } from "bun:test";
import { boxesOf, claudeKey, endpointProblem, keyOf, sealTo } from "../../src/cli/setup/connect_steps.ts";
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
  expect(await claudeKey(ui({ key: "sk-ant-api03-standin" }), new Checklist(), client, (use) => use(client))).toBe(true);
  const set = calls.find(([t]) => t === "claude_hub_api_set")?.[1];
  expect(set.endpoint).toBeUndefined();
  expect(set.sealed.map((s: { machineId: string }) => s.machineId)).toEqual(["devbox", "hosted"]);
  expect(JSON.stringify(calls)).not.toContain("sk-ant-api03-standin");
  expect(calls.some(([t]) => t === "tailnet_get")).toBe(false);
});

test("no key typed saves nothing", async () => {
  const { client, calls } = hub({});
  expect(await claudeKey(ui({ key: "" }), new Checklist(), client, (use) => use(client))).toBe(false);
  expect(calls).toEqual([]);
});

test("the save speaks for the hub's owner, as only a person who administers it may, through a key revoked after", async () => {
  const { Fleet } = await import("./golden.ts");
  const { connect } = await import("../../src/cli/setup/doctor.ts");
  const { asOwner } = await import("../../src/cli/setup/connect_steps.ts");
  const { callFor } = await import("../../src/cli/setup/steps.ts");
  const { listKeys, openHub } = await import("../../src/cli/store.ts");
  const fleet = new Fleet("connect-steps");
  try {
    await fleet.startHub();
    const set = (c: McpClient) => callFor(c, "claude_hub_api_set", { sealed: [], endpoint: "http://100.104.249.49:8317" }, 30_000);
    // The CLI's own key is an agent's: the hub refuses it this.
    await expect(set(await connect(fleet.hubHome))).rejects.toMatchObject({ message: expect.stringContaining("owners and admins") });
    // As the owner, the hub takes the call: it has no key yet to keep under a new endpoint, so it says that instead.
    await expect(asOwner(fleet.hubHome, set)).rejects.toMatchObject({ message: "The hub has no API key to keep." });
    const db = openHub(fleet.hubHome);
    try {
      const made = listKeys(db).filter((k) => k.name === "fleetd init");
      expect(made).toHaveLength(1);
      expect([made[0]!.kind, made[0]!.revokedAt === undefined]).toEqual(["human", false]);
    } finally {
      db.conn.close();
    }
  } finally {
    await fleet.stop();
  }
}, 60_000);
