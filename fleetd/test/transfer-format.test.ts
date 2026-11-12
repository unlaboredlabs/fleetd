// The export file's pure parts (hub/transfer: tar.ts, format.ts, seal.ts), the ones the cloud service reads and writes
// the same file with: the container, the version rule, the checksums and the passphrase's seal. No hub here.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { HubExportHeader, HubExportManifest } from "../src/shared/contracts.ts";
import { newKey, openItem as vaultOpen, sealItem as vaultSeal } from "../src/hub/vault/crypto.ts";
import {
  FORMAT,
  FORMAT_VERSION,
  HEADER_PATH,
  jsonBytes,
  MANIFEST_PATH,
  MANIFEST_SUM_PATH,
  PartWriter,
  readHeader,
  readPart,
  safeName,
  sha256Hex,
  tablePartPath,
  TransferError,
  verifyExport,
} from "../src/hub/transfer/format.ts";
import { EXPORT_KEY_ID, itemFromExport, itemToExport, newSecrets, openSecrets, openValue, sealValue } from "../src/hub/transfer/seal.ts";
import { BLOCK, bodyBytes, readTarHeader, TarError, tarEntries, tarHeader, TarWriter } from "../src/hub/transfer/tar.ts";

const N = 1024;
const text = (s: string) => new TextEncoder().encode(s);

/** A tar of `entries`, whole. */
async function tarOf(entries: [string, Uint8Array][]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const tar = new TarWriter((c) => void chunks.push(c.slice()));
  for (const [path, body] of entries) await tar.entry(path, body.length, body);
  await tar.end();
  return new Uint8Array(Buffer.concat(chunks));
}

/** `bytes` as a stream of `size`-byte chunks, so entries straddle them. */
async function* chunked(bytes: Uint8Array, size = 700): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

async function listing(bytes: Uint8Array, size?: number): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for await (const entry of tarEntries(chunked(bytes, size))) out.push([entry.path, Buffer.from(await bodyBytes(entry, 1 << 20)).toString("utf8")]);
  return out;
}

