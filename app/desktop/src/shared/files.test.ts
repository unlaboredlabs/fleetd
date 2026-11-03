// What a chat takes, by a file's name and whether its bytes are text, and the name a file is opened or saved under.
import { expect, it } from "vitest";
import { glyphOf, kindOf, mimeOfFile, safeFileName } from "./files";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

it("takes PDFs, Office files, CSV, text and images by name, and other text by its bytes", () => {
  expect(mimeOfFile("lease.PDF", false)).toBe("application/pdf");
  expect(mimeOfFile("lease.docx", false)).toBe(DOCX);
  expect(mimeOfFile("bank.xlsx", false)).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  expect(mimeOfFile("deck.pptx", false)).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
  expect(mimeOfFile("bank.csv", true)).toBe("text/csv");
  expect(mimeOfFile("invite.ics", true)).toBe("text/plain");
  expect(mimeOfFile("Makefile", true)).toBe("text/plain");
  expect(mimeOfFile("song.mp3", false)).toBeUndefined();
  expect(mimeOfFile("old.xls", false)).toBeUndefined();
});

it("names each kind for its card", () => {
  expect([kindOf("application/pdf"), kindOf(DOCX), kindOf("text/csv"), kindOf("image/png"), kindOf("audio/x-new")]).toEqual(["PDF", "Word document", "CSV", "Image", "File"]);
  expect([glyphOf("text/csv"), glyphOf(DOCX), glyphOf("application/zip")]).toEqual(["sheet", "doc", "zip"]);
});

it("keeps a file under a name of its type, with no folders, so opening it never runs it", () => {
  expect(safeFileName("itinerary.pdf", "application/pdf")).toBe("itinerary.pdf");
  expect(safeFileName("run.command", "text/plain")).toBe("run.command.txt");
  expect(safeFileName("../../.ssh/key.pdf", "application/pdf")).toBe("_.._.ssh_key.pdf");
  expect(safeFileName("receipts.pdf", "text/csv")).toBe("receipts.pdf.csv");
  expect(safeFileName("...", "application/pdf")).toBe("file.pdf");
});
