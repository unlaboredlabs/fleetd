import { describe, expect, it } from "vitest";
import type { ArtifactVersion } from "../../../shared/contracts";
import { when } from "../live/when";
import { artifactLinks, formatWord, metaLine, versionLabel } from "./model";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const v = (version: number, by = "Lead"): ArtifactVersion => ({ version, title: "Dependency sweep", format: "md", by, at: "2026-11-03T09:00:00.000Z", bytes: 1200 });
const href = (name: string, version: number | undefined) => `#/a/${name}${version === undefined ? "" : `/${String(version)}`}`;

describe("artifacts", () => {
  it("links each artifact to its tab, a version to that version, and leaves code and other links", () => {
    const md = "See [the sweep](artifact:dependency-sweep) and [v1](artifact:dependency-sweep@1), [docs](https://x.dev).\n\n`[x](artifact:no)`\n\n```\n[y](artifact:no)\n```";
    expect(artifactLinks(md, href)).toBe(
      "See [the sweep](#/a/dependency-sweep) and [v1](#/a/dependency-sweep/1), [docs](https://x.dev).\n\n`[x](artifact:no)`\n\n```\n[y](artifact:no)\n```",
    );
    // Not an artifact's name: left as written, which renders as its words.
    expect(artifactLinks("[a](artifact:Bad Name)", href)).toBe("[a](artifact:Bad Name)");
  });

  it("words a row and a version plainly, with no ids", () => {
    expect(formatWord("md")).toBe("Markdown");
    expect(formatWord("html")).toBe("HTML");
    const at = when("2026-11-03T09:00:00.000Z", NOW);
    expect(metaLine(v(1, "Sweep the dependencies"), NOW)).toBe(`Sweep the dependencies · ${at}`);
    expect(metaLine(v(3), NOW)).toBe(`Lead · ${at} · version 3`);
    expect(versionLabel(v(3), 3, NOW)).toBe(`Version 3 (newest) · Lead · ${at}`);
    expect(versionLabel(v(2), 3, NOW)).toBe(`Version 2 · Lead · ${at}`);
  });
});
