// The rules for a bot's files that a hosted box shares with the node (fleetd/box/file_rules, fleetd/box/chat_file) are
// the ones the node's own modules use, not copies of them.
import { expect, test } from "bun:test";
import * as chat from "../../src/node/actions/chat_file.ts";
import * as image from "../../src/node/actions/image.ts";
import * as rules from "../../src/node/sessions/file_rules.ts";
import * as files from "../../src/node/sessions/files.ts";

test("the node's files and image modules use the box-side rules themselves", () => {
  expect([files.ATTACHMENTS_DIR, files.attachmentPathOk, files.rank, files.score]).toEqual([rules.ATTACHMENTS_DIR, rules.attachmentPathOk, rules.rank, rules.score]);
  expect([image.ofFile, image.ofImage, image.ofName]).toEqual([chat.ofFile, chat.ofImage, chat.ofName]);
});

test("a resolved path is within its folder only at or under it, never beside it", () => {
  expect(rules.within("/w/bot", "/w/bot")).toBe(true);
  expect(rules.within("/w/bot", "/w/bot/a/b.png")).toBe(true);
  expect(rules.within("/w/bot", "/w/bot2/a.png")).toBe(false);
  expect(rules.within("/w/bot", "/w")).toBe(false);
  expect(rules.within("/", "/etc/hosts")).toBe(true);
});

test("an image is the one its name says by its bytes; a chat file by its name and bytes together", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  expect(chat.chatMime("a.png", png, false)).toBe("image/png");
  expect(chat.chatMime("a.jpg", png, false)).toBeUndefined();
  expect(chat.chatMime("a.jpg", png, true)).toBe("image/png");
  expect(chat.chatMime("notes.md", new TextEncoder().encode("# hi\n"), true)).toBe("text/plain");
  expect(chat.chatMime("a.pdf", new TextEncoder().encode("# hi\n"), true)).toBeUndefined();
  expect(chat.refused.outside("x.png", "/w", false)).toBe("x.png is outside your working directory /w: only an image you made there can go in the chat");
});
