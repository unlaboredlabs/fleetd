boat.dev's answers, as its OpenAPI spec (docs.boat.dev/openapi/boat-v1.yaml, v1.0.0, read 2026-11-03) and its limits
page (docs.boat.dev/limits) show them, with this hub's labels. `boat_tests.rs` serves them (answers.json, by name) from a fake boat. When the
spike on a real account (W407) records boat's own answers, they replace these, under the same names.

signin.json holds boat's answers to "Sign in with boat" (`signin_tests.rs`), as W448's spike recorded them on a real
account on 2026-11-04, every token, key and claim token replaced by a test value. Its names are this hub's: the key is
`fleetd-devbox` and the second environment `fleetd-devbox` (the spike's account had only `base`, so its id is the one
the spike scoped its key to). `pending` is auth.md's documented answer: the spike's person signed in before the first
poll.
