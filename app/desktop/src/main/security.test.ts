import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const sessionFetch = vi.fn((url: string) => Promise.resolve(new Response(`via the session: ${url}`)));
vi.mock("electron", () => ({ session: { fromPartition: () => ({ fetch: sessionFetch }) } }));
const { appFile } = await import("./security");

const root = mkdtempSync(join(tmpdir(), "fleetd-renderer-"));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "index.html"), "<!doctype html>");
writeFileSync(join(root, "assets", "index-1.js"), "export {};");
writeFileSync(join(root, "assets", "index-1.js.map"), "{}");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("appFile", () => {
  it("reads the build's own kinds of file from disk, typed", async () => {
    const page = await appFile("app://fleetd/", root);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toBe("<!doctype html>");
    const script = await appFile("app://fleetd/assets/index-1.js", root);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toBe("export {};");
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it("leaves any other kind to main's own session, which types it", async () => {
    expect(await (await appFile("app://fleetd/assets/index-1.js.map", root)).text()).toBe(`via the session: file://${root}/assets/index-1.js.map`);
  });

  it("answers 404 for a file that isn't there or a path outside the build", async () => {
    expect((await appFile("app://fleetd/assets/gone.js", root)).status).toBe(404);
    expect((await appFile("app://fleetd/assets/..%2f..%2fetc%2fpasswd", root)).status).toBe(404);
    expect((await appFile("app://other/index.html", root)).status).toBe(404);
  });
});
