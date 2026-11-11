// @vitest-environment happy-dom
// A chat's Artifacts: the panel's section once the hub serves it, the list newest first, a Markdown report rendered
// with its versions, an HTML one in a sandboxed frame main serves (never srcdoc, never same-origin), the chat's card,
// and a link in chat text that opens the right one.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ArtifactSummary, ArtifactVersion, ChatFile, FleetStatus } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { Message } from "../chat/text";
import { ProjectPanel } from "../panel/ProjectPanel";
import { forgetViews } from "../panel/Sections";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactsTabView } from "./ArtifactsPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const FRAME = "fleetd-artifact://0123456789abcdef0123456789abcdef/";
const framed: string[] = [];
const opened: string[] = [];
vi.hoisted(() =>
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    artifactFrame: (html: string) => {
      framed.push(html);
      return Promise.resolve({ url: FRAME, key: "k1" });
    },
    files: {
      open: (_hub: unknown, r: { attachmentId: string }) => (opened.push(`open ${r.attachmentId}`), Promise.resolve({ ok: true })),
      save: (_hub: unknown, r: { attachmentId: string }) => (opened.push(`save ${r.attachmentId}`), Promise.resolve({ ok: true })),
    },
  }),
);

const SHOP = { machineId: "devbox", projectId: "shop" } as const;

const snapshot: HubFrame = {
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] }],
    projects: [{ ...SHOP, title: "Shop", workspaceRoot: "/home/dev/shop", lastActivityAt: AT, threads: { running: 0, waiting: 0, idle: 1, failed: 0 } }],
  } satisfies FleetStatus,
};

const v = (version: number, extra: Partial<ArtifactVersion> = {}): ArtifactVersion => ({
  version,
  title: "Dependency sweep",
  format: "md",
  by: "Sweep the dependencies",
  at: AT,
  bytes: 120,
  ...extra,
});
const SWEEP = [v(2), v(1)];
const CHART = v(1, { title: "Build times", format: "html", by: "Lead" });
const LIST: ArtifactSummary[] = [
  { name: "dependency-sweep", newest: SWEEP[0] ?? v(2) },
  { name: "build-times", newest: CHART },
];
const FILES: ChatFile[] = [
  { attachmentId: "F7", name: "itinerary.pdf", mime: "application/pdf", bytes: 2048, at: AT },
  { attachmentId: "F3", name: "checkout-after.png", mime: "image/png", bytes: 512, at: AT },
];
let files: ChatFile[] = FILES;
let list: ArtifactSummary[] = LIST;
const CONTENT: Record<string, string> = {
  "dependency-sweep@2": "# Sweep\n\nAll **current** now.\n\n<script>alert(1)</script>",
  "dependency-sweep@1": "# Sweep\n\n- 12 crates behind",
  "build-times@1": "<!doctype html><svg id=c></svg><script>c.innerHTML='<rect width=40 height=10/>'</script>",
};

beforeAll(async () => {
  await import("../../ui/markdown/MarkdownBody");
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  forgetViews();
  framed.length = 0;
  opened.length = 0;
  files = FILES;
  list = LIST;
  window.location.hash = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const answer = (tool: string, input: Record<string, unknown>): unknown => {
  if (tool === "artifacts_list") return { artifacts: list, files };
  if (tool === "artifact_get") {
    const name = String(input["name"]);
    const versions = name === "dependency-sweep" ? SWEEP : [CHART];
    const version = typeof input["version"] === "number" ? input["version"] : (versions[0]?.version ?? 1);
    return { name, artifact: versions.find((x) => x.version === version), content: CONTENT[`${name}@${String(version)}`] ?? "", versions };
  }
  return {};
};

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const mount = async (ui: ReactNode, features: string[] = ["artifacts"]) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => Promise.resolve({ ok: true, output: answer(tool, input as Record<string, unknown>) } as never),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  act(() => {
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>{ui}</DataProvider>
      </UiProvider>,
    );
  });
  act(() => {
    send(live(features));
    send(snapshot);
  });
  await settle();
};

const click = async (el: Element | null | undefined) => {
  if (!(el instanceof HTMLElement)) throw new Error("nothing to click");
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
};
const view = (artifact: string | null, version?: number) => <ArtifactsTabView project={SHOP} artifact={artifact} version={version} onWide={() => undefined} />;

it("gives the panel an Artifacts section once the hub serves it and the chat has one", async () => {
  await mount(<ProjectPanel project={SHOP} view={{ tab: "checklist" }} onWide={() => undefined} />);
  expect([...host.querySelectorAll("[data-section]")].map((t) => t.getAttribute("data-section"))).toEqual(["agents", "shipping", "plan", "artifacts", "history"]);
  act(() => root.unmount());
  root = createRoot(host);
  await mount(<ProjectPanel project={SHOP} view={{ tab: "checklist" }} onWide={() => undefined} />, []);
  expect(host.querySelector("[data-section=artifacts]")).toBeNull();
});