const failure = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe("the export's container", () => {
  test("entries come back as they went in, whatever sizes the stream arrives in", async () => {
    const entries: [string, Uint8Array][] = [
      ["a.json", text("{}\n")],
      ["empty", text("")],
      ["tables/people/000001.jsonl.gz", new Uint8Array(1500).fill(7)],
      ["block", new Uint8Array(BLOCK).fill(9)],
    ];
    const bytes = await tarOf(entries);
    expect(bytes.length % BLOCK).toBe(0);
    const want = entries.map(([p, b]) => [p, Buffer.from(b).toString("utf8")] as [string, string]);
    for (const size of [1, 511, 512, 700, 1 << 20]) expect(await listing(bytes, size)).toEqual(want);
  });

  test("system tar lists it", async () => {
    if (!Bun.which("tar")) return;
    const bytes = await tarOf([["fleetd-export.json", text("{}\n")], ["files/00000001", text("hello")]]);
    const tar = Bun.spawn(["tar", "tf", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    tar.stdin.write(bytes);
    await tar.stdin.end();
    expect((await new Response(tar.stdout).text()).trim().split("\n")).toEqual(["fleetd-export.json", "files/00000001"]);
    expect(await tar.exited).toBe(0);
  });

  test("an entry the reader leaves unread is skipped", async () => {
    const bytes = await tarOf([["one", new Uint8Array(3000).fill(1)], ["two", text("2")]]);
    const paths: string[] = [];
    for await (const entry of tarEntries(chunked(bytes))) paths.push(entry.path);
    expect(paths).toEqual(["one", "two"]);
  });

  test("a size past ustar's octal field is written and read", () => {
    const size = 9 * 1024 ** 3;
    expect(readTarHeader(tarHeader("files/00000001", size))).toEqual({ path: "files/00000001", size });
    expect(readTarHeader(tarHeader("files/00000001", 0o77777777777))).toEqual({ path: "files/00000001", size: 0o77777777777 });
    expect(readTarHeader(new Uint8Array(BLOCK))).toBeUndefined();
  });

  test("a body shorter than its size is refused; a longer one is cut", async () => {
    const tar = new TarWriter(() => {});
    expect(await failure(tar.entry("short", 10, text("abc")))).toBeInstanceOf(TarError);
    expect(await tar.entry("long", 3, text("abcdef"))).toEqual({ bytes: 3, sha256: createHash("sha256").update("abc").digest("hex") });
  });

  test("the reader refuses what isn't a whole archive of plain files", async () => {
    const good = await tarOf([["one", text("1234")]]);
    const flipped = (at: number) => {
      const b = good.slice();
      b[at]! ^= 0x01;
      return b;
    };
    const link = good.slice();
    link[156] = 0x32;
    const bad: [string, Uint8Array][] = [
      ["cut short", good.subarray(0, good.length - BLOCK)],
      ["cut inside an entry", good.subarray(0, BLOCK + 2)],
      ["a changed header", flipped(3)],
      ["a changed size", flipped(130)],
      ["padding that isn't empty", flipped(BLOCK + 100)],
      ["something after the end", flipped(good.length - 1)],
      ["a link", link],
      ["no end at all", good.subarray(0, 2 * BLOCK)],
    ];
    for (const [what, bytes] of bad) expect({ what, refused: (await failure(listing(bytes))) instanceof TarError }).toEqual({ what, refused: true });
    expect(() => tarHeader("x".repeat(101), 1)).toThrow(TarError);
  });
});

describe("the export's rows", () => {
  test("a table's rows split into parts and read back", () => {
    const writer = new PartWriter(200);
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `row ${i} “é”\n`, data: null, picture: { $bytes: "AAEC" } }));
    const parts = rows.flatMap((r) => writer.add(r) ?? []);
    const last = writer.end();
    if (last) parts.push(last);
    expect(writer.end()).toBeUndefined();
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.reduce((n, p) => n + p.rows, 0)).toBe(40);
    expect(parts.flatMap((p) => readPart("tables/t/000001.jsonl.gz", p.gz))).toEqual(rows);
  });

  test("a part that doesn't unpack or holds something else is damage", () => {
    expect(new PartWriter().end()).toBeUndefined();
    const reason = (gz: Uint8Array) => {
      try {
        readPart("tables/t/000001.jsonl.gz", gz);
      } catch (e) {
        return (e as TransferError).reason;
      }
      return "read";
    };
    expect(reason(text("not gzip"))).toBe("damaged");
    expect(reason(gzipSync(text("[1,2]\n")))).toBe("damaged");
    expect(reason(gzipSync(text("{oops\n")))).toBe("damaged");
    expect(reason(gzipSync(text('{"a":1}\n')))).toBe("read");
  });

  test("a file's name stays inside its area", () => {
    expect(["a", "a/b.md", "sha", "x/.keep"].filter((n) => !safeName(n))).toEqual([]);
    expect(["", "/etc/passwd", "../x", "a/../b", "a//b", "a/", "./a", "a\\b", "a\0"].filter(safeName)).toEqual([]);
  });
});

/** A small, well-formed export, and the pieces to break it with. */
async function sample(change: { header?: Partial<HubExportHeader>; manifest?: (m: HubExportManifest) => void; entries?: (e: [string, Uint8Array][]) => [string, Uint8Array][] } = {}) {
  const header: HubExportHeader = { createdAt: "2026-10-01T00:00:00.000Z", fleetd: "1.2.3", format: FORMAT, version: FORMAT_VERSION, ...change.header };
  const headerBytes = jsonBytes(header);
  const writer = new PartWriter();
  writer.add({ person_id: "p1", name: "Ada" });
  const gz = writer.end()!.gz;
  const file = text("hello");
  const at = (path: string, bytes: Uint8Array) => ({ path, bytes: bytes.length, sha256: sha256Hex(bytes) });
  const partPath = tablePartPath("people", 1);
  const manifest: HubExportManifest = {
    createdAt: header.createdAt,
    fleetd: header.fleetd,
    files: [{ area: "attachments", files: [{ name: sha256Hex(file), ...at("files/00000001", file) }] }],
    format: FORMAT,
    header: at(HEADER_PATH, headerBytes),
    machines: [{ machineId: "devbox", name: "devbox" }],
    schema: [{ name: "202601010000_first", sha256: "0".repeat(64) }],
    tables: [{ name: "people", columns: ["person_id", "name"], rows: 1, parts: [{ rows: 1, ...at(partPath, gz) }] }],
    version: header.version,
  };
  change.manifest?.(manifest);
  const manifestBytes = jsonBytes(manifest);
  const entries: [string, Uint8Array][] = [
    [HEADER_PATH, headerBytes],
    [partPath, gz],
    ["files/00000001", file],
    [MANIFEST_PATH, manifestBytes],
    [MANIFEST_SUM_PATH, text(`${sha256Hex(manifestBytes)}\n`)],
  ];
  return tarOf(change.entries ? change.entries(entries) : entries);
}

