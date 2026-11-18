// @vitest-environment happy-dom
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { markShown, preloadable, preloadWhenIdle } from "./idle";

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

const Words = ({ text }: { text: string }) => <p>{text}</p>;

it("shows a preloaded component in its first commit, with no fallback", async () => {
  const load = vi.fn(() => Promise.resolve(Words));
  const Lazy = preloadable(load);
  await Lazy.preload();
  act(() =>
    root.render(
      <Suspense fallback={<i>loading</i>}>
        <Lazy text="Settings" />
      </Suspense>,
    ),
  );
  expect(host.innerHTML).toBe("<p>Settings</p>");
  expect(load).toHaveBeenCalledTimes(1);
});

it("loads on first render when not preloaded, once however often it is asked", async () => {
  const load = vi.fn(() => Promise.resolve(Words));
  const Lazy = preloadable(load);
  act(() =>
    root.render(
      <Suspense fallback={<i>loading</i>}>
        <Lazy text="Settings" />
      </Suspense>,
    ),
  );
  expect(host.innerHTML).toBe("<i>loading</i>");
  await act(() => Lazy.preload());
  await vi.waitFor(() => expect(host.innerHTML).toContain("<p>Settings</p>"));
  expect(load).toHaveBeenCalledTimes(1);
});

it("tries a failed load again on the next preload", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(Words);
  const Lazy = preloadable<{ text: string }>(load);
  await expect(Lazy.preload()).rejects.toThrow("offline");
  await expect(Lazy.preload()).resolves.toBe(Words);
  expect(load).toHaveBeenCalledTimes(2);
});

it("preloads only once the app has shown what it opened on", async () => {
  const preload = vi.fn(() => Promise.resolve());
  preloadWhenIdle({ preload });
  await new Promise((r) => setTimeout(r, 50));
  expect(preload).not.toHaveBeenCalled();
  markShown();
  await vi.waitFor(() => expect(preload).toHaveBeenCalledTimes(1));
});
