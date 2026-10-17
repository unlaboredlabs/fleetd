//! fleetd's wire types, ported from `packages/contracts` (Effect Schema) with the same JSON on the wire.
//!
//! Module names follow the TS files and type names follow the TS exports. Every type decodes with the same checks as
//! its TS schema, so the hub refuses what the TS hub refuses; `schema::render_json_schemas` writes the JSON Schemas
//! the app validates against.

pub mod prim;

pub mod app;
pub mod auth;
pub mod effort;
pub mod events;
pub mod hello;
pub mod ids;
pub mod lead_calls;
pub mod ledger;
pub mod mcp;
pub mod model;
pub mod node_link;
pub mod schema;
pub mod secrets;
pub mod subscriptions;
pub mod tasks;
pub mod train;
pub mod usage;
pub mod verification;
