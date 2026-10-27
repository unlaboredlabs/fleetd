//! The hub schema: one SQL file per migration in migrations/, run in the order of their prefixes (build.rs lists
//! them). The `user_version` is how many have run, so a file's place in that order is fixed once it ships: never
//! edit, rename or remove one, add a new one. CONTRIBUTING.md says how.

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));
