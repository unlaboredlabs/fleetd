// @vitest-environment happy-dom
// The frame's sidebar and aside come and go: the grid takes the change at once, a side coming slides in, and a side
// going stays drawn, inert and with what it showed, until its slide out ends.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AppFrame } from "./Layout";
import s from "./layout.module.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The slide out, which happy-dom never runs: as in the app, the side waits for its end.
const slide = document.createElement("style");
slide.textContent = `.${s.side}[data-motion="out"], .${s.aside}[data-motion="out"] { animation-name: out; animation-duration: 120ms; }`;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  document.head.appendChild(slide);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  slide.remove();
});

const render = (sidebar: boolean, aside: boolean, label = "Projects") => {
  act(() =>
    root.render(
      <AppFrame topBar={<header />} sidebar={sidebar ? <nav>{label}</nav> : undefined} sidebarTop={<button type="button">{sidebar ? "Hide" : "Show"}</button>} aside={aside ? <aside>Agents</aside> : undefined}>
        <p>chat</p>
      </AppFrame>,
    ),
  );
};
const frame = () => host.firstElementChild as HTMLElement;
const side = () => host.querySelector<HTMLElement>(`.${s.side}`);
const aside = () => host.querySelector<HTMLElement>(`.${s.aside}`);
const end = (el: HTMLElement | null) => {
  act(() => {
    el?.dispatchEvent(new Event("animationend", { bubbles: true }));
  });
};
const has = (name: "noSidebar" | "withAside") => frame().classList.contains(s[name] ?? name);

it("shows what is there at its first render without sliding it in", () => {
  render(true, true);
  expect(side()?.dataset["motion"]).toBeUndefined();
  expect(aside()?.dataset["motion"]).toBeUndefined();
});

it("lays the frame out for a side at once, and slides it in", () => {
  render(false, false);
  expect(side()).toBeNull();
  render(true, true);
  expect(has("noSidebar")).toBe(false);
  expect(has("withAside")).toBe(true);
  expect(side()?.dataset["motion"]).toBe("in");
  expect(aside()?.dataset["motion"]).toBe("in");
  end(side());
  end(aside());
  expect(side()?.dataset["motion"]).toBeUndefined();
  expect(aside()?.dataset["motion"]).toBeUndefined();
});

it("gives a closing side's room to the main area at once, and keeps it drawn, inert and as it was, until its slide ends", () => {
  render(true, true);
  render(false, false, "Projects later");
  expect(has("noSidebar")).toBe(true);
  expect(has("withAside")).toBe(false);
  expect(side()?.dataset["motion"]).toBe("out");
  expect(aside()?.dataset["motion"]).toBe("out");
  expect(side()?.inert).toBe(true);
  // What it showed as it closed, its top row too, not what the frame was given after.
  expect(side()?.textContent).toBe("HideProjects");
  expect(aside()?.textContent).toBe("Agents");
  end(side());
  end(aside());
  expect(side()).toBeNull();
  expect(aside()).toBeNull();
});

it("slides back in from a slide out, keeping what it shows", () => {
  render(true, false);
  render(false, false);
  render(true, false, "Again");
  expect(side()?.dataset["motion"]).toBe("in");
  expect(side()?.inert).toBe(false);
  expect(side()?.textContent).toBe("HideAgain");
});

it("goes at once without a slide to wait for (reduced motion)", () => {
  slide.remove();
  render(true, true);
  render(false, false);
  expect(side()).toBeNull();
  expect(aside()).toBeNull();
});
