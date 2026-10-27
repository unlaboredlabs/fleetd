// `pnpm web:preview` comes up on 127.0.0.1:$PORT and serves the renderer with the stand-in, not the preload.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const desktopDir = path.resolve(import.meta.dirname, "..");
let server: ChildProcess | undefined;
let base = "";

const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address !== null ? done(address.port) : fail(new Error("no port"))));
    });
  });

const get = async (url: string) => {
  for (let tries = 0; ; tries++) {
    try {
      return await fetch(`${base}${url}`);
    } catch (error) {
      if (tries > 150 || server?.exitCode !== null) throw error;
      await new Promise((done) => setTimeout(done, 200));
    }
  }
};

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const vite = path.join(desktopDir, "node_modules", "vite", "bin", "vite.js");
  server = spawn(process.execPath, [vite, "--config", "web/vite.config.ts"], { cwd: desktopDir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
});

afterAll(() => {
  server?.kill();
});

test.each(["/", "/?fixture=sessions-preview"])("serves %s with the stand-in in place of the renderer's entry", async (url) => {
  const page = await get(url);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain(`/@fs${path.join(desktopDir, "web", "stand-in.ts")}`);
  expect(html).not.toContain("src/main.tsx");
}, 40_000);

test("the page gets main's fixture source without node:fs", async () => {
  const source = await get(`/@fs${path.join(desktopDir, "src", "main", "hub", "fixture.ts")}`);
  expect(source.status).toBe(200);
  const code = await source.text();
  expect(code).toContain("web/node-stub.ts");
  expect(code).not.toMatch(/from "node:fs"/u);
}, 40_000);

test("lists the fixtures and refuses a name it doesn't have", async () => {
  expect((await get("/@fleetd-web/fixtures")).status).toBe(200);
  expect((await get("/@fleetd-web/fixture/no-such-fixture")).status).toBe(404);
  expect((await get("/@fleetd-web/fixture/..%2Fpackage")).status).toBe(404);
}, 40_000);
