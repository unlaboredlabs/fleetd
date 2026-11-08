// @vitest-environment happy-dom
// A chat bubble keeps the line breaks its words were written with, as the phone's does (Shift+Enter in the box, a
// lead's address or list of lines); a document (an artifact, a PR's body) reads as markdown does, a lone line break
// a space.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Markdown } from "../../ui";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { Message } from "./text";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  await import("../../ui/markdown/MarkdownBody");
});
beforeEach(() => {
  vi.stubGlobal("fleetd", { platform: "linux" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const show = async (node: React.ReactNode) => {
  act(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
  for (let i = 0; i < 3; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

it("shows a message's line breaks, and leaves code and paragraphs as they are", async () => {
  await show(<Message text={"please work\non the **login**\n\n```sh\na\nb\n```"} />);
  const p = host.querySelector("p");
  expect(p?.innerHTML.replaceAll("\n", "")).toBe("please work<br>on the <strong>login</strong>");
  expect(host.querySelectorAll("br")).toHaveLength(1);
  // The fence keeps its own lines: no break in it.
  expect(host.querySelector("pre br, code br")).toBeNull();
});

it("reads a document's lone line break as a space", async () => {
  await show(<Markdown source={"one line\nthe same paragraph"} />);
  expect(host.querySelectorAll("br")).toHaveLength(0);
});
