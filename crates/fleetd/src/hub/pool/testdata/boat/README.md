boat.dev's answers, as its OpenAPI spec (docs.boat.dev/openapi/boat-v1.yaml, v1.0.0, read 2026-11-03) and its limits
page (docs.boat.dev/limits) show them, with this hub's labels. `boat_tests.rs` serves them (answers.json, by name) from a fake boat. When the
spike on a real account (W407) records boat's own answers, they replace these, under the same names.
