import { describe, expect, it } from "vitest";
import { githubWord, originUrl } from "./drop";

describe("reading a drop", () => {
  it("finds a folder's origin, not another remote", () => {
    const config =
      '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/x.git\n[remote "origin"]\n\turl = https://github.com/acme/storefront.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
    expect(originUrl(config)).toBe("https://github.com/acme/storefront.git");
    expect(originUrl("[core]\n\tbare = false\n")).toBeUndefined();
  });

  it("finds the GitHub address in link files", () => {
    expect(githubWord('<plist><dict><key>URL</key><string>https://github.com/acme/storefront</string></dict></plist>')).toBe(
      "https://github.com/acme/storefront",
    );
    expect(githubWord("[InternetShortcut]\nURL=https://github.com/acme/mailer\n")).toBe("https://github.com/acme/mailer");
    expect(githubWord("[Desktop Entry]\nURL=https://example.com/acme/x\n")).toBeUndefined();
  });
});
