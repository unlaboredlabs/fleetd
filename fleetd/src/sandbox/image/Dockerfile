# The base of every sandbox box's root (fleetd/src/sandbox/image/recipe.ts): what agents expect to find on a machine,
# without claude or fleetd, which a local VM is given by its node (fleetd/src/node/place/provision.ts) and a hosted
# template adds privately on top. A box sees nothing of its machine's home, so every tool an agent or fleetd's own
# setup reaches for (git, gh, Bun, Node with npm, pnpm and Yarn) is here. build.sh flattens it into the read-only ext4 root a local VM boots, adding init.sh as its PID 1.
# Hosted providers build this same text with no context, so it keeps to one FROM and RUN / ENV lines: no ARG, COPY,
# ADD or heredoc. The pins are written here; changing this file, init.sh or build.sh makes a new image.
FROM ubuntu@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

# What agents reach for on a plain Linux machine: git and gh, a C toolchain (native modules, cargo's linker), the
# usual unpackers and network tools, `ss` and `script` (some of fleetd's own tests run them), and tini and socat for
# the init.
RUN apt-get update && apt-get install -y --no-install-recommends \
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
# Node.js 24, pinned and checked, with npm, and pnpm and Yarn at their pins (fleetd's own lockfile installs:
# app/desktop's pnpm-lock.yaml, the package-lock.json files, a yarn.lock), all in /opt/node and on PATH. Playwright's
# installer runs under it, as the node runs it (npx).
RUN curl -fsSL -o /tmp/node.txz https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz \
 && echo "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb  /tmp/node.txz" | sha256sum -c - \
 && mkdir -p /opt/node /tmp/pw && tar -xJf /tmp/node.txz -C /opt/node --strip-components=1 \
 && /opt/node/bin/npm install -g --prefix /opt/node --no-fund --no-audit pnpm@12.11.2 yarn@1.22.22 \
 && for b in node npm npx corepack pnpm pnpx yarn yarnpkg; do [ ! -e /opt/node/bin/$b ] || ln -sf /opt/node/bin/$b /usr/local/bin/$b; done \
 && node --version && npm --version && pnpm --version && yarn --version \
 && cd /tmp/pw && npx --yes playwright@1.64.1 install --with-deps chromium-headless-shell ffmpeg \
 && chmod -R a+rX /opt/ms-playwright /opt/node \
 && cd / && rm -rf /tmp/pw /tmp/node.txz /root/.npm /root/.cache /var/lib/apt/lists/* \
 && mkdir -p /etc/fleetd \
 && printf 'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright\n' > /etc/fleetd/guest.env \
 && printf 'fleetd-box\n' > /etc/hostname \
 && git config --system --add safe.directory '*'