it("lists the artifacts newest first, each one line: its title and when; its format, who and version are its hover's", async () => {
  await mount(view(null));
  const rows = [...host.querySelectorAll<HTMLElement>("[data-artifact]")];
  expect(rows.map((r) => r.getAttribute("data-artifact"))).toEqual(["dependency-sweep", "build-times"]);
  expect(rows[0]?.textContent).toMatch(/^Dependency sweep[^·]+$/u);
  expect(rows[1]?.textContent).toMatch(/^Build times[^·]+$/u);
  expect(host.textContent).not.toMatch(/Markdown|HTML|version/u);
  act(() => rows[0]?.focus());
  expect(document.querySelector("[role='tooltip']")?.textContent).toBe("Markdown · Sweep the dependencies · version 2");
  await click(rows[0]);
  expect(window.location.hash).toBe("#/project/devbox/shop/artifacts/dependency-sweep");
});

it("lists the files sent in the chat under the artifacts, each opening in this computer's app or saved", async () => {
  await mount(view(null));
  expect(host.querySelector("section[aria-label='Files'] [data-group-label]")?.textContent).toBe("Files2");
  const rows = [...host.querySelectorAll<HTMLElement>("[data-file]")];
  expect(rows.map((r) => r.textContent)).toEqual([expect.stringMatching(/^itinerary\.pdf[^·]+$/u), expect.stringMatching(/^checkout-after\.png[^·]+$/u)]);
  // What kind of file and how big is its hover's.
  act(() => rows[0]?.focus());
  expect(document.querySelector("[role='tooltip']")?.textContent).toBe("PDF · 2 KB");
  act(() => rows[0]?.blur());
  await click(rows[0]);
  await click(host.querySelector("[aria-label='Save checkout-after.png']"));
  expect(opened).toEqual(["open F7", "save F3"]);
});

it("shows the files alone when nothing is published, and the empty state only when neither is there", async () => {
  list = [];
  await mount(view(null));
  expect(host.querySelector("[data-artifact]")).toBeNull();
  expect(host.querySelectorAll("[data-file]")).toHaveLength(2);
  act(() => root.unmount());
  root = createRoot(host);
  files = [];
  await mount(view(null));
  expect(host.querySelector("[data-screen='artifacts.empty']")?.textContent).toBe("No artifacts yet");
});

it("renders a Markdown report in the app's style, raw HTML dropped, with every version to pick", async () => {
  await mount(view("dependency-sweep"));
  expect(host.querySelector("[data-screen=artifact]")).not.toBeNull();
  expect(host.querySelector("h1")?.textContent).toBe("Sweep");
  expect(host.querySelector("strong")?.textContent).toBe("current");
  expect(host.querySelector("script")).toBeNull();
  expect(host.querySelector("[aria-label=Version]")?.textContent).toContain("Version 2 (newest)");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Show the newest")).toBe(false);
});

it("opens an older version the card named, with the way back to the newest", async () => {
  await mount(view("dependency-sweep", 1));
  expect(host.textContent).toContain("12 crates behind");
  expect(host.querySelector("[aria-label=Version]")?.textContent).toContain("Version 1");
  await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Show the newest"));
  expect(window.location.hash).toBe("#/project/devbox/shop/artifacts/dependency-sweep");
});

it("frames an HTML report at main's sandboxed address: scripts only, never same-origin or srcdoc", async () => {
  await mount(view("build-times"));
  expect(host.querySelector("[data-screen='artifact.html']")).not.toBeNull();
  const frame = host.querySelector("iframe");
  expect(framed).toEqual([CONTENT["build-times@1"]]);
  expect(frame?.getAttribute("src")).toBe(FRAME);
  expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame?.hasAttribute("srcdoc")).toBe(false);
  // The page's own script never runs in the app's document.
  expect(host.querySelector("svg#c")).toBeNull();
});

it("puts a card in the chat that opens the version it published", async () => {
  await mount(<ArtifactCard project={SHOP} published={{ name: "dependency-sweep", version: 2, title: "Dependency sweep", format: "md", by: "Sweep the dependencies" }} at="16:02" />);
  const card = host.querySelector("[data-artifact-card]");
  expect(card?.textContent).toBe("Dependency sweepMarkdown · version 2 · Sweep the dependencies16:02");
  await click(card);
  expect(window.location.hash).toBe("#/project/devbox/shop/artifacts/dependency-sweep/2");
});

it("turns an artifact link in a later message into a link that opens that artifact", async () => {
  await mount(<Message project={SHOP} text={"Charts in [build times](artifact:build-times), the old sweep in [v1](artifact:dependency-sweep@1)."} />);
  const links = [...host.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
  expect(links).toEqual([
    ["build times", "#/project/devbox/shop/artifacts/build-times"],
    ["v1", "#/project/devbox/shop/artifacts/dependency-sweep/1"],
  ]);
});
