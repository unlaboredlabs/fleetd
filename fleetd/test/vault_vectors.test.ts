// The vault's envelope vectors (scripts/vault-vectors.ts, test/fixtures/vault/vault_vectors.json): the file
// is current, each vector opens to its JSON, and each negative (wrong key, tampered tag, swapped additional data) fails.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { make, OUT, verify, type Vectors } from "../scripts/vault-vectors.ts";

test("the committed vectors are what the script makes, and each opens or fails as it says", () => {
  const kept = JSON.parse(readFileSync(OUT, "utf8")) as Vectors;
  expect(kept).toEqual(JSON.parse(JSON.stringify(make())));
  expect(verify(kept)).toEqual([]);
  expect(kept.negatives.length).toBeGreaterThanOrEqual(7);
});

test("a vector moved to another row stops opening", () => {
  const v = make();
  const [login, card] = v.vectors;
  const moved = { ...v, vectors: [{ ...card!, sealed: login!.sealed }], negatives: [] };
  const problems = verify(moved);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toStartWith("card: doesn't open");
});
