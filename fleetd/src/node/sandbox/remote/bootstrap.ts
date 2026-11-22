// How the node's own fleetd reaches a hosted box. A provider's template may hold another fleetd build than the node's
// (one built for an older release, a build of one's own), so each box starts this small script under the template's Bun
// first (`bootArgv`), on the guest's port, taking a WebSocket only with the box's secret, as the guest does. Over that one
// link the node hands it its fleetd (`deliver`): the URL of this very build's release asset, which the box fetches
// itself, or, where there is none (a build of one's own), the binary's bytes. A template built for this release holds
// that build at FLEETD_PATH already: the script starts it there when its SHA-256 is the one asked for, fetching
// nothing. The script checks the SHA-256, then runs `fleetd sandbox-guest` on the same port and waits on it: the node
// dials again and finds the guest.
//
// The script's text holds no value: the secret is its environment's, given at start, never at create.
import type { Duplex as WebDuplex } from "../../../sandbox/providers/index.ts";
import { FLEETD_PATH, GUEST_PORT, SECRET_HEADER } from "../../../sandbox/providers/index.ts";
import { noQuery, shq } from "../../../sandbox/providers/shell.ts";
import boot from "./boot.mjs" with { type: "text" };

/** Where the box keeps fleetd and the guest's files: the box user's own, outside any path the node mirrors. */
export let BOX_DIR = "/tmp/.fleetd-box";

/** Tests: a stand-in box runs on the test's machine, where test runs side by side would share one BOX_DIR (its
 * sessions' bundles, which a box's sealing clears by a glob): each test process takes its own (test/preload.ts). */
export function setBoxDir(dir: string): void {
  BOX_DIR = dir;
}

/** The script, run under the template's Bun with `bun -e`: in ./boot.mjs, a text file, so this module holds no in-box
 * code of its own (it's box side: docs/CONTRIBUTING.md "The package"). */
const SCRIPT = `\n${boot.replaceAll("{{SECRET_HEADER}}", SECRET_HEADER)}`;

/** The box's first command and its environment besides the secret. It first makes `dirs` (outermost first) the box
 * user's, with sudo where the user can't: the machine's paths the session's files take, the node.sock's among them,
 * which the guest listens at as soon as the node dials. */
export function bootArgv(dirs: string[] = []): { argv: string[]; env: Record<string, string> } {
  const make = [...new Set(dirs.filter((d) => d.startsWith("/") && d !== "/"))]
    .sort((a, b) => a.length - b.length)
    .map((d) => `d=${shq(d)}; [ -d "$d" ] || mkdir -p "$d" 2>/dev/null || sudo -n mkdir -p "$d"; [ -w "$d" ] || sudo -n chown "$(id -u):$(id -g)" "$d"`);
  return {
    argv: ["sh", "-c", [...make, `exec bun -e ${shq(SCRIPT)}`].join("; ")],
    env: { FLEETD_BOOT_PORT: String(GUEST_PORT), FLEETD_BOOT_DIR: BOX_DIR, FLEETD_BOOT_BAKED: FLEETD_PATH },
  };
}

/** Where the node's fleetd comes from: its release asset's URL when it has one, and its bytes otherwise. */
export type Source = { sha256: string; url?: string; bytes: () => Promise<Uint8Array> };

/** The most bytes sent in one WebSocket message. */
const PIECE = 1 << 20;

/** What the box's first message on a fresh link says it is: the bootstrap, or the guest itself (its mux frames);
 * undefined when the link closed first (a provider's proxy takes a link before anything in the box listens). */
export async function firstWord(link: WebDuplex): Promise<"bootstrap" | "guest" | undefined> {
  const reader = link.readable.getReader();
  try {
    const { value } = await Promise.race([reader.read(), Bun.sleep(10_000).then(() => ({ value: undefined }))]);
    if (!value) return undefined;
    return value[0] === 0x7b && new TextDecoder().decode(value).includes('"bootstrap"') ? "bootstrap" : "guest";
  } finally {
    reader.releaseLock();
  }
}

/** How fleetd really reached the box (`deliver`): the template's own build, started where it is (`template`), fetched
 * by the box itself at the release asset's address (`address`), or its bytes sent over the link (`link`). `cause`,
 * only on `link` after the box's own fetch failed: why it failed, in the box's words, any URL's query left out. */
export type Delivered = { way: "template" | "address" | "link"; cause?: string };

/** Hands the bootstrap on `link` this node's fleetd; resolves once the box checked it and starts the guest, with the
 * way it got there. */
export async function deliver(link: WebDuplex, source: Source): Promise<Delivered> {
  const reader = link.readable.getReader();
  const writer = link.writable.getWriter();
  const answer = async (): Promise<{ ok?: boolean; error?: string; way?: string }> => {
    const { value, done } = await Promise.race([reader.read(), Bun.sleep(180_000).then(() => ({ value: undefined, done: true }))]);
    if (done || !value) throw new Error("the box didn't say whether it took fleetd");
    return JSON.parse(new TextDecoder().decode(value)) as { ok?: boolean; error?: string; way?: string };
  };
  try {
    let cause: string | undefined;
    if (source.url) {
      await sendText(link, writer, { url: source.url, sha256: source.sha256 });
      const a = await answer();
      if (a.ok) return { way: a.way === "template" ? "template" : "address" };
      cause = noQuery(a.error ?? "no reason given");
    }
    const plain = await source.bytes();
    const packed = Bun.gzipSync(plain as Uint8Array<ArrayBuffer>, { level: 1 });
    await sendText(link, writer, { size: packed.length, sha256: source.sha256, gzip: true });
    for (let at = 0; at < packed.length; at += PIECE) await writer.write(packed.subarray(at, at + PIECE));
    const a = await answer();
    if (!a.ok) throw new Error(`the box didn't take fleetd: ${noQuery(a.error ?? "no reason given")}`);
    return { way: a.way === "template" ? "template" : "link", ...(cause ? { cause } : {}) };
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

/** A WebSocket text message (the stream's writes go as binary ones, which the script takes as fleetd's bytes). */
async function sendText(link: WebDuplex, writer: WritableStreamDefaultWriter<Uint8Array>, o: unknown): Promise<void> {
  await writer.ready;
  link.sendText(JSON.stringify(o));
}
