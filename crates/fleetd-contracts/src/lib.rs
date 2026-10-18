//! fleetd's wire types, shared by the binary and the app. They were ported from the TypeScript contracts with the same
//! JSON on the wire and the same decode checks, so data a TS hub stored still reads back.
//! `schema::render_json_schemas` writes the JSON Schemas committed in `schema/`.

pub mod prim;

pub mod app;
pub mod auth;
pub mod doctor;
pub mod effort;
pub mod events;
pub mod hello;
pub mod ids;
pub mod lead_calls;
pub mod ledger;
pub mod mcp;
pub mod model;
pub mod node_link;
pub mod playbooks;
pub mod retro;
pub mod schema;
pub mod secrets;
pub mod subscriptions;
pub mod tasks;
pub mod train;
pub mod usage;
pub mod verification;
pub mod wakes;
