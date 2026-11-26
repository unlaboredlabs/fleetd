// @vitest-environment happy-dom
// A chat file opened in the wide panel: a big CSV shows its first rows as a grid read from the file's start only, its
// cells select as a spreadsheet's and copy as cells; JSON folds; Markdown renders; code is numbered; a Word file says
// it opens in its own app. The card's Open lands here for what fleetd shows, and in this computer's app otherwise.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { toBase64 } from "../../../shared/base64";
import type { FleetStatus } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { ArtifactsTabView } from "../artifacts/ArtifactsPane";
import { FileCard } from "../chat/blocks/FileCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const opened: string[] = [];
const copied: string[] = [];
vi.hoisted(() =>
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    files: {
      open: (_hub: unknown, r: { attachmentId: string }) => (opened.push(`open ${r.attachmentId}`), Promise.resolve({ ok: true })),
      save: (_hub: unknown, r: { attachmentId: string }) => (opened.push(`save ${r.attachmentId}`), Promise.resolve({ ok: true })),
    },
  }),
);
vi.mock("../../ui/lib/clipboard", () => ({ copyText: (text: string) => (copied.push(text), Promise.resolve(true)) }));

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

const enc = new TextEncoder();
const CITIES = ["Oslo", '"Paris, FR"', "Lisbon"];
/** 60,000 rows, a 5.4 MB CSV: past the first piece, the bytes a table reads and its rows. */
const CSV = enc.encode(["city,max_c,rain,note", ...Array.from({ length: 60_000 }, (_, i) => `${CITIES[i % 3] ?? ""},${String(i % 30)},${String(i % 7)},${"x".repeat(80)}`)].join("\n"));
const FILE: Record<string, { name: string; mime: string; bytes: Uint8Array }> = {
  F1: { name: "temps.csv", mime: "text/csv", bytes: CSV },
  F2: { name: "inventory.json", mime: "text/plain", bytes: enc.encode(JSON.stringify({ name: "inventory", warehouses: [{ id: "wh-001", city: "Oslo", stock: { units: 5 } }] })) },
  F3: { name: "summary.md", mime: "text/plain", bytes: enc.encode("# Weekly summary\n\nThe **checkout** fix shipped.") },
  F4: { name: "restock.py", mime: "text/plain", bytes: enc.encode("LOW = 120\n\ndef low(units):\n    return units < LOW\n") },
  F5: { name: "notes.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: new Uint8Array(4000) },
};
/** The bytes each read asked for. */
const reads: { id: string; offset: number; length: number }[] = [];

beforeAll(async () => {
  await import("../../ui/markdown/MarkdownBody");
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  opened.length = 0;
  copied.length = 0;
  reads.length = 0;
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
  if (tool !== "attachment_get") return {};
  const id = String(input["attachmentId"]);
  const f = FILE[id];
  if (f === undefined) return {};
  const offset = Number(input["offset"] ?? 0);
  const length = Number(input["length"] ?? 524288);
  reads.push({ id, offset, length });
  return { attachmentId: id, name: f.name, mime: f.mime, bytes: f.bytes.length, offset, dataB64: toBase64(f.bytes.subarray(offset, offset + length)) };
};

const settle = async () => {
  for (let i = 0; i < 12; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const mount = async (ui: ReactNode) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => Promise.resolve({ ok: true, output: answer(tool, input as Record<string, unknown>) } as never),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  act(() => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>{ui}</DataProvider>
      </UiProvider>,
    );
  });
  act(() => {
    send(live(["artifacts"]));
    send(snapshot);
  });
  await settle();
};
const file = (id: string) => <ArtifactsTabView project={SHOP} artifact={null} version={undefined} file={id} onWide={() => undefined} />;
const mouse = (el: Element | null, type: string, init: MouseEventInit = {}) => {
  if (el === null) throw new Error("no element");
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...init }));
  });
};

