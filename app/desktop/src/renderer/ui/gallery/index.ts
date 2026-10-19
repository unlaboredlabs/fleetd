import { lazy } from "react";

// The gallery ships only in dev builds, or in a build made with VITE_FLEETD_GALLERY=1 for the screenshot suite;
// otherwise the import below is dead code and the bundle has no gallery in it.
const enabled = import.meta.env.DEV || import.meta.env.VITE_FLEETD_GALLERY === "1";

/** The #/gallery screen (data-screen="gallery"), or null when this build has no gallery. */
export const GalleryScreen = enabled ? lazy(() => import("./Gallery")) : null;