const verdict = async (bytes: Uint8Array): Promise<string> => {
  const e = await failure(verifyExport(chunked(bytes, 4096)));
  if (e === undefined) return "ok";
  if (!(e instanceof TransferError)) throw e;
  return `${e.reason}: ${e.message}`;
};

describe("checking an export", () => {
  test("a whole one checks out", async () => {
    const checked = await verifyExport(chunked(await sample()));
    expect(checked.header.fleetd).toBe("1.2.3");
    expect(checked.manifest.tables.map((t) => [t.name, t.rows])).toEqual([["people", 1]]);
  });

  test("the version rule: a newer format is refused with the line that says to update fleetd", async () => {
    const newer = await sample({ header: { version: FORMAT_VERSION + 1, fleetd: "9.0.0" } });
    expect(await verdict(newer)).toBe(
      `newer: That export is format version ${FORMAT_VERSION + 1}, written by fleetd 9.0.0; this fleetd reads up to version ${FORMAT_VERSION}. Update fleetd (fleetd update), then import it again.`,
    );
    // The rule reads the header alone: whatever a later version puts after it isn't looked at.
    const strange = jsonBytes({ format: FORMAT, version: 7, fleetd: "9.0.0", something: { new: true } });
    expect(() => readHeader(strange)).toThrow(/Update fleetd/);
    expect(readHeader(jsonBytes({ createdAt: "2026-10-01T00:00:00.000Z", fleetd: "1.0.0", format: FORMAT, version: 1 })).version).toBe(1);
  });

  test("another file isn't an export", async () => {
    const not = "not_an_export: That file isn't a fleetd export.";
    expect(await verdict(text("hello, I am a text file\n"))).toBe(not);
    expect(await verdict(new Uint8Array(0))).toBe(not);
    expect(await verdict(await tarOf([["notes.txt", text("hi")]]))).toBe(not);
    expect(await verdict(await tarOf([[HEADER_PATH, jsonBytes({ format: "something-else", version: 1 })]]))).toBe(not);
  });

  test("every byte is under a checksum: one changed anywhere is damage", async () => {
    const good = await sample();
    expect(await verdict(good)).toBe("ok");
    for (let at = 0; at < good.length; at += 97) {
      const bad = good.slice();
      bad[at]! ^= 0x20;
      const v = await verdict(bad);
      expect({ at, damaged: v.startsWith("damaged: ") || v.startsWith("not_an_export: ") }).toEqual({ at, damaged: true });
    }
    expect(await verdict(good.subarray(0, good.length - 2 * BLOCK))).toStartWith("damaged: ");
  });

  test("a manifest that doesn't describe the file is damage", async () => {
    const swap = (e: [string, Uint8Array][], path: string, bytes: Uint8Array) => e.map(([p, b]) => [p, p === path ? bytes : b] as [string, Uint8Array]);
    const cases: [string, Uint8Array][] = [
      ["a part with other bytes", await sample({ entries: (e) => swap(e, "files/00000001", text("jello")) })],
      ["a part gone", await sample({ entries: (e) => e.filter(([p]) => p !== "files/00000001") })],
      ["an entry it doesn't name", await sample({ entries: (e) => [e[0]!, ["files/00000009", text("x")], ...e.slice(1)] })],
      ["an entry twice", await sample({ entries: (e) => [e[0]!, e[1]!, e[1]!, ...e.slice(2)] })],
      ["something after its end", await sample({ entries: (e) => [...e, ["files/00000002", text("x")]] })],
      ["no manifest", await sample({ entries: (e) => e.slice(0, 3) })],
      ["no checksum of the manifest", await sample({ entries: (e) => e.slice(0, 4) })],
      ["another checksum of the manifest", await sample({ entries: (e) => swap(e, MANIFEST_SUM_PATH, text(`${"0".repeat(64)}\n`)) })],
      ["another export's manifest", await sample({ manifest: (m) => void (m.createdAt = "2026-10-02T00:00:00.000Z") })],
      ["rows that don't add up", await sample({ manifest: (m) => void (m.tables[0]!.rows = 2) })],
      ["a file's name that leaves its folder", await sample({ manifest: (m) => void (m.files[0]!.files[0]!.name = "../../hub.sqlite") })],
      ["a column twice", await sample({ manifest: (m) => void (m.tables[0]!.columns = ["name", "name"]) })],
      ["a field the contract doesn't have a shape for", await sample({ manifest: (m) => void ((m.tables[0] as unknown as { rows: string }).rows = "1") })],
    ];
    for (const [what, bytes] of cases) expect({ what, verdict: (await verdict(bytes)).split(":")[0] }).toEqual({ what, verdict: "damaged" });
  });
});

