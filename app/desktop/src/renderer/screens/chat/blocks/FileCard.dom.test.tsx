// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDataLayer, type HubApi } from "../../../src/data/queries";
import { DataProvider } from "../../../src/data/react";
import { project } from "../../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../../ui/primitives/Tooltip";
import { FileCard } from "./FileCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const hub: HubApi = {
  call: () => Promise.resolve({ ok: true, output: {} } as never),
  subscribe: () => () => undefined,
  resync: () => Promise.resolve(),
  focus: () => Promise.resolve(),
  chat: () => Promise.resolve(),
};

const card = (caption: string | undefined) => {
  root = createRoot(host);
  act(() =>
    root?.render(
      <DataProvider layer={createDataLayer(hub)}>
        <TooltipProvider>
          <FileCard project={project} file={{ attachmentId: "F3", name: "summary.md", mime: "text/markdown", bytes: 2048 }} caption={caption} />
        </TooltipProvider>
      </DataProvider>,
    ),
  );
  // The card's own row (glyph, name, kind and size, actions), then its caption, if it shows one.
  return [...(host.querySelector("[data-block=file]")?.children ?? [])].slice(1).map((e) => e.textContent);
};

it("leaves out a caption that only says the file's name again, which the card already shows", () => {
  expect(card("summary.md")).toEqual([]);
  act(() => root?.unmount());
  expect(card(" `Summary.md` ")).toEqual([]);
  act(() => root?.unmount());
  expect(card("The week's notes, in short")).toEqual(["The week's notes, in short"]);
  act(() => root?.unmount());
  expect(card(undefined)).toEqual([]);
});