it("shows a big CSV's first rows as a grid, read from the file's start and never the whole file", async () => {
  await mount(file("F1"));
  expect(host.querySelector("[data-screen='file.table']")).not.toBeNull();
  expect(host.querySelector("h2")?.textContent).toBe("temps.csv");
  expect(host.textContent).toContain("CSV · 5.4 MB");
  // The first row names the columns; a quoted cell keeps its comma.
  expect([...host.querySelectorAll("[data-r='0']")].map((c) => c.textContent)).toEqual(["city", "max_c", "rain", "note"]);
  expect(host.querySelector("[data-r='2'][data-c='0']")?.textContent).toBe("Paris, FR");
  expect(host.textContent).toContain("10,000+ rows · 4 columns");
  expect(host.textContent).toContain("Showing the first 10,000 rows");
  const read = reads.filter((r) => r.id === "F1").reduce((n, r) => n + r.length, 0);
  expect(read).toBeLessThan(CSV.length);
  expect(Math.max(...reads.map((r) => r.offset + r.length))).toBeLessThanOrEqual(4 * 1024 * 1024);
});

it("selects cells as a spreadsheet does, sums them and copies them as cells", async () => {
  await mount(file("F1"));
  mouse(host.querySelector("[data-r='1'][data-c='1']"), "mousedown");
  mouse(host.querySelector("[data-r='3'][data-c='2']"), "mousemove");
  mouse(host.querySelector("[data-r='3'][data-c='2']"), "mouseup");
  expect(host.textContent).toContain("B2:C4");
  // 0, 1, 2 and 0, 1, 2 (max_c and rain of rows 2 to 4).
  expect(host.textContent).toContain("6 cells · Sum 6 · Average 1");
  act(() => {
    host.querySelector("[role='grid']")?.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
  });
  await settle();
  expect(copied).toEqual(["0\t0\n1\t1\n2\t2"]);
  // A column letter takes its column.
  mouse(host.querySelector("[data-col='0']"), "mousedown");
  expect(host.textContent).toContain("A1:A10000");
});

it("folds JSON below its top level, and opens a branch on a click", async () => {
  await mount(file("F2"));
  expect(host.textContent).toContain("JSON");
  const branch = [...host.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent?.startsWith("warehouses"));
  expect(branch?.getAttribute("aria-expanded")).toBe("false");
  expect(branch?.textContent).toContain("[ 1 item ]");
  await act(async () => {
    (branch as HTMLElement).click();
    await Promise.resolve();
  });
  const item = [...host.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent?.startsWith("0"));
  // A folded object says what it holds and shows its first plain values.
  expect(item?.textContent).toContain('id: "wh-001", city: "Oslo"');
});

it("renders Markdown, numbers code, and says a Word file opens in its own app", async () => {
  await mount(file("F3"));
  expect(host.querySelector("[data-screen='file.markdown'] strong")?.textContent).toBe("checkout");
  act(() => root.unmount());
  root = createRoot(host);
  await mount(file("F4"));
  expect(host.textContent).toContain("Python · 50 B");
  expect([...host.querySelectorAll("[data-lang='python'] [aria-hidden]")].map((n) => n.textContent).slice(0, 4)).toEqual(["1", "2", "3", "4"]);
  act(() => root.unmount());
  root = createRoot(host);
  await mount(file("F5"));
  expect(host.textContent).toContain("This Word document opens in its own app.");
  // Only its name was read: one first piece.
  expect(reads.filter((r) => r.id === "F5")).toHaveLength(1);
});

it("opens a card's file in the panel when fleetd shows it, and in this computer's app when not", async () => {
  await mount(
    <>
      <FileCard project={SHOP} file={{ attachmentId: "F1", name: "temps.csv", mime: "text/csv", bytes: CSV.length }} />
      <FileCard project={SHOP} file={{ attachmentId: "F5", name: "notes.docx", mime: FILE.F5?.mime ?? "", bytes: 4000 }} />
    </>,
  );
  const opens = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Open");
  await act(async () => {
    opens[0]?.click();
    await Promise.resolve();
  });
  expect(window.location.hash).toBe("#/project/devbox/shop/artifacts/file/F1");
  await act(async () => {
    opens[1]?.click();
    await Promise.resolve();
  });
  await settle();
  expect(opened).toEqual(["open F5"]);
  // Its kind says what it is.
  expect(host.textContent).toContain("CSV · 5.4 MB");
});
