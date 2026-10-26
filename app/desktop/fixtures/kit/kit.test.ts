import path from "node:path";
import { describe, expect, it } from "vitest";
import { Fixture } from "./fixture.ts";
import { assertClean, findLeaks } from "./leaks.ts";
import { makeSanitizer } from "./sanitize.ts";
import { LOG, SCREENSHOT, writeChat } from "./chat.ts";
import { fitStrings, validateFixture } from "./schema.ts";

describe("sanitize", () => {
  const lab = "/home/someone/src/fleetd-lab/slot-4";
  const s = makeSanitizer(lab, 4875);

  it("rewrites lab paths, machines, the testbed and ids, stably", () => {
    const raw = {
      path: `${lab}/e2e-4875/home-lab-a/.fleetd/node/worktrees/x`,
      repo: "unlaboredlabs/fleetd-testbed-4",
      url: "http://127.0.0.1:4875/healthz",
      machineId: "lab-b",
      threadId: "dd77f557-c62c-41b1-68b5-a92b70aa3aca",
      ref: "lead.start@786007aa14",
    };
    const out = s.value(raw);
    expect(out).toMatchObject({ path: "/home/dev/.fleetd/node/worktrees/x", repo: "acme/storefront", url: "http://devbox:4790/healthz", machineId: "buildbox" });
    expect(JSON.stringify(out)).not.toContain("dd77f557");
    expect(s.value(raw)).toEqual(out);
  });

  // Samples are built, not written out, so no scanner mistakes this file for a leak of its own.
  const x = (n: number) => "a1B2".repeat(n);
  const SAMPLES: Array<[string, string]> = [
    ["GitHub token", `token ghp_${x(9)}`],
    ["GitHub app token", `gho_${x(9)}`],
    ["fine-grained GitHub token", `github_pat_${x(12)}`],
    ["Anthropic key", `sk-ant-api03-${x(10)}`],
    ["Slack token", `xoxb-${x(6)}`],
    ["JWT", `Bearer eyJ${x(4)}.eyJ${x(4)}.${x(4)}`],
    ["fleetd key", `fld_abcdefghijklmnopqrstuvwx`],
    ["email", "Author: someone <12345+someone@users.noreply.github.com>"],
    ["tailnet IPv4", "http://100.101.102.103:4790"],
    ["tailnet IPv6", "[fd7a:115c:a1e0:ab12::1]:4790"],
    ["tailnet host", "http://buildbox.tail1234.ts.net:4790"],
    ["another home", "/Users/someone/src/app and /home/other/src"],
    ["private repo URL", "https://github.com/someone/private-thing/pull/4"],
    ["private repo SSH remote", "git@github.com:someorg/private-thing.git"],
  ];

  it.each(SAMPLES)("rewrites a %s so nothing of it is left", (_what, sample) => {
    expect(findLeaks(sample)).not.toEqual([]);
    expect(findLeaks(JSON.stringify(s.value({ text: sample })))).toEqual([]);
  });

  it("rewrites the one lab repo, its clone, its title and the slots' branch namespaces", () => {
    const out = s.value({
      repo: "unlaboredlabs/fleetd-lab",
      url: "https://github.com/unlaboredlabs/fleetd-lab/pull/12",
      path: `${path.dirname(lab)}/lab-repo/site/pricing.md`,
      title: "fleetd-lab",
      branch: "slot/4/fleetd/T3-write-alpha-md",
      noci: "noci/4/fleetd/T5-review",
      summary: "pushed slot/4/fleetd/T3-write-alpha-md to unlaboredlabs/fleetd-lab",
    });
    expect(out).toEqual({
      repo: "acme/storefront",
      url: "https://github.com/acme/storefront/pull/12",
      path: "/home/dev/src/storefront/site/pricing.md",
      title: "storefront",
      branch: "fleetd/T3-write-alpha-md",
      noci: "fleetd/T5-review",
      summary: "pushed fleetd/T3-write-alpha-md to acme/storefront",
    });
    expect(findLeaks(JSON.stringify(out))).toEqual([]);
  });

  it("maps every repo outside acme onto an acme stand-in, in repo fields and in object keys", () => {
    const out = s.value({ repo: "someone/private-thing", repos: ["someorg/secret-app"], byRepo: { "someone/private-thing": 1, [`${lab}/repo-a`]: 2 } });
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/private-thing|secret-app|someone|someorg/u);
    expect(out).toMatchObject({ repo: expect.stringMatching(/^acme\//u) as unknown, byRepo: { "/home/dev/src/checkout": 2 } });
    expect(s.value({ repo: "someone/private-thing" })).toEqual({ repo: (out as { repo: string }).repo });
  });

  it("refuses output that still names the lab or a key, and passes the stand-ins", () => {
    expect(() => assertClean("x", '{"a":"/srv/fleetd-lab/slot-4"}')).toThrow(/the lab/u);
    expect(() => assertClean("x", `{"a":"fld_abcdefghijklmnopqrstuvwxyz"}`)).toThrow();
    expect(() => assertClean("x", '{"a":"devbox","repo":"acme/storefront","p":"/home/dev/src","e":"dev@example.com"}')).not.toThrow();
  });
});

describe("schema", () => {
  it("cuts a string the rename made too long back to the schema's limit", () => {
    const f = new Fixture("t", "").answer("requests_list", {}, { requests: [], next: "x" });
    const summary = "s".repeat(250);
    f.events.push({ seq: 1, at: "2026-10-19T10:00:00.000Z", type: "machine.online", summary });
    expect(validateFixture(f)).not.toEqual([]);
    fitStrings(f);
    expect(validateFixture(f)).toEqual([]);
    expect(f.events[0]?.["summary"]).toHaveLength(200);
  });

  it("refuses a field the hub never sends, a misspelled input key and an unknown error code", () => {
    const extra = new Fixture("t", "").answer("orders_board", {}, { orders: [], trains: [], at: "2026-10-19T10:00:00.000Z", surprise: 1 });
    expect(validateFixture(extra).join("\n")).toMatch(/orders_board .*output/u);
    const typo = new Fixture("t", "").fail("order_get", { workstreamIdd: "W1" }, { code: "not_found", message: "no" });
    expect(validateFixture(typo).join("\n")).toMatch(/order_get input/u);
    const code = new Fixture("t", "").fail("order_get", { workstreamId: "W1" }, { code: "not_a_code", message: "no" });
    expect(validateFixture(code).join("\n")).toMatch(/not a hub error code/u);
    expect(validateFixture(new Fixture("t", "").fail("order_get", { workstreamId: "W1" }, { code: "not_found", message: "no" }))).toEqual([]);
  });
});

describe("attachments", () => {
  // Base64 hides a token from a scan of the JSON text, so the bytes are decoded and checked too.
  const withFile = (mime: string, data: Buffer) => {
    const f = new Fixture("t", "");
    f.snapshot = { cursor: 0, machines: [], projects: [], attention: [] };
    writeChat(f, { machineId: "devbox", projectId: "p1" }, [{ author: "human", text: "see attached", attachments: [{ name: "a", mime: mime as "text/plain", data }] }]);
    return findLeaks(JSON.stringify(f.toFile()));
  };
  const png = (extra: Array<[string, Buffer]>) => {
    const chunk = (type: string, body: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      return Buffer.concat([len, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
    };
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", Buffer.alloc(13)), ...extra.map(([t, b]) => chunk(t, b)), chunk("IEND", Buffer.alloc(0))]);
  };

  it("finds a token, a home path or the lab inside an attached text file", () => {
    expect(withFile("text/plain", Buffer.from(`token ghp_${"a1B2".repeat(9)}`)).join()).toMatch(/GitHub token in attachment/u);
    expect(withFile("text/plain", Buffer.from("/home/someone/src/x"))).not.toEqual([]);
    expect(withFile("text/plain", Buffer.from("cloned unlaboredlabs/fleetd-lab"))).not.toEqual([]);
    expect(withFile("text/plain", Buffer.from("all tests passed"))).toEqual([]);
    const token = `ghp_${"a1B2".repeat(9)}`;
    expect(withFile("text/plain", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(token, "utf16le")]))).not.toEqual([]);
    expect(withFile("text/plain", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(token, "utf16le").swap16()]))).not.toEqual([]);
  });

  it("decodes data: URLs inside message text", () => {
    const url = (mime: string, body: Buffer) => `see data:${mime};base64,${body.toString("base64")} here`;
    expect(findLeaks(JSON.stringify({ text: url("text/plain", Buffer.from("/home/someone/src")) }))).not.toEqual([]);
    expect(findLeaks(JSON.stringify({ text: url("image/png", png([["tEXt", Buffer.from("x")]])) })).join()).toMatch(/PNG metadata/u);
    expect(findLeaks(JSON.stringify({ text: url("image/png", png([])) }))).toEqual([]);
  });

  it("allows a PNG with pixels only, and refuses text chunks or files it can't read", () => {
    expect(withFile("image/png", png([]))).toEqual([]);
    expect(withFile("image/png", png([["tEXt", Buffer.from("Author\0someone")]])).join()).toMatch(/PNG metadata \(tEXt\)/u);
    expect(withFile("image/png", png([["eXIf", Buffer.alloc(4)]]))).not.toEqual([]);
    expect(withFile("image/gif", Buffer.from("GIF89a"))).not.toEqual([]);
  });

  it("allows a JPEG with pixels only, scans NDJSON and a WebM's text, and refuses what isn't what it says", () => {
    const segment = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([0, body.length + 2]), body]);
    const jpeg = (...segments: Buffer[]) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3])]);
    expect(withFile("image/jpeg", jpeg(segment(0xe0, Buffer.from("JFIF\0")), segment(0xdb, Buffer.alloc(4))))).toEqual([]);
    expect(withFile("image/jpeg", jpeg(segment(0xe1, Buffer.from("Exif\0\0"))))).not.toEqual([]);
    expect(withFile("image/jpeg", jpeg(segment(0xfe, Buffer.from("made by someone"))))).not.toEqual([]);
    expect(withFile("image/jpeg", Buffer.from("not a jpeg"))).not.toEqual([]);
    expect(withFile("application/x-ndjson", Buffer.from(`{"result":"sk-ant-api03-${"x1Y2".repeat(6)}"}\n`))).not.toEqual([]);
    expect(withFile("video/webm", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("Chrome")]))).toEqual([]);
    expect(withFile("video/webm", Buffer.from("not a webm"))).not.toEqual([]);
  });

  it("fails `pnpm fixtures` on a planted token: every shared fixture is checked this way", () => {
    expect(SCREENSHOT.data.length).toBeGreaterThan(0);
    expect(withFile(LOG.mime, LOG.data)).toEqual([]);
    expect(withFile(LOG.mime, Buffer.concat([LOG.data, Buffer.from(`sk-ant-api03-${"x1Y2".repeat(6)}`)]))).not.toEqual([]);
  });
});
