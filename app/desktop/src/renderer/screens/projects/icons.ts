// The built-in icons' images (shared/botIcons, built by app/shared/bot-icons): a glass being on a round field, at 32
// and 96 points, each at 1x, 2x and 3x. Each is a file of its own the page loads when it shows it, never inlined into
// the bundle the app parses at launch.
import type { ProjectIcon } from "../../../shared/contracts";

const FILES = import.meta.glob<string>("../../../shared/botIcons/*.webp", { eager: true, import: "default", query: "?no-inline" });
const DIR = "../../../shared/botIcons/";

export interface IconImage {
  readonly src: string;
  readonly srcSet: string;
}

/** The images of `icon` for a circle `size` px across; undefined for a face or color this build doesn't have. */
export const iconImage = (icon: ProjectIcon | undefined, size: number): IconImage | undefined => {
  if (icon === undefined) return undefined;
  const base = `${DIR}${icon.face}-${icon.color}-${size <= 32 ? "32" : "96"}`;
  const one = FILES[`${base}.webp`];
  const two = FILES[`${base}@2x.webp`];
  const three = FILES[`${base}@3x.webp`];
  if (one === undefined || two === undefined || three === undefined) return undefined;
  return { src: one, srcSet: `${one} 1x, ${two} 2x, ${three} 3x` };
};
