// Every link on fleetd.sh resolves. Run by CI from the repo root:
//   node .github/docs-links.mjs              internal: each href/src in site/home.html, site/pricing.html, the legal and support pages and the built docs' pages
//                                            (site/docs/**/*.html) names a file in site/ (clean URLs as Vercel serves
//                                            them) and an id on that page
//                                            Also: each moved section in docs/site/src/old-anchors.mjs leads to a page
//                                            and an id that exist, and is gone from the page it moved from
//   node .github/docs-links.mjs --external   external: each http(s) link answers, 10 s per try, two tries
// Links into this repository on GitHub (…/fleetd/blob|tree|edit/main/<path>) are checked against the checkout instead,
// so a PR that adds a page and links to it passes before it merges.
import fs from "node:fs";
import path from "node:path";
import { OLD_ANCHORS } from "../docs/site/src/old-anchors.mjs";
import { resolve } from "./docs-serve.mjs";

// Starlight's own assets (_astro/, pagefind/) hold no pages.
const PAGES = [
  "site/home.html",
  "site/pricing.html",
  "site/terms.html",
  "site/privacy.html",
  "site/refunds.html",
  "site/imprint.html",
  "site/support.html",
  "site/security.html",
  "site/subprocessors.html",
  "site/dpa.html",
  ...fs
    .readdirSync("site/docs", { recursive: true })
    .filter((n) => n.endsWith(".html") && !/^(_astro|pagefind)\//u.test(n))
    .map((n) => `site/docs/${n}`),
];
const OWN = /^https:\/\/github\.com\/unlaboredlabs\/fleetd\/(?:blob|tree|edit)\/main\/(.+)$/u;
// Hosts that are examples or this site itself (production lags a PR), never fetched.
const SKIP = new Set(["fleetd.sh", "www.fleetd.sh", "127.0.0.1", "localhost", "fleetd.your-tailnet.ts.net"]);
const errors = [];
const external = new Map();
const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) ids.set(file, new Set([...fs.readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1])));
  return ids.get(file);
};
// site/vercel.json's redirects off the site (/download/mac), by their literal path: a link to one is checked as the
// address it leads to, with the external links. A link to a redirect within the site still fails: link the page.
const AWAY = new Map(
  JSON.parse(fs.readFileSync("site/vercel.json", "utf8"))
    .redirects.filter((r) => /^https?:\/\//u.test(r.destination) && /^[/a-z0-9-]+(\{\/\}\?)?$/u.test(r.source))
    .map((r) => [r.source.replace("{/}?", ""), r.destination]),
);
// Its rewrites to a function of the site's (/download/mac → site/api/download-mac.mjs, which answers a redirect that
// always lands): a link to one passes while that function is there.
const SERVED = new Map(
  JSON.parse(fs.readFileSync("site/vercel.json", "utf8"))
    .rewrites.filter((r) => /^\/api\/[a-z0-9-]+$/u.test(r.destination) && /^[/a-z0-9-]+(\{\/\}\?)?$/u.test(r.source))
    .map((r) => [r.source.replace("{/}?", ""), `site${r.destination}.mjs`]),
);
const decode = (s) => s.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">");

for (const page of PAGES) {
  for (const [, raw] of fs.readFileSync(page, "utf8").matchAll(/\s(?:href|src)="([^"]*)"/gu)) {
    const link = decode(raw);
    if (/^(mailto:|data:)/u.test(link)) continue;
    const own = OWN.exec(link.split("#")[0]);
    if (own) {
      if (!fs.existsSync(own[1])) errors.push(`${page}: ${link}: ${own[1]} is not in the repository`);
      continue;
    }
    if (/^https?:\/\//u.test(link)) {
      if (!SKIP.has(new URL(link).hostname)) external.set(link, page);
      continue;
    }
    if (!link.startsWith("/") && !link.startsWith("#")) {
      errors.push(`${page}: ${link}: links on the site are absolute (/docs/…) or #anchors`);
      continue;
    }
    const [where, anchor] = link.split("#");
    const away = AWAY.get(where.replace(/(.)\/$/u, "$1"));
    if (away !== undefined) {
      external.set(away, page);
      continue;
    }
    const served = SERVED.get(where.replace(/(.)\/$/u, "$1"));
    if (served !== undefined) {
      if (!fs.existsSync(served)) errors.push(`${page}: ${link}: ${served} is not there to answer it`);
      continue;
    }
    const target = where === "" ? page : resolve(where.split("?")[0]);
    if (target === undefined) errors.push(`${page}: ${link}: no file in site/ serves ${where}`);
    else if (anchor !== undefined && anchor !== "" && target.endsWith(".html") && !idsOf(target).has(anchor)) {
      errors.push(`${page}: ${link}: ${path.relative(".", target)} has no id="${anchor}"`);
    }
  }
}

// A moved section is sent on only while its page has no section of that id, to a page and section that exist.
for (const [from, moved] of Object.entries(OLD_ANCHORS)) {
  const page = resolve(from);
  if (page === undefined) errors.push(`docs/site/src/old-anchors.mjs: ${from}: no file in site/ serves it`);
  for (const [id, to] of Object.entries(moved)) {
    if (page !== undefined && idsOf(page).has(id)) errors.push(`docs/site/src/old-anchors.mjs: ${from}#${id} is still on that page`);
    const [where, anchor] = to.split("#");
    const target = resolve(where);
    if (target === undefined) errors.push(`docs/site/src/old-anchors.mjs: ${from}#${id}: no file in site/ serves ${where}`);
    else if (anchor !== undefined && !idsOf(target).has(anchor)) errors.push(`docs/site/src/old-anchors.mjs: ${from}#${id}: ${path.relative(".", target)} has no id="${anchor}"`);
  }
}

if (process.argv.includes("--external")) {
  const answer = async (url) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10_000) });
        // Some servers refuse HEAD; ask again with GET.
        if (r.status === 405 || r.status === 403) r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
        if (r.ok || r.status === 429) return undefined;
        if (r.status < 500) return `HTTP ${r.status}`;
      } catch (error) {
        if (attempt === 1) return String(error.cause?.code ?? error.name ?? error);
      }
    }
    return "no answer after two tries";
  };
  const results = await Promise.all([...external].map(async ([url, page]) => [url, page, await answer(url)]));
  for (const [url, page, problem] of results) if (problem) errors.push(`${page}: ${url}: ${problem}`);
}

for (const e of errors) console.log(`::error::${e}`);
if (errors.length > 0) process.exit(1);
console.log(`links: ${PAGES.length} pages ok${process.argv.includes("--external") ? `, ${external.size} external links answer` : ""}`);
