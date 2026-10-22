This repository is the tinyhttp monorepo. Implement the six parts below. They are independent of each other.

## Rules for every part

- A new package lives in `packages/<name>/` and follows the layout of the existing packages: `package.json` with
  `"name": "@tinyhttp/<name>"`, `"type": "module"`, `"exports": "./dist/index.js"`, `"types": "./dist/index.d.ts"`,
  `"files": ["dist"]`, `"license": "MIT"` and a `"build": "tsc"` script; a `tsconfig.json` like the other packages';
  `src/index.ts`; and a short `README.md` with usage.
- Every part has tests under `tests/` (for example `tests/modules/<name>.test.ts`), next to the existing ones.
- At the end, all of these pass from the repository root: `pnpm install --frozen-lockfile`, `pnpm build`,
  `pnpm exec biome ci .` and `pnpm exec vitest run --dir tests`. Existing tests keep passing.
- Land all of the work on this repository's base branch (the branch checked out now).

## 1. `@tinyhttp/vary` (new package)

Manipulates the `Vary` response header. Named exports:

- `append(header: string, field: string | string[]): string` returns `header` with each field added.
- `vary(res, field: string | string[]): void` does the same to a response's `Vary` header, through `res.getHeader`
  and `res.setHeader`. If the current header value is an array, its items are joined with `", "` first. It sets the
  header to the result whenever the result is not empty.

Semantics, identical to the npm package `vary@1.1.2`:

- `field` is a string of comma-separated field names or an array of them. Every field name must be a token
  (`/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/`), else `TypeError("field argument contains an invalid header name")`.
- `header` not a string: `TypeError("header argument is required")`. `field` missing:
  `TypeError("field argument is required")`.
- If the header is already `*`, or any field is `*`, the result is `*`.
- Fields already present (compared case-insensitively) are not added again; new ones keep their given case and order,
  joined with `", "`. An empty header becomes just the new fields.
- `vary` without a response object: `TypeError("res argument is required")`.

Examples: `append('', 'Origin')` is `'Origin'`; `append('Accept', ['Origin', 'accept'])` is `'Accept, Origin'`;
`append('Accept', 'Origin, *')` is `'*'`.

## 2. `@tinyhttp/bytes` (new package)

Formats and parses byte sizes. Named exports `format`, `parse` and `bytes`. Behavior identical to the npm package
`bytes@3.1.2` (`bytes(value, options)` is that package's default export, `format` and `parse` its `bytes.format` and
`bytes.parse`):

- Units are 1024-based: `b`, `kb`, `mb`, `gb`, `tb`, `pb` (parsed case-insensitively; formatted as `B`, `KB`, `MB`,
  `GB`, `TB`, `PB`).
- `format(value: number, options?)` returns `null` for a value that is not a finite number. Options:
  `decimalPlaces` (default 2), `fixedDecimals` (default false: trailing zeros are removed), `thousandsSeparator`
  (default none), `unit` (force a unit, written out as given; an unknown unit is ignored; default is the largest unit
  the value reaches), `unitSeparator` (default `''`). Examples: `format(1024)` is `'1KB'`, `format(1000)` is `'1000B'`, `format(1024 * 1.5, { unitSeparator: ' ' })`
  is `'1.5 KB'`, `format(1000, { thousandsSeparator: ',' })` is `'1,000B'`, `format(1024, { unit: 'b' })` is `'1024b'`.
- `parse(value: string | number)` returns a number of bytes, rounded down, or `null` if it cannot be parsed. A number
  is returned as is (`NaN` gives `null`). A string with a unit, like `'1.5KB'`, `'1 kb'` or `'-1mb'`, is converted;
  any other string is read with `parseInt(value, 10)` as bytes. Non-strings that are not numbers give `null`.
- `bytes(value, options?)` parses a string, formats a number, and returns `null` for anything else.

## 3. `@tinyhttp/basic-auth` (new package)

Parses HTTP Basic credentials, identical to the npm package `basic-auth@2.0.1`. Named exports:

- `parse(header: string): { name: string; pass: string } | undefined` parses an `Authorization` header value. The
  scheme `Basic` is matched case-insensitively, with optional surrounding spaces; the credentials are base64 and are
  split at the first `:` (the password may contain `:`; an empty user or password is allowed). Anything malformed,
  including a non-string argument or decoded credentials with no `:`, gives `undefined`.
- `auth(req): { name: string; pass: string } | undefined` reads `req.headers.authorization`. Without `req`:
  `TypeError("argument req is required")`; with a `req` that has no `headers` object:
  `TypeError("argument req is required to have headers property")`.

## 4. `@tinyhttp/statuses` (new package)

HTTP status code utilities. The status codes and their messages are exactly Node's `STATUS_CODES` from `node:http`.
Named exports:

- `status(code: number | string): number`. A number, or a string of digits, must be a known code, else
  `TypeError("invalid status code: <code>")`. Any other string is matched against the messages case-insensitively,
  else `TypeError('invalid status message: "<message>"')`. Returns the code.
- `message: Record<number, string>`: code to message.
- `code: Record<string, number>`: lowercased message to code.
- `codes: number[]`: every known code, ascending.
- `redirect: Record<number, boolean | undefined>`: `true` for 300, 301, 302, 303, 305, 307 and 308.
- `empty: Record<number, boolean | undefined>`: `true` for 204, 205 and 304.
- `retry: Record<number, boolean | undefined>`: `true` for 502, 503 and 504.

## 5. `@tinyhttp/cookie`: `partitioned` and `priority`

Add two options to `serialize`'s options (and its `SerializeOptions` type):

- `partitioned?: boolean`: when true, appends `; Partitioned`.
- `priority?: 'low' | 'medium' | 'high'` (matched case-insensitively): appends `; Priority=Low`, `; Priority=Medium`
  or `; Priority=High`. Any other value: `TypeError("option priority is invalid")`.

They come after `; Secure` and before `; SameSite=...`, `Partitioned` first. Example:
`serialize('foo', 'bar', { secure: true, partitioned: true, priority: 'HIGH', sameSite: 'lax' })` is
`'foo=bar; Secure; Partitioned; Priority=High; SameSite=Lax'`. Everything else about `serialize` is unchanged.

## 6. `@tinyhttp/app`: `app.param(name, handler)`

Express-style route parameter preprocessing on `App`:

- `app.param(name: string, handler: (req, res, next, value: string, name: string) => void | Promise<void>)` returns
  the app, for chaining. Several handlers for one name run in registration order.
- Before the first matched route handler (`app.get`, `app.post`, ..., `app.all`) whose path declares `:name` runs,
  the app runs that name's param handlers with `req.params` already set and `value = req.params[name]`. A param
  handler continues by calling `next()`; changes it makes to `req` (for example `req.params` or a new property) are
  seen by the route handlers.
- Within one request, each param handler runs once per distinct value: when several matched routes declare `:name`
  with the same value, the handlers do not run again.
- `next(err)` from a param handler, or a param handler that throws or returns a rejected promise, skips the route
  handlers and goes to the app's error handler (`onError`) with that error.
- Routes that do not declare `:name` never run its param handlers. Param handlers apply only to routes registered on
  the same `App` instance.
