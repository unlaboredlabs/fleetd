# fleetd.sh

The static site behind `curl -fsSL https://fleetd.sh | sh`. `vercel.json` serves `install.sh` at `/` to curl, Wget and
fetch user agents and `home.html` to everyone else. `install.sh` is also at `/install.sh` for reading first. `home.html` is the landing page, in light and dark after the
reader's system; its showcase recording (`showcase-*.webm`), app screenshots (`chat-*.png`) and transcripts are real
fleetd output, `fleetd.txt` is its plain-text twin (not `index.txt`: Vercel would serve that at `/` and break the curl rewrite) for agents, and `fonts/`
holds the self-hosted IBM Plex Sans and Lilex (both SIL OFL, licences alongside).

There is deliberately no `index.html` at the root: Vercel serves files before applying rewrites, so an `index.html`
would win over the user-agent rewrite at `/`. `docs/index.html` is `/docs` and fine. `cleanUrls` serves
`docs/<page>.html` at `/docs/<page>`.

## Refreshing the captures

The app screenshots (`chat-approve.png` and `chat-secret.png` under "What keeps it trustworthy", each with a `-dark`
twin the page shows in dark mode) and the app shots in the docs (`docs/site/public/img/`) are the app's screens on
E3b's fixtures, which are sanitized lab hub traffic (`app/desktop/fixtures`), at 1400x900@2x, without the sample-data
banner. `app/desktop/qa/site.ts` lists them; `pnpm fixtures && pnpm qa:build && pnpm site:shots` in `app/desktop` writes
them in place. Re-shoot them when what those screens show changes, and keep the captions and alt texts (on the page, in
`fleetd.txt` and in the docs) true to the picture.

