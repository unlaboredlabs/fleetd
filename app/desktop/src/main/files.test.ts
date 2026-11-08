// A chat's file opened on this computer: main reads it from the hub, writes it under a name of its type in a folder of
// its own, and opens that; a hub that can't give it, or an app that won't open it, says why.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const opened: string[] = [];
let openFails = "";
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: vi.fn() },
  shell: {
    openPath: (path: string) => {
      opened.push(path);
      return Promise.resolve(openFails);
    },
    showItemInFolder: vi.fn(),
  },
}));

const { openFile } = await import("./files");
const { READ_PIECE_BYTES } = await import("../shared/transfer");

const request = { projectRef: { machineId: "devbox", projectId: "ivy" }, attachmentId: "F7" };
const dir = mkdtempSync(join(tmpdir(), "fleetd-files-test-"));

afterEach(() => {
  opened.length = 0;
  openFails = "";
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("writes the file under a name of its type and opens it", async () => {
  const asked: unknown[] = [];
  const call = (tool: string, input: unknown) => {
    asked.push([tool, input]);
    return Promise.resolve({ ok: true as const, output: { name: "run.command", mime: "text/plain", dataB64: Buffer.from("echo hi").toString("base64") } });
  };
  expect(await openFile(call, request, dir)).toEqual({ ok: true });
  // From its start, in pieces: a hub that sends no offset sent it whole.
  expect(asked).toEqual([["attachment_get", { ...request, offset: 0, length: READ_PIECE_BYTES }]]);
  expect(opened).toHaveLength(1);
  const path = opened[0] ?? "";
  expect(basename(path)).toBe("run.command.txt");
  expect(dirname(dirname(path))).toBe(join(dir, "fleetd-files"));
  expect(readFileSync(path, "utf8")).toBe("echo hi");
});

it("says why when the hub can't give it or nothing opens it", async () => {
  const refused = () => Promise.resolve({ ok: false as const, error: { code: "not_found", message: "No attachment F7 in this project." } });
  expect(await openFile(refused, request, dir)).toEqual({ ok: false, message: "The file couldn't be read: No attachment F7 in this project." });
  openFails = "No application knows how to open it";
  const pdf = () => Promise.resolve({ ok: true as const, output: { name: "plan.pdf", mime: "application/pdf", dataB64: "JVBERi0=" } });
  expect(await openFile(pdf, request, dir)).toEqual({ ok: false, message: "plan.pdf didn't open: No application knows how to open it" });
});
