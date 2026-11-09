/** As the Rust binary's `crate::version()`: the release sets FLEETD_VERSION, a local build is 0.0.0. */
export const VERSION = process.env.FLEETD_VERSION ?? "0.0.0";
