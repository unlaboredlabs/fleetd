This repository is sql-formatter, the SQL pretty-printer library and CLI. Users asked for SAP HANA support in
https://github.com/sql-formatter-org/sql-formatter/issues/886 ("Feature Request: SAP HANA SQL Dialect Support"):

> I would like to request the addition of support for the SAP HANA SQL dialect in the sql-formatter library. SAP HANA
> is a widely used in-memory, column-oriented, relational database management system, and having support for it in
> sql-formatter would be highly beneficial for developers working with SAP environments. [...] Adding support for the
> SAP HANA SQL dialect will allow developers to format their queries and stored procedures that are specific to SAP
> HANA.

The maintainer's answer was that a pull request is the way to get it. Add a complete SAP HANA dialect, built the way
the existing dialects are (`src/languages/<dialect>/` with its keywords, data types, functions and formatter options,
and a `test/<dialect>.test.ts` that runs the shared feature tests that apply plus tests of its own):

1. **Selectable everywhere.** The language name is `hana` (`format(sql, { language: 'hana' })`, the CLI's `-l hana`,
   `supportedDialects`), and the package exports a `hana` dialect object for `formatDialect()`. Document it wherever
   the other dialects are listed: README, `docs/language.md`, `docs/dialect.md`, `schema.json`, and the demo page.
2. **HANA's lexical rules** (SAP HANA SQL Reference): string literals in single quotes, with a quote escaped by
   doubling it and no backslash escapes; `N'...'` Unicode and `X'...'` binary literals; delimited identifiers in
   double quotes, also escaped by doubling; undelimited identifiers may contain `#` and `$`, and local temporary tables
   start with `#` (`#tmp`); `--` and `/* */` comments; `?` and `:name` parameters (SQLScript also uses `:name` to read
   a variable, so it must stay one token); the usual operators plus `||` and `=>` (named arguments).
3. **HANA's SQL.** The standard queries, joins (no `NATURAL` join), set operations, `LIMIT`/`OFFSET` and `TOP`, DDL
   and DML format like they do in the other dialects. HANA's own statements and clauses are recognized and laid out
   sensibly: `UPSERT` (with `VALUES ... WITH PRIMARY KEY` or `WHERE`), `CREATE COLUMN | ROW | LOCAL TEMPORARY |
   GLOBAL TEMPORARY TABLE` with partitioning, sequences (`START WITH`, `seq.NEXTVAL`, `DUMMY`), query hints (`WITH
   HINT (...)`), `MERGE INTO`, `COMMENT ON`, calculation views with placeholders, and SQLScript: `CREATE PROCEDURE`
   with parameters and `LANGUAGE SQLSCRIPT ... AS BEGIN ... END`, anonymous `DO BEGIN ... END` blocks, `DECLARE`,
   `IF ... THEN ... ELSE ... END IF`, table variables, and `CALL` with named arguments. `WITH` in `WITH PRIMARY KEY`,
   `START WITH` and `WITH HINT` is not a common table expression. Formatting never changes anything but whitespace and
   (as configured) case, and formatting the output again changes nothing.
4. **HANA's vocabulary.** The keyword, data type and built-in function lists follow the SAP HANA SQL Reference, so
   `keywordCase`, `dataTypeCase` and `functionCase` work on HANA's own words (for example `SECONDDATE`,
   `NVARCHAR(10)`, `ALPHANUM`, `ST_GEOMETRY`; `ADD_DAYS(...)`, `TO_NVARCHAR(...)`, `STRING_AGG(...)`), and a call to
   a HANA built-in function is formatted as a function call.

Do not edit or delete existing tests. At the end, all of these pass from the repository root, as CI runs them:
`pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run pretty:check`, `pnpm run lint`, `pnpm run test`,
`pnpm run build` and `pnpm run ts:check`. Land the work on this repository's base branch (the branch checked out now).
