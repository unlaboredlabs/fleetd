import { describe, expect, it } from "vitest";
import { ARTIFACT_CSP, artifactPage, cardLine, FENCE, linkTarget, loadsOnly, rowLine } from "./model";

const directives = (csp: string): Map<string, string> => new Map(csp.split(";").map((d) => d.trim().split(/\s+/u)).map(([name, ...values]) => [name ?? "", values.join(" ")]));

describe("an HTML artifact on the phone", () => {
  it("gets the CSP ahead of anything it says, its doctype kept first", () => {
    const page = artifactPage("<!DOCTYPE html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"></head><body><script>1</script></body></html>");
    expect(page.startsWith(`<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`)).toBe(true);
    // The page's own looser policy comes after ours, and a second policy can only narrow the first.
    expect(page.indexOf(ARTIFACT_CSP)).toBeLessThan(page.indexOf("default-src *"));
    expect(artifactPage("<h1>Sweep</h1>").startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`)).toBe(true);
  });

  it("runs its own scripts and styles and loads nothing from anywhere", () => {
    const d = directives(ARTIFACT_CSP);
    expect(d.get("default-src")).toBe("'none'");
    expect(d.get("connect-src")).toBe("'none'");
    expect(d.get("frame-src")).toBe("'none'");
    for (const [name, values] of d) {
      for (const value of values.split(" ")) expect(["'none'", "'unsafe-inline'", "'unsafe-eval'", "data:", "blob:"], `${name} ${value}`).toContain(value);
    }
  });

  it("loads only itself: no link, form or redirect out", () => {
    expect(loadsOnly("about:blank")).toBe(true);
    expect(loadsOnly("about:blank#totals")).toBe(true);
    for (const url of ["https://example.com/", "http://127.0.0.1:4790/", "file:///etc/hosts", "fleetd://pair?x", "data:text/html,x", "javascript:alert(1)", "about:srcdoc"]) expect(loadsOnly(url), url).toBe(false);
  });

  it("has no bridge, storage, cookies, files or popups", () => {
    expect(FENCE).toMatchObject({
      javaScriptEnabled: true,
      domStorageEnabled: false,
      incognito: true,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      javaScriptCanOpenWindowsAutomatically: false,
      setSupportMultipleWindows: false,
      originWhitelist: ["about:blank"],
    });
    for (const bridge of ["onMessage", "injectedJavaScript", "injectedJavaScriptBeforeContentLoaded", "injectedJavaScriptObject"]) expect(FENCE).not.toHaveProperty(bridge);
  });
});

describe("artifact words and links", () => {
  it("reads a link's artifact and version, and nothing else", () => {
    expect(linkTarget("artifact:dependency-sweep")).toEqual({ name: "dependency-sweep", version: undefined });
    expect(linkTarget("artifact:dependency-sweep@2")).toEqual({ name: "dependency-sweep", version: 2 });
    for (const url of ["artifact:", "artifact:Sweep", "artifact:a@0", "https://x.dev", "artifact:a b"]) expect(linkTarget(url), url).toBeUndefined();
  });

  it("words a row and a card plainly, with no ids", () => {
    const v = { version: 2, title: "Dependency sweep", format: "md", by: "Lead", at: "2026-11-03T09:00:00.000Z", bytes: 10 } as const;
    expect(rowLine(v, "9:00")).toBe("Markdown · Lead · 9:00 · Version 2");
    expect(cardLine({ name: "build-times", version: 1, title: "Build times", format: "html", by: "Lead" })).toBe("HTML · Lead");
  });
});
