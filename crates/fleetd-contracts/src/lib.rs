//! fleetd's wire types, shared by the binary and the app. They keep the wire JSON and decode checks of older hubs,
//! so data an older hub stored still reads back.
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
pub mod live;
pub mod mcp;
pub mod model;
pub mod node_link;
pub mod pair;
pub mod plan;
pub mod playbooks;
pub mod projects;
pub mod prompts;
pub mod retro;
pub mod schema;
pub mod secrets;
pub mod sessions;
pub mod status;
pub mod subscriptions;
pub mod tasks;
pub mod time;
pub mod train;
pub mod usage;
pub mod verification;
pub mod wakes;
