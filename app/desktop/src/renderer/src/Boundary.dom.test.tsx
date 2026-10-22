// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Boundary } from "./Boundary";

function Throws(): never {
  throw new Error("boom");
}

it("the whole app's card doesn't promise a working rest of the app, and confirms a copy in its own text", async () => {
  const copy = vi.fn(() => Promise.resolve());
  vi.stubGlobal("fleetd", { version: "1.0.0", platform: "linux", copy, app: { logError: () => Promise.resolve() } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(
      <Boundary part="the app" root>
        <Throws />
      </Boundary>,
    );
    await Promise.resolve();
  });
  expect(host.textContent).toContain("fleetd hit an error");
  expect(host.textContent).not.toContain("still works");
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Copy details");
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
  expect(copy).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Copied the details");
});
