// Leads' memory and the secret redactor (hub/redact.rs).
import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { chat } from "../src/hub/chat/index.ts";
import { answer } from "../src/hub/memory/calls.ts";
import { Memory, projectTarget } from "../src/hub/memory/index.ts";
import { redact } from "../src/hub/memory/redact.ts";
import type { LeadCall, LeadCaller } from "../src/hub/leads/seams.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const lead: LeadCaller = { projectRef: PROJECT, by: "lead:lab-a/p1", agent: { kind: "lead" } };
const remember = (hub: Parameters<typeof answer>[0], body: Record<string, unknown>) =>
  answer(hub, lead, { op: "remember", ...body } as LeadCall);

test("credentials are replaced by their shape; code and prose stay", () => {
  const cases: [string, string][] = [
    ["export GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789", "export GH=[secret]"],
    ["key fld_abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst", "key [secret]"],
    ["ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789_xyz", "ANTHROPIC_API_KEY=[secret]"],
    ["curl -H 'Authorization: Bearer abc123def456ghi789jkl'", "curl -H 'Authorization: Bearer [secret]'"],
    ["git clone https://bot:hunter2token@github.com/o/r", "git clone https://[secret]@github.com/o/r"],
    ["DATABASE_PASSWORD=s3cr3t-v4lue npm test", "DATABASE_PASSWORD=[secret] npm test"],
    ['{"api_key": "a1b2c3d4e5f6g7"}', '{"api_key": "[secret]"}'],
    ["aws AKIAABCDEFGHIJKLMNOP", "aws [secret]"],
  ];
  for (const [input, want] of cases) expect(redact(input)).toBe(want);
  expect(redact("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nnext")).toBe("[secret]\nnext");
  expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIE cut off")).toBe("[secret]");
  for (const text of ["fn token(&self) -> &str { &self.token }", "password: string;", "const TOKEN_LIMIT = 4000;"]) {
    expect(redact(text)).toBe(text);
  }
});

test("a topic gets its index line and is read on demand", () => {
  const { hub, done } = testHub();
  remember(hub, { scope: "project", text: "Public repo." });
  remember(hub, { scope: "project", topic: "deploys", text: "Staging first, always." });
  remember(hub, { scope: "project", text: "Docs ship with the code." });
  const memory = Memory.of(hub);
  expect(memory.read(projectTarget(PROJECT))).toBe("- Public repo.\n- Docs ship with the code.\n- [deploys](deploys.md)\n");
  expect(memory.injected(PROJECT, true, { kind: "shared" })).not.toContain("Staging first");
  expect(answer(hub, lead, { op: "memory_read", topic: "deploys" } as LeadCall)).toMatchObject({ text: "- Staging first, always.\n" });
  done();
});

test("replaces takes the entry's place, a secret and a missing entry are refused, and undo brings it back", async () => {
  const { hub, done } = testHub();
  const tools = new Registry();
  registerAll(tools);
  remember(hub, { scope: "project", text: "Use npm." });
  remember(hub, { scope: "project", text: "No npm: use pnpm.", replaces: "Use npm" });
  const memory = () => Memory.of(hub).read(projectTarget(PROJECT));
  expect(memory()).toBe("- No npm: use pnpm.\n");
  expect(() => remember(hub, { scope: "project", text: "x", replaces: "yarn" })).toThrow("No entry of MEMORY.md");
  expect(() => remember(hub, { scope: "project", text: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789" })).toThrow("looks like a secret");
  const lines = chat(hub)
    .page(PROJECT, undefined, undefined, 50)
    .messages.filter((m) => m.remembered);
  expect(lines.map((m) => m.text)).toEqual(["Remembered: Use npm.", "Remembered: No npm: use pnpm."]);
  const undo = { projectRef: PROJECT, messageId: (lines[1] as { messageId: string }).messageId };
  expect(await tools.call(hub, caller("operate"), "memory_undo", undo)).toMatchObject({ error: { error: { code: "forbidden" } } });
  expect(await tools.call(hub, caller("operate", true), "memory_undo", undo)).toEqual({ output: { ok: true } });
  expect(memory()).toBe("- Use npm.\n");
  expect(chat(hub).byId(undo.messageId)?.remembered?.undone).toBe(true);
  done();
});

test("a write past a cap is refused whole", () => {
  const { hub, done } = testHub();
  hub.db.conn.query("INSERT INTO memory_settings (key, value) VALUES ('index', 1000)").run();
  remember(hub, { scope: "project", text: "a".repeat(900) });
  expect(() => remember(hub, { scope: "project", text: "b".repeat(200) })).toThrow("past its cap of 1000");
  expect(Memory.of(hub).read(projectTarget(PROJECT))).toBe(`- ${"a".repeat(900)}\n`);
  done();
});

test("memory_get shows the caller's own memory and the project's files", async () => {
  const { hub, done } = testHub();
  const tools = new Registry();
  registerAll(tools);
  remember(hub, { scope: "user", text: "Prefers short answers." });
  remember(hub, { scope: "project", topic: "deploys", text: "Staging first." });
  const out = (await tools.call(hub, caller("read", true), "memory_get", { projectRef: PROJECT })) as {
    output: { user: { text: string }; files: { topic?: string; text: string; notes: unknown[] }[] };
  };
  expect(out.output.user.text).toBe("- Prefers short answers.\n");
  expect(out.output.files.map((f) => f.topic ?? "MEMORY.md")).toEqual(["MEMORY.md", "deploys"]);
  expect(out.output.files[1]?.notes.length).toBe(1);
  done();
});
