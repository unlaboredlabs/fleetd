import { describe, expect, it } from "vitest";
import { changed, draftOf, setupFrom } from "./setupModel";

describe("setup commands", () => {
  const saved = { commands: ["pnpm install --frozen-lockfile", "pnpm codegen"], timeoutSec: 900, runAnyway: false, inputs: ["pnpm-lock.yaml"] };

  it("reads one command and one file a line, in order, and round-trips", () => {
    const draft = draftOf(saved);
    expect(draft.commands).toBe("pnpm install --frozen-lockfile\npnpm codegen");
    expect(setupFrom(draft)).toEqual({ ok: true, setup: saved });
    expect(changed(draft, saved)).toBe(false);
    expect(changed({ ...draft, commands: `${draft.commands}\n\n  ` }, saved)).toBe(false);
    expect(changed({ ...draft, runAnyway: true }, saved)).toBe(true);
    expect(setupFrom({ ...draft, inputs: "pnpm-lock.yaml\npnpm-lock.yaml\napp/Cargo.lock" })).toMatchObject({
      ok: true,
      setup: { inputs: ["pnpm-lock.yaml", "app/Cargo.lock"] },
    });
  });

  it("defaults the limit and refuses what the hub would", () => {
    expect(draftOf({}).timeout).toBe("600");
    const draft = draftOf(saved);
    expect(setupFrom({ ...draft, timeout: "0" })).toMatchObject({ ok: false });
    expect(setupFrom({ ...draft, timeout: "3601" })).toMatchObject({ ok: false });
    expect(setupFrom({ ...draft, timeout: "1.5" })).toMatchObject({ ok: false });
    expect(setupFrom({ ...draft, inputs: "/etc/passwd" })).toMatchObject({ ok: false });
    expect(setupFrom({ ...draft, inputs: "../x" })).toMatchObject({ ok: false });
    expect(setupFrom({ ...draft, commands: Array.from({ length: 21 }, (_, i) => `echo ${i}`).join("\n") })).toMatchObject({ ok: false });
    // No commands is setup off.
    expect(setupFrom({ ...draft, commands: "" })).toMatchObject({ ok: true, setup: { commands: [] } });
  });
});
