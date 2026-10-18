# fleetd.sh

The static site behind `curl -fsSL https://fleetd.sh | sh`. `vercel.json` serves `install.sh` at `/` to curl, Wget and
fetch user agents and `home.html` to everyone else. `install.sh` is also at `/install.sh` for reading first. `home.html` is the landing page; its app captures
(`capture-*.png`) and transcripts are real fleetd output, `fleetd.txt` is its plain-text twin (not `index.txt`: Vercel would serve that at `/` and break the curl rewrite) for agents, and `fonts/`
holds the self-hosted IBM Plex Sans and Lilex (both SIL OFL, licences alongside).

There is deliberately no `index.html`: Vercel serves files before applying rewrites, so an `index.html` would win
over the user-agent rewrite at `/`.

## Refreshing the captures

The screenshots, the `<!-- capture:NAME -->` blocks in `home.html` and the same blocks in `fleetd.txt` (found there by
the shape of fleetd's output, so the twin carries no markers) come from one command, run from the repo root on a Linux
machine with the lab set up (see "Lab suite" in `docs/CONTRIBUTING.md`) and the headless display sysroot
(`app/bench/linux-sysroot.sh`):

```sh
cargo build --release --locked -p fleetd -p fleetd-app -p fleetd-bench && npm ci --prefix tests/lab
FLEETD_LAB_SLOT=8 node tests/lab/site-capture.ts
```

It stands up a hub and a node on that lab slot, has a haiku lead file three numbered asks (three tiny turns), runs the
desktop app under a private Xvfb at the page's image size, shoots the inbox, types the reply and shoots the lead's
view; then it runs `fleetd init` and `fleetd machine add builder-1 --dry-run` in a throwaway HOME and reads the merge
train from the newest lab m7 run, if there is one: the whole path of its first two merged changes and the first of
each refusal, freeze, red CI and conflict, at most 16 lines. It refuses to write text that names this machine, its
home or lab paths, a non-loopback address or a key. Review the result with `git diff site/`. The callout positions
(`--x`, `--y`) and the hand-written callout text are not generated: the script lists quotes and ids on the page that
its run didn't produce, and you re-aim the callouts if the app's layout moved.

## Vercel project settings

- **Import** the GitHub repo `unlaboredlabs/fleetd`.
- **Root Directory:** `site`
- **Framework Preset:** Other
- **Build Command:** Override on, left empty (nothing to build)
- **Output Directory:** leave the default; with no `public/` folder, Vercel serves the root directory as is
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

A browser at the same URL should show the landing page.

## Testing the installer without a release

`FLEETD_BASE_URL` points the installer at any directory of release assets, e.g. a local `python3 -m http.server`
serving `SHA256SUMS`, `fleetd-linux-x64` and `fleetd-app-linux-x64.tar.gz`:

```sh
FLEETD_BASE_URL=http://127.0.0.1:8000 HOME=/tmp/fleetd-home sh site/install.sh
```
