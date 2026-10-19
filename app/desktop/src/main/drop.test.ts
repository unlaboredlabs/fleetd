import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LINK_FILE_MAX, linkRepo, originUrl, readDrop, repoOf } from "./drop";

const dir = mkdtempSync(join(tmpdir(), "fleetd-drop-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

describe("parsing", () => {
  it("finds a folder's origin, not another remote", () => {
    const config =
      '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/x.git\n[remote "origin"]\n\turl = https://github.com/acme/storefront.git\n';
    expect(originUrl(config)).toBe("https://github.com/acme/storefront.git");
    expect(originUrl("[core]\n\tbare = false\n")).toBeUndefined();
  });

  it("returns owner/name only, never the raw text around it", () => {
    expect(repoOf("git@github.com:acme/storefront.git")).toBe("acme/storefront");
    expect(repoOf("https://github.com/acme/storefront/tree/main")).toBe("acme/storefront");
    expect(repoOf(`https://github.com/acme/${"x".repeat(5000)}`)).toBeUndefined();
    expect(repoOf("https://gitlab.com/acme/x")).toBeUndefined();
    expect(linkRepo('<plist><string>https://github.com/acme/storefront?secret=1</string></plist>')).toBe("acme/storefront");
    expect(linkRepo("[InternetShortcut]\nURL=https://github.com/acme/mailer\n")).toBe("acme/mailer");
    expect(linkRepo("URL=https://example.com/acme/x")).toBeUndefined();
  });
});

describe("reading a drop", () => {
  it("reads a link file only by its extension and size", async () => {
    expect(await readDrop(file("repo.url", "[InternetShortcut]\nURL=https://github.com/acme/mailer\n"))).toEqual({ kind: "link", repo: "acme/mailer" });
    expect(await readDrop(file("notes.txt", "https://github.com/acme/mailer"))).toEqual({ kind: "other" });
    expect(await readDrop(file("big.webloc", `https://github.com/acme/mailer ${" ".repeat(LINK_FILE_MAX)}`))).toEqual({ kind: "other" });
  });

  it("never follows a symlink, to a file or a folder", async () => {
    const target = file("real.url", "URL=https://github.com/acme/mailer");
    symlinkSync(target, join(dir, "link.url"));
    symlinkSync(dir, join(dir, "linked-folder"));
    expect(await readDrop(join(dir, "link.url"))).toEqual({ kind: "other" });
    expect(await readDrop(join(dir, "linked-folder"))).toEqual({ kind: "other" });
  });

  it("gives a checkout's origin as owner/name, and says when a folder isn't one", async () => {
    const repo = join(dir, "storefront");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/storefront.git\n');
    expect(await readDrop(repo)).toEqual({ kind: "folder", path: repo, git: true, repo: "acme/storefront" });
    const plain = join(dir, "plain");
    mkdirSync(plain);
    expect(await readDrop(plain)).toEqual({ kind: "folder", path: plain, git: false });
  });

  it("doesn't wait on a FIFO where .git/config should be, and says nothing about a missing path", async () => {
    const repo = join(dir, "fifo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    execFileSync("mkfifo", [join(repo, ".git", "config")]);
    expect(await readDrop(repo)).toEqual({ kind: "folder", path: repo, git: true });
    expect(await readDrop(join(dir, "nope"))).toEqual({ kind: "other" });
  });
});
