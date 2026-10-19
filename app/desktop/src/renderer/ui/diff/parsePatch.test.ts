import { describe, expect, it } from "vitest";
import { parsePatch, toSplitRows } from "./parsePatch";

const GIT = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ export function main()
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
@@ -20,3 +21,2 @@
 one
-two
 three
\\ No newline at end of file
diff --git a/old name.md b/docs/new.md
similarity index 90%
rename from old name.md
rename to docs/new.md
diff --git a/img.png b/img.png
new file mode 100644
Binary files /dev/null and b/img.png differ
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
--- a line that starts with dashes
-bye
`;

describe("parsePatch", () => {
  const parsed = parsePatch(GIT);
  if (parsed?.kind !== "files") throw new Error("expected files");
  const [app, renamed, image, gone] = parsed.files;

  it("reads files, hunks, line numbers and counts", () => {
    expect(parsed.files).toHaveLength(4);
    expect(app?.path).toBe("src/app.ts");
    expect(app?.change).toBe("modified");
    expect(app?.additions).toBe(2);
    expect(app?.deletions).toBe(2);
    expect(app?.hunks[0]?.section).toBe("export function main()");
    expect(app?.hunks[0]?.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
      ["context", 4, 5],
    ]);
  });

  it("counts the unchanged lines between hunks and marks a missing final newline", () => {
    expect(app?.hunks[0]?.collapsedBefore).toBe(0);
    expect(app?.hunks[1]?.collapsedBefore).toBe(15);
    expect(app?.hunks[1]?.lines.at(-1)?.noNewline).toBe(true);
  });

  it("knows renames, binary additions and deletions", () => {
    expect(renamed).toMatchObject({ change: "renamed", oldPath: "old name.md", newPath: "docs/new.md", path: "docs/new.md" });
    expect(image).toMatchObject({ change: "added", binary: true, path: "img.png" });
    expect(gone).toMatchObject({ change: "deleted", path: "gone.txt", deletions: 2 });
    expect(gone?.hunks[0]?.lines[0]?.text).toBe("-- a line that starts with dashes");
  });

  it("reads a plain unified diff without git headers", () => {
    const plain = parsePatch("--- a/x.rs\n+++ b/x.rs\n@@ -1 +1 @@\n-old\n+new\n");
    expect(plain?.kind).toBe("files");
    if (plain?.kind === "files") expect(plain.files[0]).toMatchObject({ path: "x.rs", additions: 1, deletions: 1 });
  });

  it("falls back to raw text for something that is not a diff, and to nothing for empty input", () => {
    expect(parsePatch("just some words")).toMatchObject({ kind: "raw", text: "just some words" });
    expect(parsePatch("  \n")).toBeNull();
  });
});

describe("toSplitRows", () => {
  it("pairs a run of deletions with the additions after it", () => {
    const parsed = parsePatch(GIT);
    if (parsed?.kind !== "files") throw new Error("expected files");
    const rows = toSplitRows(parsed.files[0]?.hunks[0]?.lines ?? []);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["const a = 1;", "const a = 1;"],
      ["const b = 2;", "const b = 3;"],
      [null, "const c = 4;"],
      ["const d = 5;", "const d = 5;"],
      ["const e = 6;", "const e = 6;"],
    ]);
  });
});
