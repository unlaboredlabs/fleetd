import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlaybookName } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "vitest";
import * as HubDb from "../store/HubDb.ts";
import { bundledDir, gitBlobSha, loadAll } from "./load.ts";
import * as Playbooks from "./Playbooks.ts";

const dirs: Array<string> = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-playbooks-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const gitHashObject = (file: string) => execFileSync("git", ["hash-object", file], { encoding: "utf8" }).trim();

/** The bundled bugfix playbook with `edit` applied to its text. */
const bugfixWith = (edit: (text: string) => string) => edit(fs.readFileSync(path.join(bundledDir(), "bugfix.md"), "utf8"));

describe("playbook loader", () => {
  it("loads the four bundled playbooks, each pinned by the SHA git hash-object gives its file", () => {
    const all = loadAll(bundledDir(), undefined);
    expect([...all.keys()].sort()).toEqual([...PlaybookName.literals].sort());
    for (const [name, loaded] of all) {
      expect(loaded.ref).toBe(`${name}@${gitHashObject(path.join(bundledDir(), `${name}.md`))}`);
      expect(loaded.playbook.leadInstructions.length).toBeLessThanOrEqual(600);
    }
  });

  it("hashes like git for any bytes, multi-byte characters included", () => {
    const dir = tmp();
    const file = path.join(dir, "x.md");
    fs.writeFileSync(file, "STOP − is a success ✓\n");
    expect(gitBlobSha(fs.readFileSync(file, "utf8"))).toBe(gitHashObject(file));
  });

  it("lets a user override replace one playbook and refuses invalid ones, naming the file", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "bugfix.md"), bugfixWith((t) => t.replace("maxReviewRounds: 3", "maxReviewRounds: 1")));
    const all = loadAll(bundledDir(), dir);
    expect(all.get("bugfix")!.playbook.valueBar.maxReviewRounds).toBe(1);
    expect(all.get("bugfix")!.ref).toBe(`bugfix@${gitHashObject(path.join(dir, "bugfix.md"))}`);
    expect(all.get("feature")!.ref).toBe(loadAll(bundledDir(), undefined).get("feature")!.ref);

    fs.writeFileSync(path.join(dir, "bugfix.md"), bugfixWith((t) => t.replace("tierDefault: S", "tierDefault: XL")));
    expect(() => loadAll(bundledDir(), dir)).toThrow(/playbook .*bugfix\.md is invalid: .*tierDefault/u);
    fs.writeFileSync(path.join(dir, "bugfix.md"), bugfixWith((t) => t.replace("name: bugfix", "name: feature")));
    expect(() => loadAll(bundledDir(), dir)).toThrow("its name is feature but the file is bugfix.md");
    fs.writeFileSync(path.join(dir, "bugfix.md"), "no frontmatter\n");
    expect(() => loadAll(bundledDir(), dir)).toThrow("it must start with YAML frontmatter");
    fs.rmSync(path.join(dir, "bugfix.md"));
    fs.writeFileSync(path.join(dir, "hotfix.md"), bugfixWith((t) => t));
    expect(() => loadAll(bundledDir(), dir)).toThrow("playbooks are named bugfix, feature, research, finish-all");
  });

  it("refuses lead instructions over 600 characters", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "bugfix.md"), bugfixWith((t) => t.replace("leadInstructions: >-", `leadInstructions: ${"x".repeat(601)}\nignored: >-`)));
    expect(() => loadAll(bundledDir(), dir)).toThrow(/leadInstructions/u);
  });
});

describe("Playbooks", () => {
  it("keeps a pinned version after the file changes and the hub restarts on the same database", async () => {
    const home = tmp();
    const overrides = path.join(home, "playbooks");
    fs.mkdirSync(overrides);
    fs.writeFileSync(path.join(overrides, "bugfix.md"), bugfixWith((t) => t.replace("maxReviewRounds: 3", "maxReviewRounds: 1")));
    const db = HubDb.layer(home);
    const withPlaybooks = <A>(effect: Effect.Effect<A, never, Playbooks.Playbooks>) =>
      Effect.runPromise(Effect.scoped(Effect.provide(effect, Playbooks.layer({ overridesDir: overrides }).pipe(Layer.provide(db)))));

    const first = await withPlaybooks(Effect.flatMap(Playbooks.Playbooks, (p) => p.pin("bugfix")));
    fs.writeFileSync(path.join(overrides, "bugfix.md"), bugfixWith((t) => t.replace("maxReviewRounds: 3", "maxReviewRounds: 2")));
    const [current, pinned] = await withPlaybooks(
      Effect.gen(function* () {
        const playbooks = yield* Playbooks.Playbooks;
        return [playbooks.current("bugfix"), yield* playbooks.byRef(first.ref)] as const;
      }),
    );
    expect(current.ref).not.toBe(first.ref);
    expect(current.playbook.valueBar.maxReviewRounds).toBe(2);
    expect(pinned).toMatchObject({ ref: first.ref, playbook: { valueBar: { maxReviewRounds: 1 } } });
  });
});
