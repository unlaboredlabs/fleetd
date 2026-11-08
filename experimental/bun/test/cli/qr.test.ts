// `fleetd pair`'s phone QR, module for module as the Rust binary drew it (test/cli/fixtures/pair-qr.txt, a hub at
// http://devbox.example:4799).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deepLink } from "../../src/cli/pair.ts";
import { terminalQr } from "../../src/cli/qr.ts";

test("the pairing QR is the Rust binary's", () => {
  const text = readFileSync(join(import.meta.dir, "fixtures/pair-qr.txt"), "utf8");
  const code = /Pairing code: (\S+)/.exec(text)![1]!;
  const rust = text.split("Scan with the fleetd app on your phone:\n\n")[1]!.split("\n\n")[0]!;
  expect(terminalQr(deepLink("http://devbox.example:4799", code))).toBe(rust);
});
