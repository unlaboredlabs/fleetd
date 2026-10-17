import { describe, expect, it } from "vitest";
import { globMatcher, outsideGlobs } from "./glob.ts";

const cases: ReadonlyArray<readonly [glob: string, matches: ReadonlyArray<string>, misses: ReadonlyArray<string>]> = [
  ["**", ["a", "a/b/c.ts", ".github/workflows/ci.yml"], []],
  ["docs/**", ["docs/x.md", "docs/a/b/c.md", "docs/.keep"], ["docs", "docsx/a.md", "src/docs/a.md"]],
  ["docs", ["docs", "docs/x.md", "docs/a/b.md"], ["docsx", "docs.md", "src/docs"]],
  ["docs/", ["docs/x.md", "docs/a/b.md"], ["docs", "docsx/a.md"]],
  ["./docs/**", ["docs/x.md", "./docs/x.md"], ["src/x.md"]],
  ["*.md", ["README.md", ".hidden.md"], ["docs/x.md", "README.mdx"]],
  ["**/*.md", ["README.md", "docs/x.md", "a/b/c/d.md"], ["README.mdx", "docs/x.txt"]],
  ["src/**/test", ["src/test", "src/a/test", "src/a/b/test"], ["src/test/x", "src/atest", "test"]],
  ["apps/*/src/**", ["apps/hub/src/a.ts", "apps/cli/src/x/y.ts"], ["apps/hub/test/a.ts", "apps/a/b/src/c.ts"]],
  ["src/?.ts", ["src/a.ts"], ["src/ab.ts", "src//.ts"]],
  ["src/**/*.{ts,tsx}", ["src/a.ts", "src/x/y.tsx"], ["src/a.js", "src/a.tsxx"]],
  ["{docs,site}/**", ["docs/a", "site/b/c"], ["blog/a"]],
  ["file[0-9].txt", ["file1.txt", "file9.txt"], ["filea.txt", "file10.txt"]],
  ["file[!0-9].txt", ["filea.txt"], ["file1.txt", "file/.txt"]],
  ["a.b(c)+$^|.txt", ["a.b(c)+$^|.txt"], ["aXb(c)+$^|.txt"]],
  ["packages/contracts/src/tasks.ts", ["packages/contracts/src/tasks.ts"], ["packages/contracts/src/tasks.test.ts"]],
  ["weird]name}/**", ["weird]name}/a"], ["weird/a"]],
  ["unclosed[x/**", ["unclosed[x/a"], ["unclosedx/a"]],
];

describe("globMatcher", () => {
  for (const [glob, matches, misses] of cases) {
    it(`"${glob}"`, () => {
      const m = globMatcher(glob);
      for (const p of matches) expect(m(p), `${glob} should match ${p}`).toBe(true);
      for (const p of misses) expect(m(p), `${glob} should not match ${p}`).toBe(false);
    });
  }
});

describe("outsideGlobs", () => {
  it("keeps paths no area glob covers, in order", () => {
    const paths = ["docs/x.md", "README.md", "apps/hub/src/tasks/Tasks.ts", "apps/web/x.ts", "packages/contracts/src/tasks.ts"];
    expect(outsideGlobs(paths, ["docs/**", "apps/hub/**", "packages/contracts/src/tasks.ts"])).toEqual(["README.md", "apps/web/x.ts"]);
  });

  it("flags everything when no globs are leased and nothing under **", () => {
    expect(outsideGlobs(["a", "b/c"], [])).toEqual(["a", "b/c"]);
    expect(outsideGlobs(["a", "b/c"], ["**"])).toEqual([]);
  });
});
