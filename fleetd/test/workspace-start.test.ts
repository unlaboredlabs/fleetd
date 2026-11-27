// `fleetd workspace start` where another holds what it needs, as the second quality sweep found it: on Linux a second
// workspace on a taken port started without a word (Bun's SO_REUSEPORT), the kernel splitting connections between the
// two; one on a running workspace's home ran a second workspace on the same database.
import { afterAll, expect, test } from "bun:test";
import { closeSync } from "node:fs";
import { serve, stop } from "../src/hub/http/index.ts";
import { build, holdHome, listenRefusal } from "../src/hub/serve/index.ts";
import { hubHome, tempHome } from "./helpers.ts";

const home = hubHome();
const { hub, tools } = build(home.dir, { host: "127.0.0.1", port: 0 });
afterAll(() => {
  hub.db.close();
  home.done();
});

test("a second workspace on a taken port fails, in a sentence that says who holds it and what to do", async () => {
  const first = serve(hub, tools, 0);
  try {
    let caught: unknown;
    try {
      await stop(serve(hub, tools, first.port));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe("EADDRINUSE");
    const said = listenRefusal(caught, { host: "127.0.0.1", port: first.port as number });
    expect(said).toStartWith(`127.0.0.1:${first.port} is in use by `);
    expect(said).toEndWith(`Stop it, or start the workspace on another port (--listen 127.0.0.1:<free port>).`);
    expect(listenRefusal(new Error("other"), { host: "127.0.0.1", port: 1 })).toBeUndefined();
  } finally {
    await stop(first);
  }
});

test("one workspace per home: a second start is refused with the first's pid and address", async () => {
  const dir = tempHome();
  try {
    const held = await holdHome(dir.dir, "127.0.0.1:4790", 0);
    expect(typeof held).toBe("number");
    expect(await holdHome(dir.dir, "127.0.0.1:4791", 0)).toBe(
      `a workspace already runs on ${dir.dir} (pid ${process.pid}, at 127.0.0.1:4790). Stop it first (fleetd workspace stop), or give this one a home of its own (--home <dir>).`,
    );
    closeSync(held as number);
  } finally {
    dir.done();
  }
});
