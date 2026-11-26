// `gh api` answered in the workspace's process (hub/train/gh_api.ts): the calls the workspace makes read as gh reads
// them, the request is gh's, and the answer prints as gh prints it, against stand-in GitHubs on loopback.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseApi, requestOf, runApi, serverError } from "../src/hub/train/gh_api.ts";
import { httpAnswer } from "../src/hub/train/github.ts";

type Seen = { method: string; url: string; headers: Headers; body: string };
const seen: Seen[] = [];
const other = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: await req.text() });
    return new Response("﻿2026 a log line\n", { headers: { "content-type": "text/plain" } });
  },
});
const github = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const url = new URL(req.url);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: await req.text() });
    const json = { "content-type": "application/json; charset=utf-8" };
    if (url.pathname === "/repos/o/r") {
      if (req.headers.get("if-none-match") === '"e1"') return new Response(null, { status: 304, headers: { etag: '"e1"' } });
      return new Response('{"name":"r"}', { headers: { ...json, etag: '"e1"', "x-ratelimit-remaining": "4999" } });
    }
    if (url.pathname === "/repos/o/r/pulls/9") return new Response('{"message":"Not Found","status":"404"}', { status: 404, headers: json });
    if (url.pathname === "/graphql") return new Response('{"data":{"repository":null},"errors":[{"message":"Could not resolve"},{"message":"and more"}]}', { headers: json });
    if (url.pathname === "/repos/o/r/actions/jobs/1/logs") return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${other.port}/blob?sig=x` } });
    if (url.pathname === "/repos/o/r/issues/1/comments") return new Response('{"id":5}', { status: 201, headers: json });
    return new Response("{}", { headers: json });
  },
});
const api = `http://127.0.0.1:${github.port}/`;
afterAll(() => {
  github.stop(true);
  other.stop(true);
});

const J = "Accept: application/vnd.github+json";

test("the workspace's gh api calls read as gh reads them; anything else is left to gh", () => {
  expect(parseApi(["api", "-i", "-X", "GET", "-H", J, "repos/o/r/pulls/1", "-H", 'If-None-Match: "x"'])).toEqual({
    method: "GET",
    path: "repos/o/r/pulls/1",
    headers: [["Accept", "application/vnd.github+json"], ["If-None-Match", '"x"']],
    fields: [],
    include: true,
  });
  // gh's defaults: a field or a graphql path makes it a POST; -F types true, false, null and integers.
  expect(parseApi(["api", "repos/o/r/issues/1/comments", "-f", "body=a=b", "-F", "draft=true", "-F", "n=10", "-F", "x=null", "-F", "s=1.5"])).toMatchObject({
    method: "POST",
    fields: [["body", "a=b"], ["draft", true], ["n", 10], ["x", null], ["s", "1.5"]],
    include: false,
  });
  expect(parseApi(["api", "graphql", "-f", "query=q"])?.method).toBe("POST");
  expect(parseApi(["api", "user"])?.method).toBe("GET");
  expect(parseApi(["api", "-i", "-X", "PUT", "-H", J, "repos/o/r/rules", "--input", "/f.json"])).toMatchObject({ method: "PUT", input: "/f.json" });
  expect(parseApi(["api", "-X", "GET", "-H", J, "repos/o/r/actions/jobs/1/logs", "--allow-escape-sequences"])?.path).toBe("repos/o/r/actions/jobs/1/logs");
  // What gh reads its own way runs gh.
  for (const args of [
    ["pr", "update-branch", "1", "--repo", "o/r"],
    ["api", "repos/o/r", "--paginate"],
    ["api", "repos/o/r", "--jq", ".name"],
    ["api", "repos/o/r", "-f", "labels[]=a"],
    ["api", "repos/o/r", "-F", "body=@file.md"],
    ["api", "repos/o/r", "-F", "owner={owner}"],
    ["api", "repos/{owner}/{repo}"],
    ["api", "repos/o/r", "--input", "-"],
    ["api", "a", "b"],
  ]) {
    expect(parseApi(args)).toBeUndefined();
  }
});

