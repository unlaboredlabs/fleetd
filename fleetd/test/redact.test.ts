import { expect, test } from "bun:test";
import { redact } from "../src/shared/redact.ts";

test("credentials are replaced by their shape", () => {
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
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nnext";
  expect(redact(key)).toBe("[secret]\nnext");
  expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIE cut off")).toBe("[secret]");
});

test("ordinary code and prose stay", () => {
  for (const text of [
    "fn token(&self) -> &str { &self.token }",
    "password: string;",
    "const TOKEN_LIMIT = 4000;",
    "The token budget is spent; see https://github.com/o/r/pull/12",
    "let secret = read_secret(path)?;",
    "cargo test -p fleetd --lib",
  ]) {
    expect(redact(text)).toBe(text);
  }
});
