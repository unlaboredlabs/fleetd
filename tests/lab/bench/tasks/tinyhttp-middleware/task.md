This repository is the tinyhttp monorepo. Add the eight middleware packages below. Each one brings a popular Express
middleware into tinyhttp as a dependency-free TypeScript package, and they are independent of each other.

## Rules for every part

- A new package lives in `packages/<name>/` and follows the layout of the existing packages: `package.json` with
  `"name": "@tinyhttp/<name>"`, `"type": "module"`, `"exports": "./dist/index.js"`, `"types": "./dist/index.d.ts"`,
  `"files": ["dist"]`, `"license": "MIT"` and a `"build": "tsc"` script; a `tsconfig.json` like the other packages';
  `src/index.ts`; and a short `README.md` with usage.
- No dependencies: a package uses only Node's built-in modules, so `pnpm-lock.yaml` does not change.
- "Behaves like `<npm package>@<version>`" means: for the options listed, the same responses, headers, errors and side
  effects on `req` as that package mounted with `app.use` on a tinyhttp `App`. Options that are not listed (deprecated
  signatures, string durations, `buffer`) are not needed.
- Every part has tests under `tests/` (for example `tests/modules/<name>.test.ts`), next to the existing ones.
- At the end, all of these pass from the repository root: `pnpm install --frozen-lockfile`, `pnpm build`,
  `pnpm exec biome ci .` and `pnpm exec vitest run --dir tests`. Existing tests keep passing.
- Land all of the work on this repository's base branch (the branch checked out now).

## 1. `@tinyhttp/cors`

Named export `cors(options?)`, behaving like `cors@2.8.5`. Options: `origin` (`'*'` by default; a string, `true`,
`false`, a RegExp, an array of strings and RegExps, or a function `(origin, callback)`), `methods` (string or array,
default `'GET,HEAD,PUT,PATCH,POST,DELETE'`), `allowedHeaders` (string or array; when unset, the request's
`Access-Control-Request-Headers` is reflected), `exposedHeaders`, `credentials`, `maxAge`, `preflightContinue` and
`optionsSuccessStatus` (default 204). `options` may also be a delegate `(req, callback(err, options))`. A `Vary` value
is added to any existing `Vary` header, never replacing it.

## 2. `@tinyhttp/method-override`

Named export `methodOverride(getter?, options?)`, behaving like `method-override@3.0.0`: `getter` is a header name
starting with `X-` (default `'X-HTTP-Method-Override'`, also added to `Vary`), any other string as a query parameter
name, or a function `(req, res)`. `options.methods` lists the original methods an override is allowed from (default
`['POST']`, `null` for any). Sets `req.originalMethod`.

## 3. `@tinyhttp/response-time`

Named export `responseTime(options?)`, behaving like `response-time@2.3.2`: sets the time from the middleware to the
response's headers being written, in milliseconds, as a header. Options `digits` (default 3), `header` (default
`X-Response-Time`) and `suffix` (default true, appends `ms`); a header already set is kept. `options` may instead be a
function `(req, res, time)` called at that moment, which can still set headers.

## 4. `@tinyhttp/favicon`

Named export `favicon(path, options?)`, behaving like `serve-favicon@2.5.0`: serves `/favicon.ico` from a file path
(read once, on the first request) or a Buffer, with its `ETag` (as the `etag` package computes it), `Cache-Control`
(`options.maxAge` in milliseconds, default and maximum one year), conditional `304`s, and the `Allow` responses for
methods other than GET and HEAD. The same errors for a missing or invalid `path`.

## 5. `@tinyhttp/vhost`

Named export `vhost(hostname, handle)`, behaving like `vhost@3.0.2`: `hostname` is a string with `*` wildcards or a
RegExp; a request whose `Host` matches runs `handle(req, res, next)` with `req.vhost` set (`host`, `hostname`,
`length` and each captured part by index); others go on to `next`. The same argument errors.

## 6. `@tinyhttp/timeout`

Named export `timeout(ms?, options?)`, behaving like `connect-timeout@1.9.0` (default 5000 ms): after the time, sets
`req.timedout`, emits `timeout` on `req` with the delay, and unless `options.respond` is `false` passes an error to
`next` whose `message` is `'Response timeout'`, `status` and `statusCode` are 503, `code` is `'ETIMEDOUT'`, `timeout` is
the delay and `expose` is false. `req.clearTimeout()` stops it; so do the response's headers being written or the
response finishing.

## 7. `@tinyhttp/morgan`

Named exports `morgan(format?, options?)`, `compile(format)`, `token(name, fn)` and `format(name, fmt)`, behaving like
`morgan@1.10.0`: the predefined formats `combined`, `common`, `default`, `short`, `tiny` and `dev`; every token
morgan defines (`:url`, `:method`, `:status`, `:response-time[digits]`, `:total-time[digits]`, `:date[clf|iso|web]`,
`:referrer`, `:remote-addr`, `:remote-user`, `:http-version`, `:user-agent`, `:req[header]`, `:res[header]`), `-` for a
token without a value, format functions `(tokens, req, res)` whose `null` or `undefined` skips the line, and the options
`immediate`, `skip` and `stream` (default `process.stdout`).

## 8. `@tinyhttp/unless`

Named export `unless(middleware, options)`, behaving like `express-unless@2.1.3` with the middleware passed as the
first argument instead of `this`: skips `middleware` (calls `next` instead) when `options.path` (string, RegExp,
`{ url, method | methods }`, or an array of them), `options.ext`, `options.method` or `options.custom` (a function,
sync or async; `options` may be that function alone) matches. Paths are matched against `req.originalUrl` unless
`useOriginalUrl` is false.
