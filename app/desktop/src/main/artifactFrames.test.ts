// An HTML artifact's frame: main answers only the page it was handed, at its own one-off address, with a CSP that runs
// its inline scripts, loads nothing and sandboxes it away from the app; the app's page may frame only that scheme.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACT_CSP, ArtifactFrames } from "./artifactFrames";

const directives = (csp: string): Map<string, string> => new Map(csp.split(";").map((d) => d.trim().split(/\s+/u)).map(([name, ...values]) => [name ?? "", values.join(" ")]));

describe("artifact frames", () => {
  it("serve the page at its own address with its CSP, and nothing else", async () => {
    const frames = new ArtifactFrames();
    const url = frames.put("<h1>Sweep</h1><script>1</script>");
    expect(url).toMatch(/^fleetd-artifact:\/\/[0-9a-f]{32}\/$/u);
    const page = frames.response(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<h1>Sweep</h1><script>1</script>");
    expect(page.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    for (const other of [`${url}x.js`, url.replace(/[0-9a-f]{4}\//u, "0000/"), "fleetd-artifact://frame/", "https://example.com/"]) {
      expect(frames.response(other).status, other).toBe(404);
    }
    // Two pages never share an address.
    expect(frames.put("<p>2</p>")).not.toBe(url);
  });

  it("keep only the newest pages", () => {
    const frames = new ArtifactFrames();
    const first = frames.put("first");
    for (let i = 0; i < 8; i++) frames.put(String(i));
    expect(frames.response(first).status).toBe(404);
  });

  it("run the page's own scripts and styles, load nothing, and sandbox it without its origin", () => {
    const d = directives(ARTIFACT_CSP);
    expect(d.get("default-src")).toBe("'none'");
    expect(d.get("connect-src")).toBe("'none'");
    expect(d.get("frame-src")).toBe("'none'");
    expect(d.get("form-action")).toBe("'none'");
    expect(d.get("script-src")?.split(" ")).not.toContain("*");
    // Nothing from a network: only inline code and data: or blob: media.
    for (const [name, values] of d) {
      if (name === "sandbox") continue;
      for (const value of values.split(" ").filter(Boolean)) expect(["'none'", "'unsafe-inline'", "'unsafe-eval'", "data:", "blob:"], `${name} ${value}`).toContain(value);
    }
    expect(d.get("sandbox")).toBe("allow-scripts");
  });

  it("are the only frames the app's page may show", () => {
    const html = readFileSync(join(import.meta.dirname, "../renderer/index.html"), "utf8");
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(html)?.[1] ?? "";
    expect(directives(csp).get("frame-src")).toBe("fleetd-artifact:");
  });
});
