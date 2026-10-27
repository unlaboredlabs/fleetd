// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdatePart, UpdateRun } from "../../../shared/contracts";
import { UiProvider } from "../../ui";
import { updatesView } from "./model";
import { UpdatesSheet } from "./UpdatesSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const OLDER = "0.0.0-nightly.202610201030+0001111";
const NEXT = "0.0.0-nightly.202610231030+def5678";
const p = (over: Partial<UpdatePart>): UpdatePart => ({ part: "node", name: "builder", from: OLDER, state: "done", ...over });
const run: UpdateRun = {
  id: "U1",
  channel: "nightly",
  to: NEXT,
  startedAt: "2026-10-26T10:00:00.000Z",
  finishedAt: "2026-10-26T10:03:00.000Z",
  parts: [
    p({ part: "hub", name: "the hub" }),
    p({ machineId: "builder", name: "builder", state: "failed", stage: "download", message: "couldn't download `fleetd-darwin-arm64`: 503" }),
    p({ machineId: "devbox", name: "devbox" }),
  ],
};
const view = updatesView({
  app: { current: NEXT, app: { kind: "current" }, release: null },
  hub: { url: "http://devbox:4790", version: NEXT },
  machines: [
    { machineId: "builder", name: "builder", nodeVersion: OLDER, online: true },
    { machineId: "devbox", name: "devbox", nodeVersion: NEXT, online: true },
  ],
  run,
  flow: { phase: "finished", updated: false },
  now: Date.parse("2026-10-26T10:04:00.000Z"),
});

const text = (el: Element | null) => el?.textContent ?? "";

describe("the updates sheet", () => {
  it("shows one line per part, Retry on the failed one, and the steps only behind Details", () => {
    const onRetry = vi.fn();
    act(() =>
      root.render(
        <UiProvider>
          <UpdatesSheet view={view} onUpdate={vi.fn()} onRetry={onRetry} onApp={vi.fn()} />
        </UiProvider>,
      ),
    );
    const lines = [...host.querySelectorAll("[data-updates-line-of]")].map((l) => l.getAttribute("data-updates-line-of"));
    expect(lines).toEqual(["hub", "builder", "devbox", "app"]);
    expect(text(host.querySelector('[data-updates-line-of="builder"]'))).toBe("builderFailedCouldn't download the new buildRetry");
    expect(text(host.querySelector('[role="alert"]'))).toBe("Update failed: builder. The rest updated; Retry tries it again.");
    // One Retry, on the failed machine; the hub's words wait behind Details.
    const retry = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Retry");
    expect(retry).toHaveLength(1);
    act(() => retry[0]?.click());
    expect(onRetry).toHaveBeenCalledWith({ kind: "machine", machineId: "builder" });
    expect(host.querySelector("[data-updates-details]")).toBeNull();

    const details = [...host.querySelectorAll("button")].find((b) => b.textContent === "Details");
    expect(details?.getAttribute("aria-expanded")).toBe("false");
    act(() => details?.click());
    expect(details?.getAttribute("aria-expanded")).toBe("true");
    expect(text(host.querySelector('[data-updates-row="builder"]'))).toContain("Failed while downloading: couldn't download fleetd-darwin-arm64: 503");
  });
});