test("the request is gh's: its headers, a GET's fields in its query sorted by key, a write's fields as JSON", () => {
  const get = requestOf(parseApi(["api", "-X", "GET", "repos/o/r/pulls?state=open", "-f", "z=1", "-F", "a=2"])!, "T", api);
  expect(get.url).toBe(`${api}repos/o/r/pulls?state=open&a=2&z=1`);
  expect(get.init.body).toBeUndefined();
  const h = get.init.headers as Headers;
  expect([h.get("accept"), h.get("content-type"), h.get("x-github-api-version"), h.get("authorization")]).toEqual([
    "*/*",
    "application/json; charset=utf-8",
    "2022-11-28",
    "token T",
  ]);
  const post = requestOf(parseApi(["api", "-i", "-X", "POST", "-H", J, "repos/o/r/issues/1/comments", "-f", "body=hi", "-F", "draft=false"])!, "T", api);
  expect([post.init.method, JSON.parse(post.init.body as string), (post.init.headers as Headers).get("accept")]).toEqual([
    "POST",
    { body: "hi", draft: false },
    "application/vnd.github+json",
  ]);
  const gql = requestOf(parseApi(["api", "graphql", "-f", "query=query($o: String!) { x }", "-f", "o=me", "-F", "first=5"])!, "T", api);
  expect(JSON.parse(gql.init.body as string)).toEqual({ query: "query($o: String!) { x }", variables: { o: "me", first: 5 } });
  const dir = mkdtempSync(join(tmpdir(), "gh-api-"));
  writeFileSync(join(dir, "rules.json"), '{"a":1}');
  const put = requestOf(parseApi(["api", "-X", "PUT", "repos/o/r/x", "--input", join(dir, "rules.json")])!, "T", api);
  expect([put.init.method, put.init.body]).toEqual(["PUT", '{"a":1}']);
});

test("an answer prints as gh prints it: -i's head, a 304 and a 404 exit 1 with gh's words", async () => {
  const ok = await runApi(parseApi(["api", "-i", "-X", "GET", "-H", J, "repos/o/r"])!, "T", api);
  const a = httpAnswer(ok.stdout);
  expect([ok.exitCode, ok.stderr, a.status, a.headers.get("etag"), a.headers.get("x-ratelimit-remaining"), a.body]).toEqual([0, "", 200, '"e1"', "4999", '{"name":"r"}']);
  expect(ok.stdout.startsWith("HTTP/2.0 200 OK\n")).toBe(true);

  const same = await runApi(parseApi(["api", "-i", "-X", "GET", "-H", J, "repos/o/r", "-H", 'If-None-Match: "e1"'])!, "T", api);
  expect([same.exitCode, same.stderr, httpAnswer(same.stdout).status]).toEqual([1, "gh: HTTP 304\n", 304]);

  const missing = await runApi(parseApi(["api", "-i", "-X", "GET", "-H", J, "repos/o/r/pulls/9"])!, "T", api);
  expect([missing.exitCode, missing.stderr, httpAnswer(missing.stdout).body]).toEqual([1, "gh: Not Found (HTTP 404)\n", '{"message":"Not Found","status":"404"}']);

  // Without -i, only the body.
  const plain = await runApi(parseApi(["api", "repos/o/r/issues/1/comments", "-f", "body=x"])!, "T", api);
  expect([plain.exitCode, plain.stdout]).toEqual([0, '{"id":5}']);
});

test("a GraphQL answer with errors fails as gh's does, its messages on stderr", async () => {
  const out = await runApi(parseApi(["api", "graphql", "-f", "query=q"])!, "T", api);
  expect([out.exitCode, out.stderr]).toEqual([1, "gh: Could not resolve\nand more\n"]);
  expect(JSON.parse(out.stdout).data).toEqual({ repository: null });
  expect(serverError(200, '{"data":{}}', true, true)).toBe("");
  expect(serverError(502, "<html>", false, false)).toBe("HTTP 502");
});

test("a redirect to another host is followed without the token, and the answer's byte order mark stays", async () => {
  seen.length = 0;
  const out = await runApi(parseApi(["api", "-X", "GET", "-H", J, "repos/o/r/actions/jobs/1/logs", "--allow-escape-sequences"])!, "SECRET", api);
  expect([out.exitCode, out.stdout]).toEqual([0, "﻿2026 a log line\n"]);
  expect(seen.map((s) => [new URL(s.url).pathname, s.headers.get("authorization")])).toEqual([
    ["/repos/o/r/actions/jobs/1/logs", "token SECRET"],
    ["/blob", null],
  ]);
});

test("GitHub unreachable is a failed run, and one past its time throws as a timed-out gh does", async () => {
  const down = await runApi(parseApi(["api", "repos/o/r"])!, "T", "http://127.0.0.1:1/");
  expect(down.exitCode).toBe(1);
  expect(down.stderr).toStartWith("error connecting to api.github.com");
  const slow = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Bun.sleep(2000).then(() => new Response("{}")) });
  try {
    await expect(runApi(parseApi(["api", "repos/o/r"])!, "T", `http://127.0.0.1:${slow.port}/`, 50)).rejects.toMatchObject({ name: "TimeoutError" });
  } finally {
    slow.stop(true);
  }
});
