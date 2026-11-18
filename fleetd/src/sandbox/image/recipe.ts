// The recipe of a sandbox box's root and of the two tools fleetd builds itself, and the pin a node fetches them by.
// CI builds them (build.sh, .github/workflows/vm-image.yml) and publishes them to the GitHub release `vm-<key>`, where
// the key is the hash of this recipe: the Dockerfile, the init, the build script and the tools' commits. Changing any
// of them makes a new key, so CI builds a new release and every node fetches it, with no pin to bump by hand. claude
// and fleetd aren't in the image: a local VM's node gives it its own (node/place/provision.ts), so neither a Claude
// Code bump nor a fleetd update rebuilds it.
//
// Run as a script, it prints the recipe as JSON, for build.sh and the workflow.
import { createHash } from "node:crypto";
import { REPO } from "../../update/index.ts";
import build from "./build.sh" with { type: "text" };
import dockerfile from "./Dockerfile" with { type: "text" };
import init from "./init.sh" with { type: "text" };

/** The base image's recipe: one FROM, then RUN and ENV lines only, so a hosted provider builds the same text. */
export const DOCKERFILE: string = dockerfile;
/** PID 1 of a local VM: /sbin/fleetd-init in the root image. */
export const INIT: string = init;

/** The tools no upstream publishes a static build of, at the commits fleetd builds. */
export const SOURCES = {
  virtiofsd: { repo: "https://gitlab.com/virtio-fs/virtiofsd.git", version: "1.14.0", commit: "c2540f8db14caba81c1e37fba23fc7bf2cd7f0dd" },
  passt: { repo: "https://passt.top/passt", version: "2026_10_02.cba3570", commit: "cba357068dc586e7540971eb40bb56c5e62c4de1" },
} as const;

/** The release's assets: the root image (ext4, zstd-compressed), the two tools, and the sha256 of each. */
export const ASSETS = { root: "root-x86_64.ext4.zst", virtiofsd: "virtiofsd-x86_64", passt: "passt-x86_64", sums: "SHA256SUMS" } as const;

/** The recipe's hash, from everything that goes into the release. */
export function imageKey(parts: { dockerfile: string; init: string; build: string; sources: unknown }): string {
  const hash = createHash("sha256");
  for (const part of [parts.dockerfile, parts.init, parts.build, JSON.stringify(parts.sources)]) hash.update(`${part.length}\n${part}`);
  return hash.digest("hex");
}

const key = imageKey({ dockerfile, init, build, sources: SOURCES });

export const IMAGE = {
  key,
  /** The GitHub release holding this recipe's build. */
  tag: `vm-${key.slice(0, 12)}`,
  /** The pins written in the Dockerfile, for anyone who shows them. */
  pins: {
    ubuntu: "24.04",
    bun: "1.4.3",
    node: "24.22.3",
    pnpm: "12.11.2",
    yarn: "1.22.22",
    gh: "2.104.0",
    playwright: "1.64.1",
    virtiofsd: SOURCES.virtiofsd.version,
    passt: SOURCES.passt.version,
  },
} as const;

/** Where a node downloads one of the release's assets. */
export const assetUrl = (name: string, tag: string = IMAGE.tag) => `https://github.com/${REPO}/releases/download/${tag}/${name}`;

if (import.meta.main) console.log(JSON.stringify({ ...IMAGE, sources: SOURCES, assets: ASSETS }, null, 2));
