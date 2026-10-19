// Every link on fleetd.sh resolves. Run by CI from the repo root:
//   node .github/docs-links.mjs              internal: each href/src in site/home.html and the built docs' pages
//                                            (site/docs/**/*.html) names a file in site/ (clean URLs as Vercel serves
//                                            them) and an id on that page
//   node .github/docs-links.mjs --external   external: each http(s) link answers, 10 s per try, two tries
// Links into this repository on GitHub (…/fleetd/blob|tree|edit/main/<path>) are checked against the checkout instead,
// so a PR that adds a page and links to it passes before it merges.
import fs from "node:fs";
import path from "node:path";
import { resolve } from "./docs-serve.mjs";

// Starlight's own assets (_astro/, pagefind/) hold no pages.
const PAGES = [
  "site/home.html",
  ...fs
    .readdirSync("site/docs", { recursive: true })
    .filter((n) => n.endsWith(".html") && !/^(_astro|pagefind)\//u.test(n))
    .map((n) => `site/docs/${n}`),
];
const OWN = /^https:\/\/github\.com\/unlaboredlabs\/fleetd\/(?:blob|tree|edit)\/main\/(.+)$/u;
// Hosts that are examples or this site itself (production lags a PR), never fetched.
const SKIP = new Set(["fleetd.sh", "www.fleetd.sh", "127.0.0.1", "localhost", "hub.your-tailnet.ts.net"]);
const errors = [];
const external = new Map();
const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) ids.set(file, new Set([...fs.readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1])));
  return ids.get(file);
};
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
    const target = where === "" ? page : resolve(where.split("?")[0]);
    if (target === undefined) errors.push(`${page}: ${link}: no file in site/ serves ${where}`);
    else if (anchor !== undefined && anchor !== "" && target.endsWith(".html") && !idsOf(target).has(anchor)) {
      errors.push(`${page}: ${link}: ${path.relative(".", target)} has no id="${anchor}"`);
    }
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
