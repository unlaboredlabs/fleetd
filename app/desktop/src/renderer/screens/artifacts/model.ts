// A chat's Artifacts (W367, D292), kept pure: a format's word, a row's and a file's hover, an artifact's line, a version's, the version a route
// opens, and the chat text's artifact links (`[Title](artifact:<name>)`, `artifact:<name>@<version>`) as routes to
// the panel's tab.
import type { ArtifactFormat, ArtifactVersion, ChatFile } from "../../../shared/contracts";
import { kindOf } from "../../../shared/files";
import { fmtBytes } from "../chat/attachments";
import { when } from "../live/when";

/** "Markdown", "HTML"; a format a newer hub adds, as it names it. */
export const formatWord = (f: ArtifactFormat): string => (f === "md" ? "Markdown" : f === "html" ? "HTML" : String(f).toUpperCase());

/** A row's line under its title: who published it, when, and which version, once there is more than one. */
export const metaLine = (v: ArtifactVersion, now: number): string =>
  [v.by, when(v.at, now), ...(v.version > 1 ? [`version ${String(v.version)}`] : [])].join(" · ");

/** A row's hover: its format, who published it, and which version, once there is more than one. */
export const rowDetail = (v: ArtifactVersion): string => [formatWord(v.format), v.by, ...(v.version > 1 ? [`version ${String(v.version)}`] : [])].join(" · ");

/** A file's hover: its kind and size. */
export const fileDetail = (f: ChatFile): string => [kindOf(f.mime), fmtBytes(f.bytes)].join(" · ");

/** A version in its picker: "Version 2 · Lead · 3h ago", the newest one so marked. */
export const versionLabel = (v: ArtifactVersion, newest: number, now: number): string =>
  `Version ${String(v.version)}${v.version === newest ? " (newest)" : ""} · ${v.by} · ${when(v.at, now)}`;

// Code (fences, spans) is left alone; a link whose target is an artifact becomes its route.
const LINKS = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\[([^\]\n]+)\]\(artifact:([a-z0-9]+(?:-[a-z0-9]+)*)(?:@([1-9]\d{0,8}))?\)/g;

/** Markdown with its artifact links pointing at `href` (the artifact in the panel); code and other links stay. */
export const artifactLinks = (md: string, href: (name: string, version: number | undefined) => string): string =>
  md.includes("](artifact:")
    ? md.replace(LINKS, (whole, title: string | undefined, name: string | undefined, version: string | undefined) =>
        title === undefined || name === undefined ? whole : `[${title}](${href(name, version === undefined ? undefined : Number(version))})`,
      )
    : md;
