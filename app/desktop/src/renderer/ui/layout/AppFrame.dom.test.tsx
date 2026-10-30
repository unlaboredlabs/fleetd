// @vitest-environment happy-dom
// The frame's sidebar and aside come and go: the grid takes the change at once; a side its toggle opens slides in,
// and one it closes stays drawn, inert and with what it showed, until its slide out ends. Anything else that brings
// or takes a side swaps it at once.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AppFrame } from "./Layout";
import s from "./layout.module.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The slide, which happy-dom never runs: as in the app, a side waits for its end.
const slide = document.createElement("style");
slide.textContent = `.${s.side}[data-motion], .${s.aside}[data-motion] { transition-property: transform; transition-duration: 180ms; }`;

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

/** The frame with a sidebar and an aside, each shown or not, and open by its toggle as shown unless said otherwise. */
const render = (sidebar: boolean, aside: boolean, { label = "Projects", sidebarOpen = sidebar, asideOpen = aside } = {}) => {
  act(() =>
    root.render(
      <AppFrame
        topBar={<header />}
        sidebar={sidebar ? <nav>{label}</nav> : undefined}
        sidebarTop={<button type="button">{sidebar ? "Hide" : "Show"}</button>}
        sidebarOpen={sidebarOpen}
        aside={aside ? <aside>Agents</aside> : undefined}
        asideOpen={asideOpen}
      >
        <p>chat</p>
      </AppFrame>,
    ),
  );
};
const frame = () => host.firstElementChild as HTMLElement;
const has = (name: "noSidebar" | "withAside") => frame().classList.contains(s[name] ?? name);
const side = () => host.querySelector<HTMLElement>(`.${s.side}`);
const aside = () => host.querySelector<HTMLElement>(`.${s.aside}`);
/** A transition's end; happy-dom's TransitionEvent has no propertyName. */
const ended = (propertyName: string) => Object.assign(new Event("transitionend", { bubbles: true }), { propertyName });
const end = (el: HTMLElement | null) => {
  act(() => {
    el?.dispatchEvent(ended("transform"));
  });
};

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
  // Another property's end, or a child's, is not the slide's.
  act(() => {
    side()?.dispatchEvent(ended("opacity"));
    side()?.querySelector("nav")?.dispatchEvent(ended("transform"));
  });
  expect(side()?.dataset["motion"]).toBe("in");
  end(side());
  end(aside());
  expect(side()?.dataset["motion"]).toBeUndefined();
  expect(aside()?.dataset["motion"]).toBeUndefined();
});

it("gives a closing side's room to the main area at once, and keeps it drawn, inert and as it was, until its slide ends", () => {
  render(true, true);
  render(false, false, { label: "Projects later" });
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

it("swaps a side at once when it comes or goes with its toggle unchanged: another screen, not the toggle", () => {
  render(true, true);
  // Leaving the project's chat: the panel's toggle still has it open.
  render(true, false, { asideOpen: true });
  expect(aside()).toBeNull();
  render(true, true);
  expect(aside()?.dataset["motion"]).toBeUndefined();
  // Settings shows the sidebar its toggle hid.
  render(false, true);
  end(side());
  render(true, true, { sidebarOpen: false });
  expect(side()?.dataset["motion"]).toBeUndefined();
  render(false, true);
  expect(side()).toBeNull();
});

it("turns back mid-way on the same element, so the slide goes on from where it is", () => {
  render(true, false);
  const shown = side();
  render(false, false);
  expect(side()).toBe(shown);
  expect(side()?.dataset["motion"]).toBe("out");
  render(true, false, { label: "Again" });
  expect(side()).toBe(shown);
  expect(side()?.dataset["motion"]).toBe("in");
  expect(side()?.inert).toBe(false);
  expect(side()?.textContent).toBe("HideAgain");
  render(false, false);
  expect(side()).toBe(shown);
  expect(side()?.dataset["motion"]).toBe("out");
  expect(side()?.textContent).toBe("HideAgain");
});

it("comes and goes at once without a slide to wait for (reduced motion)", () => {
  slide.remove();
  render(false, false);
  render(true, true);
  expect(side()?.dataset["motion"]).toBeUndefined();
  render(false, false);
  expect(side()).toBeNull();
  expect(aside()).toBeNull();
});
