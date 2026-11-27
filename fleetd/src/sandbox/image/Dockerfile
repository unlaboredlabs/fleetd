# The base of every sandbox box's root (fleetd/src/sandbox/image/recipe.ts): what agents expect to find on a machine,
# without claude or fleetd, which a local VM is given by its node (fleetd/src/node/place/provision.ts) and a hosted
# template adds privately on top. A box sees nothing of its machine's home, so every tool an agent or fleetd's own
# setup reaches for (git, gh, Bun, Node with npm, pnpm and Yarn) is here. build.sh flattens it into the read-only ext4 root a local VM boots, adding init.sh as its PID 1.
# Hosted providers build this same text with no context, so it keeps to one FROM and RUN / ENV lines: no ARG, COPY,
# ADD or heredoc. The pins are written here; changing this file, init.sh or build.sh makes a new image.
FROM ubuntu@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

# Every package comes from Ubuntu's own archive as it was on one day (snapshot.ubuntu.com), never from a source that
# changes under a build or one the base image brought (a hosted provider's base adds PPAs): moving the date is a
# change of this file, so a new image. snapshot.ubuntu.com is served over https, and Docker's ubuntu image has no CA
# certificates yet: those alone come from the image's own Ubuntu sources first.
# What agents reach for on a plain Linux machine: git and gh, a C toolchain (native modules, cargo's linker), the
# usual unpackers and network tools, `ss` and `script` (some of fleetd's own tests run them), and tini and socat for
# the init.
# Each apt install is tried up to 3 times (`tries`, in every step that installs): a .deb the mirror serves broken fails
# its hash check, which apt doesn't retry itself; it sets the bad file aside (partial/*.FAILED) and fetches it afresh.
# The last try's own error and exit code are what a failed build shows.
RUN tries() { for t in 1 2 3; do "$@" && return; s=$?; [ "$t" -lt 3 ] || return "$s"; echo "fleetd: an apt install failed (try $t of 3), trying again in 15 s" >&2; sleep 15; done; } \
 && { [ -s /etc/ssl/certs/ca-certificates.crt ] || { apt-get update && tries apt-get install -y --no-install-recommends ca-certificates; }; } \
 && rm -f /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources && : > /etc/apt/sources.list \
 && printf 'Types: deb\nURIs: https://snapshot.ubuntu.com/ubuntu/20261119T000000Z/\nSuites: noble noble-updates noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n' > /etc/apt/sources.list.d/ubuntu.sources \
 && apt-get update && tries apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file git git-lfs gnupg iproute2 iputils-ping jq less locales make \
      netcat-openbsd openssh-client patch pkg-config procps python3 python3-venv ripgrep rsync socat sqlite3 sudo \
      tini tzdata unzip util-linux wget xz-utils zip zstd \
 && rm -rf /var/lib/apt/lists/*

# bun 1.4.3 (fleetd's own), pinned and checked.
RUN curl -fsSL -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-x64.zip \
 && echo "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp/bun \
 && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
 && ln -sf bun /usr/local/bin/bunx \
 && rm -rf /tmp/bun /tmp/bun.zip

# GitHub's CLI 2.104.0, pinned and checked.
RUN curl -fsSL -o /tmp/gh.tgz https://github.com/cli/cli/releases/download/v2.104.0/gh_2.104.0_linux_amd64.tar.gz \
 && echo "98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e  /tmp/gh.tgz" | sha256sum -c - \
 && tar -xzf /tmp/gh.tgz -C /tmp \
 && install -m 0755 /tmp/gh_2.104.0_linux_amd64/bin/gh /usr/local/bin/gh \
 && rm -rf /tmp/gh.tgz /tmp/gh_2.104.0_linux_amd64

# Playwright's headless Chrome and ffmpeg at fleetd's own pin (PLAYWRIGHT_VERSION in node/browser/chrome.ts), with the
# libraries and fonts they need. Without them fleetd's browser tests skip in a box (14 of the 16 extra skips measured
# on the devbox). The builds sit at a fixed path PLAYWRIGHT_BROWSERS_PATH names, since a local box's home is the
# host's: /etc/fleetd/guest.env holds it for sessions started by `fleetd sandbox-guest`.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# The headless shell at a path without its build number, named by CHROME as the site's layout check looks for it
# (.github/site-layout-check.mjs), here and in /etc/fleetd/guest.env.
ENV CHROME=/usr/local/bin/chrome-headless-shell
# Node.js 24, pinned and checked, with npm, and pnpm and Yarn at their pins (fleetd's own lockfile installs:
# app/desktop's pnpm-lock.yaml, the package-lock.json files, a yarn.lock), all in /opt/node and on PATH. Every download
# is checked against its SHA-256 here, none comes from the npm registry's latest word: pnpm's linux build is its own
# binary (@pnpm/exe.linux-x64), Yarn 1 has no dependencies, and Playwright's builds (its 1.64.1 browsers.json:
# chromium-headless-shell 1248 at Chrome for Testing 156.0.8078.4, ffmpeg 1013) are unpacked where its installer puts
# them; only its own list of the system libraries they need runs (`install-deps`, from the archive above).
RUN tries() { for t in 1 2 3; do "$@" && return; s=$?; [ "$t" -lt 3 ] || return "$s"; echo "fleetd: an apt install failed (try $t of 3), trying again in 15 s" >&2; sleep 15; done; } \
 && curl -fsSL -o /tmp/node.txz https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz \
 && echo "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb  /tmp/node.txz" | sha256sum -c - \
 && mkdir -p /opt/node /tmp/pw && tar -xJf /tmp/node.txz -C /opt/node --strip-components=1 \
 && ln -sf /opt/node/bin/node /usr/local/bin/node \
 && curl -fsSL -o /tmp/pw/pnpm.tgz https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.11.2.tgz \
 && curl -fsSL -o /tmp/pw/yarn.tgz https://registry.npmjs.org/yarn/-/yarn-1.22.22.tgz \
 && curl -fsSL -o /tmp/pw/core.tgz https://registry.npmjs.org/playwright-core/-/playwright-core-1.64.1.tgz \
 && curl -fsSL -o /tmp/pw/shell.zip https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux64/chrome-headless-shell-linux64.zip \
 && curl -fsSL -o /tmp/pw/ffmpeg.zip https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1013/ffmpeg-linux.zip \
 && printf '%s\n' \
      "79008d3130845ee8a0fe4381e6b81815e80e1bd411702f34721b1cc63e6e20bf  /tmp/pw/pnpm.tgz" \
      "c17d3797fb9a9115bf375e31bfd30058cac6bc9c3b8807a3d8cb2094794b51ca  /tmp/pw/yarn.tgz" \
      "3af03703c967c95037454f2283f709d53ce804a4776d4219d319f5bbcc2a0185  /tmp/pw/core.tgz" \
      "c3e50596aef52c58f8fda3c6b3411c33d34c88b177b3ed1c2243359fd3b8ba20  /tmp/pw/shell.zip" \
      "ee986434d158f74fb5d9c5ff1092026ceedb63f324fe90b5be89460926b7b679  /tmp/pw/ffmpeg.zip" | sha256sum -c - \
 && tar -xzf /tmp/pw/pnpm.tgz -C /tmp/pw && install -m 0755 /tmp/pw/package/pnpm /opt/node/bin/pnpm && rm -rf /tmp/pw/package \
 && printf '#!/bin/sh\nexec /opt/node/bin/pnpm dlx "$@"\n' > /opt/node/bin/pnpx && chmod 755 /opt/node/bin/pnpx \
 && mkdir -p /opt/node/lib/node_modules/yarn && tar -xzf /tmp/pw/yarn.tgz -C /opt/node/lib/node_modules/yarn --strip-components=1 \
 && ln -sf ../lib/node_modules/yarn/bin/yarn.js /opt/node/bin/yarn && ln -sf ../lib/node_modules/yarn/bin/yarn.js /opt/node/bin/yarnpkg \
 && for b in npm npx corepack pnpm pnpx yarn yarnpkg; do [ ! -e /opt/node/bin/$b ] || ln -sf /opt/node/bin/$b /usr/local/bin/$b; done \
 && node --version && npm --version && pnpm --version && yarn --version \
 && mkdir -p /tmp/pw/core /opt/ms-playwright/chromium_headless_shell-1248 /opt/ms-playwright/ffmpeg-1013 \
 && tar -xzf /tmp/pw/core.tgz -C /tmp/pw/core --strip-components=1 \
 && unzip -q /tmp/pw/shell.zip -d /opt/ms-playwright/chromium_headless_shell-1248 \
 && unzip -q /tmp/pw/ffmpeg.zip -d /opt/ms-playwright/ffmpeg-1013 \
 && touch /opt/ms-playwright/chromium_headless_shell-1248/INSTALLATION_COMPLETE /opt/ms-playwright/ffmpeg-1013/INSTALLATION_COMPLETE \
 && tries node /tmp/pw/core/cli.js install-deps chromium-headless-shell ffmpeg \
 && ln -s /opt/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell "$CHROME" \
 && chmod -R a+rX /opt/ms-playwright /opt/node \
 && cd / && rm -rf /tmp/pw /tmp/node.txz /root/.npm /root/.cache /var/lib/apt/lists/* \
 && mkdir -p /etc/fleetd \
 && printf 'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright\nCHROME=%s\n' "$CHROME" > /etc/fleetd/guest.env \
 && printf 'fleetd-box\n' > /etc/hostname \
 && git config --system --add safe.directory '*'

# GTK 3, which Electron links even headless (app/desktop's engine tests start it), with dbus-x11 as the session bus
# dconf asks for, which keeps systemd out. Its icon themes go: nothing headless draws them, and they're most of its size.
# Xvfb, openbox and xterm: a hosted agent's Linux desktop runs in its box (fleetd/src/node/place/box_screens.ts).
RUN tries() { for t in 1 2 3; do "$@" && return; s=$?; [ "$t" -lt 3 ] || return "$s"; echo "fleetd: an apt install failed (try $t of 3), trying again in 15 s" >&2; sleep 15; done; } \
 && apt-get update && tries apt-get install -y --no-install-recommends dbus-x11 libgtk-3-0t64 openbox xterm xvfb \
 && rm -rf /usr/share/icons/* /var/lib/apt/lists/*

# An ffmpeg with x264 at the node's own pin (fleetd/src/node/device/pins.ts): a desktop's live view and video are
# encoded in its box (fleetd/src/node/desktop/box_frames.ts, BOX_FFMPEG); without it they are JPEG.
RUN curl -fsSL -o /tmp/ffmpeg.txz https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-6.0.1-amd64-static.tar.xz \
 && echo "28268bf402f1083833ea269331587f60a242848880073be8016501d864bd07a5  /tmp/ffmpeg.txz" | sha256sum -c - \
 && mkdir -p /tmp/ffmpeg && tar -xJf /tmp/ffmpeg.txz -C /tmp/ffmpeg --strip-components=1 \
 && install -m 0755 /tmp/ffmpeg/ffmpeg /usr/local/bin/fleetd-ffmpeg \
 && rm -rf /tmp/ffmpeg /tmp/ffmpeg.txz
