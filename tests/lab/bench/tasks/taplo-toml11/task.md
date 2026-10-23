This repository is Taplo, the TOML toolkit (parser, DOM, formatter, CLI and language server). TOML 1.1.0 was released
on 2025-12-18 (https://toml.io/en/v1.1.0, changelog https://github.com/toml-lang/toml/blob/main/CHANGELOG.md) and
Taplo does not support it yet. This is the open tracking issue https://github.com/tamasfe/taplo/issues/332 ("TOML
1.1.0"), with the formatter side in https://github.com/tamasfe/taplo/issues/331 ("Better formatter"). People hit it
in their editors and in `taplo fmt` on files that other tools already accept. CI's toml-test step only passes because
it skips every test Taplo fails today (the long `-skip` list in `.github/workflows/ci.yaml`).

Make Taplo a correct TOML 1.1.0 implementation:

1. **Parsing and decoding.** toml-test v2.1.0 run as CI runs it (`toml-test test -toml 1.1 -decoder "taplo
   toml-test"`, with the binary from `cargo build --bin taplo --no-default-features --features
   "rustls-tls,toml-test"`) passes every valid and every invalid test, with no skips. Remove the skip list from CI.
   Some failures are the TOML 1.1 features (`\e` and `\xHH` escapes, optional seconds in times and date-times,
   newlines, comments and trailing commas in inline tables); others are older bugs the suite also exposes (for
   example non-ASCII characters in comments and strings, local date-times, control characters, table redefinition).
   All of them count.
2. **Formatting (`taplo fmt`) of TOML 1.1 documents.**
   - It never fails or panics on a valid document. Its output is valid TOML 1.1 with exactly the same data, keeps
     every comment unchanged, and formatting the output again changes nothing. This holds for every valid document in
     toml-test and with any formatter options (except `reorder_arrays`, which changes data on purpose).
   - A multi-line inline table is laid out like a multi-line array: one entry per line, indented one level more than
     the line the table opens on, comments kept with their entries, the closing brace on its own line at the
     indentation of the opening line, and a comma after the last entry when `array_trailing_comma` is on (the
     default). It stays multi-line even when it would fit on one line. A single-line inline table stays on one line,
     without a trailing comma. For example, with the default options this is left as it is:

     ```toml
     server = {
       host = "localhost", # where it listens
       port = 8080,
       tls = { cert = "a.pem", key = "a.key" },
     }
     ```

   - Documents that use no TOML 1.1 syntax format exactly as they do today.
3. Everything else that reads TOML through the same parser and DOM (`taplo get`, `taplo lint`, the language server)
   accepts TOML 1.1 documents.

Add tests for what you change next to the existing ones; do not edit or delete existing tests. At the end, all of
these pass from the repository root: `cargo test -p taplo -p taplo-common -p taplo-cli -p lsp-async-stub -p
taplo-lsp`, `taplo fmt --check` (the repository's own TOML files, as CI checks them), and CI's toml-test step without
skips. Land the work on this repository's base branch (the branch checked out now).
