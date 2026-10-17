# fleetd.sh

The static site behind `curl -fsSL https://fleetd.sh | sh`. `vercel.json` serves `install.sh` at `/` to curl, Wget and
fetch user agents and `home.html` to everyone else. `install.sh` is also at `/install.sh` for reading first.

There is deliberately no `index.html`: Vercel serves files before applying rewrites, so an `index.html` would win
over the user-agent rewrite at `/`.

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