describe("the export's secrets", () => {
  const at = { table: "github_app", column: "sealed_key", row: [1] };

  test("the export's key opens with the passphrase it was written with, and no other", () => {
    const { key, secrets } = newSecrets("correct horse battery", N);
    expect(secrets.kdf).toMatchObject({ alg: "scrypt", N, r: 8, p: 1 });
    expect(JSON.stringify(secrets)).not.toContain(Buffer.from(key).toString("base64"));
    expect(openSecrets(secrets, "correct horse battery")).toEqual(key);
    expect(openSecrets(secrets, "correct horse batterz")).toBeNull();
    expect(openSecrets({ ...secrets, kdf: { ...secrets.kdf, salt: Buffer.from("another salt 16b").toString("base64") } }, "correct horse battery")).toBeNull();
    // Two exports under one passphrase share nothing.
    const again = newSecrets("correct horse battery", N);
    expect(again.secrets.wrapped).not.toBe(secrets.wrapped);
    expect(again.key).not.toEqual(key);
  });

  test("a file's own parameters are held to what a reader will spend", () => {
    const { secrets } = newSecrets("correct horse battery", N);
    for (const kdf of [{ N: 1 << 24 }, { N: 1000 }, { r: 64 }, { p: 99 }, { alg: "pbkdf2" as "scrypt" }]) {
      expect(() => openSecrets({ ...secrets, kdf: { ...secrets.kdf, ...kdf } }, "correct horse battery")).toThrow(/key derivation/);
    }
  });

  test("a sealed value opens only as the value of its own table, column and row", () => {
    const { key } = newSecrets("correct horse battery", N);
    const sealed = sealValue(key, at, text("pem bytes"));
    expect(Buffer.from(sealed, "base64").toString("latin1")).not.toContain("pem bytes");
    expect(Buffer.from(openValue(key, at, sealed)!).toString()).toBe("pem bytes");
    expect(openValue(key, { ...at, row: [2] }, sealed)).toBeNull();
    expect(openValue(key, { ...at, column: "sealed_client_secret" }, sealed)).toBeNull();
    expect(openValue(key, { ...at, table: "hub_links" }, sealed)).toBeNull();
    expect(openValue(newKey(), at, sealed)).toBeNull();
    expect(openValue(key, at, `${sealed.slice(0, -4)}AAA=`)).toBeNull();
  });

  test("a vault item moves from one hub's root key to another's through the export's key, never opened", () => {
    const oldRoot = newKey();
    const newRoot = newKey();
    const { key } = newSecrets("correct horse battery", N);
    const binding = { itemId: "V1", kind: "login", scopeKey: "hub", version: 3 };
    const item = vaultSeal(oldRoot, "k-old", binding, text('{"password":"canary-1"}'));
    const inFile = itemToExport(oldRoot, key, binding, item)!;
    expect(inFile).not.toEqual(item);
    expect(vaultOpen(oldRoot, binding, inFile)).toBeNull();
    expect(itemToExport(newKey(), key, binding, item)).toBeNull();
    const landed = itemFromExport(key, newRoot, "k-new", binding, inFile)!;
    expect(Buffer.from(vaultOpen(newRoot, binding, landed)!).toString()).toBe('{"password":"canary-1"}');
    expect(itemFromExport(newKey(), newRoot, "k-new", binding, inFile)).toBeNull();
    expect(itemFromExport(key, newRoot, "k-new", { ...binding, itemId: "V2" }, inFile)).toBeNull();
    expect(EXPORT_KEY_ID).toBe("export");
  });
});
