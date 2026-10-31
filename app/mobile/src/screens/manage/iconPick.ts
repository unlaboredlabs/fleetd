// The icon sheet's pick (IconPicker.tsx): a face or color tapped, and the picture its project had then. The last choice
// wins: a photo saved after the pick (from this sheet's Choose or Take Photo, or another device) makes a new picture,
// and the pick no longer shows or is sent, so Done can't delete the photo just chosen. A photo removed after the pick
// leaves it standing: the face is still what the person chose. Pure, so it is unit-tested.
import type { ProjectIcon } from "../../desktop";

export interface Pick {
  readonly icon: ProjectIcon;
  /** The project's picture when it was picked: its summary's `avatar`. */
  readonly over: string | undefined;
}

export const pickOver = (icon: ProjectIcon, avatar: string | undefined): Pick => ({ icon, over: avatar });

/** The pick still standing against the project's picture now: what shows and what Done sends. */
export const standing = (pick: Pick | null, avatar: string | undefined): ProjectIcon | null =>
  pick !== null && (avatar === undefined || pick.over === avatar) ? pick.icon : null;
