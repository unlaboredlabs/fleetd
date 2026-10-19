// What kind of build this is, fixed when the bundle is built. Never derived from runtime state: app.isPackaged comes
// from the executable's name, so a copy of the release binary renamed `electron` would pass for a development run.

/** `electron-vite dev`. */
export const DEV_BUILD = import.meta.env.DEV;

/** The unpublished CI/QA/lab build (`pnpm build:test`, `pnpm qa:build`). */
export const TEST_BUILD = import.meta.env.MAIN_VITE_FLEETD_TEST_BUILD === "1";

/** Every other build: what `pnpm build` makes and what ships. Debugging switches and fixtures stay off. */
export const RELEASE_BUILD = !DEV_BUILD && !TEST_BUILD;
