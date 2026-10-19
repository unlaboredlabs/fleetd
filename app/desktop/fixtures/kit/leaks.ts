// What must never be in a fixture file, recorded or generated. `pnpm fixtures` and CI check every file against
// LEAKS; the recording person's own names (private repos, hosts) are a local list in FLEETD_FIXTURE_DENYLIST, kept
// outside the repo since the list itself would say what it hides.
import fs from "node:fs";
import os from "node:os";

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Patterns no fixture may contain, whoever built it. */
export const LEAKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u],
  ["an Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{10,}/u],
  ["a Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/u],
  ["a JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u],
  ["a fleetd key", /\bfld_(?!redacted)[a-z2-7]{20,}/u],
  // git@github.com:owner/repo is a remote, not someone's address.
  ["an email address", /(?<![A-Za-z0-9._%+-])(?!git@github\.com\b)[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}\b/u],
  ["a tailnet IPv4 address", /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/u],
  ["a tailnet IPv6 address", /\bfd7a:115c:a1e0:/iu],
  ["a tailnet host", /\.ts\.net\b/iu],
  ["a home directory other than /home/dev", /\/(?:home|Users)\/(?!dev\b)[A-Za-z0-9._-]+/u],
  ["a GitHub repo outside acme", /github\.com[/:](?!acme\/)[A-Za-z0-9-]+\/[A-Za-z0-9._-]+/iu],
  ["a repo outside acme", /"(?:repo|fullName|nameWithOwner)": ?"(?!acme\/)[A-Za-z0-9-]+\/[A-Za-z0-9._-]+"/u],
  ["the lab", /fleetd-lab|fleetd-testbed|unlaboredlabs/iu],
];

/** This machine's user and host, and FLEETD_FIXTURE_DENYLIST's words: local, so only checked where they are set. */
export const localWords = (): Array<readonly [string, RegExp]> => {
  // A CI runner's user and host are generic words ("runner") that fixtures may well contain.
  const words = process.env["CI"] === undefined ? [os.userInfo().username, os.hostname()] : [];
  const file = process.env["FLEETD_FIXTURE_DENYLIST"];
  if (file !== undefined) words.push(...fs.readFileSync(file, "utf8").split("\n"));
  return words
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && w !== "dev")
    .map((w) => ["a denylisted word", new RegExp(`(?<![A-Za-z0-9])${escape(w)}(?![A-Za-z0-9])`, "iu")] as const);
};

const scan = (text: string, where = ""): Array<string> =>
  [...LEAKS, ...localWords()].flatMap(([what, pattern]) => {
    const hit = pattern.exec(text);
    return hit === null ? [] : [`${what}${where}: "${text.slice(Math.max(0, hit.index - 40), hit.index + 40).replaceAll("\n", " ")}"`];
  });

const DATA_URL = /data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=.-]+)*;base64,([A-Za-z0-9+/]+=*)/gu;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** The chunks that only draw pixels; anything else (tEXt, iTXt, zTXt, eXIf, tIME…) can carry text. */
const PIXEL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "sRGB", "cHRM", "pHYs"]);

/** A text file's content however it is encoded: UTF-8, or UTF-16 either way round (a BOM or NUL bytes give it away). */
const asText = (data: Buffer): string => {
  if (!data.includes(0)) return data.toString("utf8");
  const bigEndian = data[0] === 0xfe && data[1] === 0xff;
  const le = bigEndian ? Buffer.from(data).swap16() : data;
  return `${data.toString("utf8")}\n${le.subarray(0, le.length - (le.length % 2)).toString("utf16le")}`;
};

/** Problems with one attached file's bytes: text is scanned whole; a PNG may only hold pixel chunks; nothing else. */
const attachmentLeaks = (mime: string, data: Buffer, name: string): Array<string> => {
  const where = ` in attachment ${name}`;
  if (mime.startsWith("text/")) return scan(asText(data), where);
  if (mime !== "image/png") return [`an attachment the check can't read${where} (${mime}): use text/* or a metadata-free PNG`];
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) return [`a PNG that isn't one${where}`];
  const out: Array<string> = [];
  for (let at = 8; at + 8 <= data.length; ) {
    const length = data.readUInt32BE(at);
    const type = data.toString("latin1", at + 4, at + 8);
    if (!PIXEL_CHUNKS.has(type)) out.push(`PNG metadata (${type})${where}`);
    at += 12 + length;
  }
  return out;
};

/** Every attachment's bytes in a fixture (any object with dataB64), which base64 hides from a scan of the JSON. */
const attachedFiles = (v: unknown, out: Array<string>): void => {
  if (Array.isArray(v)) for (const x of v) attachedFiles(x, out);
  else if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o["dataB64"] === "string") {
      const mime = typeof o["mime"] === "string" ? o["mime"] : "unknown";
      out.push(...attachmentLeaks(mime, Buffer.from(o["dataB64"], "base64"), typeof o["name"] === "string" ? o["name"] : "unnamed"));
    }
    for (const x of Object.values(o)) attachedFiles(x, out);
  }
};

/** Every leak in `text` (a fixture's JSON, or any text), as "<what>: …context…", attachments decoded and checked. */
export const findLeaks = (text: string): Array<string> => {
  const leaks = scan(text);
  // data: URLs carry files inside message text, base64 again.
  for (const m of text.matchAll(DATA_URL)) leaks.push(...attachmentLeaks(m[1] ?? "unknown", Buffer.from(m[2] ?? "", "base64"), "a data: URL"));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return leaks;
  }
  attachedFiles(json, leaks);
  return leaks;
};

export const assertClean = (name: string, text: string): void => {
  const leaks = findLeaks(text);
  if (leaks.length > 0) throw new Error(`${name} leaks ${leaks.join("; ")}`);
};