The showcase under the hero is the app recorded while a busy storefront takes one request from the message to the
merge, on the `showcase-order` fixture (`app/desktop/fixtures/showcase`): seven agents already at work on other orders,
the lead splitting the request into three parts, a live browser screen and an iPhone simulator testing them, you
taking over the iPhone to type a sign-in code and handing back, the browser's recording landing as a PR's proof, another
PR tried on the web with Try it, and the train merging four PRs as one batch; then a quick look around: the night's
memory refresh line opened in the chat, the Automations page with its built-in nightly row, Ada (a Navi) woken by mail
with a two-attachment reply you send, and Administration's people and invites, with two hubs in the sidebar. Each of
those is another group's fixture (`fixtures/showcase/more.ts`). Something happens every second or so, and its end fades
into its start, so it loops without a cut. It is `showcase-light.webm` and `showcase-dark.webm` (VP9, 2240x1440,
25 fps) with H.264 `.mp4` twins for browsers without VP9 (1792x1152 at level 4.0, the most a 14:9 frame gets under level 4.2, which older iPhones
and iPads decode; encoded frame by frame by the app's WebCodecs, so nothing is dropped), their posters
`showcase-light.jpg` and `showcase-dark.jpg` (a busy moment: the iPhone's screen yours, its code typed), a half-size
`-small` twin of each for small screens, and `showcase.json`, when each of the page's eight steps starts in the video.
`pnpm fixtures && pnpm qa:build && pnpm site:showcase` in `app/desktop` records them in place
(`app/desktop/qa/showcase.spec.ts`; it needs Playwright's ffmpeg, `pnpm exec playwright install ffmpeg` in
`app/desktop`); the screens' pages are `fixtures/showcase/media/`, drawn by `node fixtures/showcase/media.ts`. The page
shows the poster first and plays the recording as soon as the frame is on screen, the half-size one on a small screen;
with reduced motion it keeps the poster until Play. Record it again when those screens change, and keep the alt text,
the steps and the caption true to it.

The `<!-- capture:NAME -->` blocks in `home.html` and the same blocks in `fleetd.txt` (found there by the shape of
fleetd's output, so the twin carries no markers) come from one command, run from the repo root:

```sh
cargo build --release --locked -p fleetd && npm ci --prefix tests/lab
node tests/lab/site-capture.ts
```

It runs the `fleetd init --yes --no-service` wizard and `fleetd machine add builder-1 --dry-run` in a throwaway HOME
with your claude and gh logins copied in. This machine's tailnet name and addresses become `hub.your-tailnet.ts.net` and `<tailnet-ip>`, the gh login
`demo`, and it refuses to write text that still names this machine, its home or lab paths, a non-loopback address or
a key. Review the result with `git diff site/`.

## Docs (fleetd.sh/docs)

The docs are an [Astro Starlight](https://starlight.astro.build) site in `docs/site/`. Its build, `site/docs/`, is
committed, so the Vercel project needs no Node install. Its search index, `site/docs/pagefind`, is not: git ignores it,
and the Vercel build regenerates it from the committed HTML (`buildCommand` in `vercel.json`, a pinned Pagefind), so
docs PRs don't conflict on it. After editing a page, rebuild and commit both:

```sh
cargo run -q -p docsgen                  # only when the CLI or the prompt registry changed
npm ci --prefix docs/site
npm run build --prefix docs/site
```

Before opening a PR that touches `docs/site/` or `site/`, run the `site` job's checks too: the merge train waits for
that job (`.fleetd/train.json`), so a red one sends the PR back.

```sh
cargo run -q -p fleetd -- help > "$TMPDIR/fleetd-help.txt"
node .github/site-check.mjs "$TMPDIR/fleetd-help.txt"   # stale terms, commands fleetd help doesn't list
node .github/personal-check.mjs                          # no maintainer's host, login or home directory
node .github/docs-links.mjs                              # every internal link and anchor resolves
```

CI fails while the generated pages or `site/docs/` are out of date, or while `site/docs/pagefind` is tracked. To read
the docs locally with clean URLs, run `node .github/docs-serve.mjs` and open http://127.0.0.1:4791/docs (search
works once a build has written the ignored index), or `npm run dev --prefix docs/site` while writing.

### Where

- One file per page: `docs/site/src/content/docs/<slug>.md`, or `.mdx` when the page uses tabs. Lowercase,
  `-` separated. The page lives at `/docs/<slug>`.
- The sidebar is the `sidebar` list in `docs/site/astro.config.mjs`. A new page needs an entry there.
- Generated, don't edit: `reference/cli.md` (from `fleetd help`), `reference/agent-tools.md` (from the agent tools),
  and the prompt table between `<!-- prompt-table -->` markers in `what-agents-are-told.md`. `cargo run -q -p docsgen`
  writes them; `crates/docsgen/src/main.rs` lists them.
- Images: `docs/site/public/img/<name>.png`, referenced as `/docs/img/<name>.png`.

### Frontmatter

```markdown
---
title: Quick start
description: Install fleetd, open a project and chat with its lead.
---
```

`title` is the page's `<h1>` and sidebar label: short, "Machines", not "Managing your machines". `description` is one
plain sentence for search and link previews; quote it when it contains `: `.

### Writing

- Start with one sentence on what the reader will do, or what the page is.
- Example first, then explanation. Numbered steps with the exact command, then its expected output in a ` ```text `
  block.
- Options, fields and states as tables. Troubleshooting as symptom, cause, fix.
- Short sentences, plain words, no paragraph over about three lines.
- Link a fleetd term to the [Glossary](https://fleetd.sh/docs/glossary) the first time a page uses it.
- No time estimates in text or examples: measured durations only.
- Links between pages are absolute: `[Machines](/docs/machines#remove)`. CI checks every link and anchor.
- Pin an anchor that other pages or fleetd's output use: `## Remove a machine {#remove}`.
- Inline `code` for machine text only (commands, paths, ids, keys). A `fleetd <cmd>` written as code must be a
  command in `fleetd help` (CI checks it, like the landing page).
- Callouts: `:::note`, `:::tip`, `:::caution`. Tabs (`.mdx` only): `<Tabs syncKey="os">` with `macOS` and `Linux`
  items, as in `install.mdx`.

### Code blocks

| fence | for |
|---|---|
| ` ```sh ` | commands to run, one per line, no `$ ` |
| ` ```text ` | output, or file content without a language |
| ` ```console capture=<name> ` | a transcript the capture script fills from the real binary (below) |
| ` ```yaml `, ` ```ini `, ` ```json ` | file content |

Every block gets a copy button and syntax highlighting.

### Captured output (real output, recaptured by script)

Mark a `console` block whose output must come from the real binary with `capture=<name>` in the info string. It may
be indented as a step of a numbered list:

````markdown
```console capture=doctor-fresh
$ fleetd doctor
(output goes here; the capture script rewrites it)
```
````

- `<name>`: `[a-z0-9-]+`, unique across all pages.
- `node tests/lab/site-capture.ts --docs` (no lab, no claude turns; needs the release build or `FLEETD_BIN`) runs
  each marked block's `$ ` lines in order, in a fresh throwaway HOME (user `demo`, shown as `~`) where `fleetd init
  --listen 127.0.0.1:4778 --git-identity "Demo <demo@users.noreply.github.com>" --no-service` has already run (unless
  the block's first command is `fleetd init` itself), writes each command's output under it, keeps a nonzero exit as
  a final `[exit N]` line, and rebuilds `site/docs`. It refuses to write a hostname, a real `/home` path, a
  non-loopback IP or a key.
- Output that needs a live hub, a node or claude can't be captured that way. Paste real output from a lab run into a
  ` ```text ` block instead.
- Never invent or edit output by hand inside a capture block.

## Vercel project settings

- **Import** the GitHub repo `unlaboredlabs/fleetd`.
- **Root Directory:** `site`
- **Framework Preset:** Other
- **Build Command:** Override on, left empty; `buildCommand` in `vercel.json` takes precedence and runs Pagefind
  1.5.2 on `docs/`, writing the docs' search index. Bump that version with the `pagefind` in
  `docs/site/package-lock.json`, so the deployed index matches a local build.
- **Output Directory:** leave the default; `outputDirectory` in `vercel.json` is `.`, the root directory as is (with a
  build command, Vercel would otherwise look for a `public/` folder and fail)
- **Install Command:** Override on, left empty
- **Production Branch:** `main`
- **Ignored Build Step** (Settings → Git): `git diff --quiet HEAD^ HEAD -- .`, so commits that don't touch `site/`
  don't deploy. (Vercel runs it from the root directory; exit code 0 skips the build.)
- **Domains:** `fleetd.sh` (production), and `www.fleetd.sh` redirecting to `fleetd.sh`.

## Check a deployment

The header rewrite does not run under `vercel dev`, so check a preview deployment:

```sh
curl -fsSL https://<deployment>/ | head -3     # the installer: "#!/bin/sh" ...
curl -fsSI https://<deployment>/install.sh      # content-type: text/plain
```

A browser at the same URL should show the landing page, and a search on `https://<deployment>/docs` should list
results. The deployment's build log shows Pagefind's `Indexed <n> pages`.

## Testing the installer without a release

`FLEETD_BASE_URL` points the installer at any directory of release assets, e.g. a local `python3 -m http.server`
serving `SHA256SUMS`, `fleetd-linux-x64` and `fleetd-desktop-linux-x86_64.AppImage`:

```sh
FLEETD_BASE_URL=http://127.0.0.1:8000 HOME=/tmp/fleetd-home sh site/install.sh
```
