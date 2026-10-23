This repository is the tinyhttp monorepo. Add the eight packages below. Each one brings a popular HTTP utility from
npm into tinyhttp as a dependency-free TypeScript package with named exports, and they are independent of each other.

## Rules for every part

- A new package lives in `packages/<name>/` and follows the layout of the existing packages: `package.json` with
  `"name": "@tinyhttp/<name>"`, `"type": "module"`, `"exports": "./dist/index.js"`, `"types": "./dist/index.d.ts"`,
  `"files": ["dist"]`, `"license": "MIT"` and a `"build": "tsc"` script; a `tsconfig.json` like the other packages';
  `src/index.ts`; and a short `README.md` with usage.
- No dependencies: a package uses only Node's built-in modules, so `pnpm-lock.yaml` does not change.
- "Behaves like `<npm package>@<version>`" means the same results, thrown errors (type and message) and side effects
  for the API listed, as that version of the package.
- Every part has tests under `tests/` (for example `tests/modules/<name>.test.ts`), next to the existing ones.
- At the end, all of these pass from the repository root: `pnpm install --frozen-lockfile`, `pnpm build`,
  `pnpm exec biome ci .` and `pnpm exec vitest run --dir tests`. Existing tests keep passing.
- Land all of the work on this repository's base branch (the branch checked out now).

## 1. `@tinyhttp/ms`

Named exports `ms(value, options?)`, `parse(string)` and `format(milliseconds, options?)`. `ms` behaves like
`ms@2.1.3`: a non-empty string is parsed (`undefined` when it can't be), a finite number is formatted (`options.long`
for `'1 minute'` rather than `'1m'`), and anything else throws its error. `parse` and `format` are its two halves.

## 2. `@tinyhttp/http-errors`

Named exports `createError(...)`, `HttpError` and `isHttpError(value)`, behaving like `http-errors@2.0.0`, with Node's
`STATUS_CODES` (from `node:http`) as the status messages. `createError` also carries a constructor for every 4xx and
5xx status, by name and by code (`new createError.NotFound()`, `new createError[404]('message')`), and
`createError.HttpError` and `createError.isHttpError`. Error names, messages, `status`, `statusCode` and `expose` as in
http-errors; `HttpError` itself can't be constructed.

## 3. `@tinyhttp/on-finished`

Named exports `onFinished(message, listener)` and `isFinished(message)`, behaving like `on-finished@2.4.1` for Node
`IncomingMessage` and `ServerResponse`: the listener gets `(err, message)` once the request is fully read or the
response sent, or its connection closes or errors, and on a later tick when that already happened.

## 4. `@tinyhttp/on-headers`

Named export `onHeaders(res, listener)`, behaving like `on-headers@1.0.2`: the listener runs once, with `this` the
response, right before the headers are written, after the status and headers passed to `writeHead` (an object or an
array of pairs) are applied, and can still change them.

## 5. `@tinyhttp/media-typer`

Named exports `parse(string)`, `test(string)` and `format(object)`, behaving like `media-typer@1.1.0`.

## 6. `@tinyhttp/escape-html`

Named export `escapeHtml(value)`, behaving like `escape-html@1.0.3`.

## 7. `@tinyhttp/raw-body`

Named export `getRawBody(stream, options?, callback?)`, behaving like `raw-body@3.0.0`: returns a promise unless a
callback is given; `options` may be `true` or an encoding string instead of `{ length, limit, encoding }`. `limit` is a
number of bytes or a string with a unit (`'100kb'`, `'1.5mb'`; 1024-based, case-insensitive). Decoding uses the
encodings Node's `TextDecoder` knows; any other is the 415 error. Errors carry `status`, `statusCode`, `expose`,
`type` and the same details (`limit`, `length`, `expected`, `received`, `encoding`) as raw-body's.

## 8. `@tinyhttp/keygrip`

Named exports `Keygrip` (a class: `new Keygrip(keys, algorithm?, encoding?)`) and `keygrip(...)` (the same without
`new`), with `sign`, `verify` and `index`, behaving like `keygrip@1.1.0`.
