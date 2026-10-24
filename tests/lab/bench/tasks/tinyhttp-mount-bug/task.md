This repository is the tinyhttp monorepo. A user reported a routing regression in `@tinyhttp/app`:

> Routing goes wrong once a middleware mounted on a path has run. With `app.use('/api', (req, res, next) => next())`,
> `app.get('/api/me', ...)` and `app.get('/me', ...)`, a request to `/api/me` is answered by the `/me` route.

The repro is `tests/core/mount-repro.test.ts`; it fails now. Find the root cause and fix it. The fix must leave all of
the following true (several of them are broken today too):

1. A middleware mounted on a path gets the url relative to the mount path: `app.use('/public', fn)` sees `req.url`
   `/dashboard` for a request to `/public/dashboard`. When it calls `next()` without changing `req.url` itself, the
   rest of the chain (later middleware and routes) is matched against the original url again: `/public/dashboard`
   reaches `app.get('/public/dashboard')` and not `app.get('/dashboard')`, and a request to `/dashboard` still
   reaches `app.get('/dashboard')`.
2. Several mounted middlewares in a row each see the url relative to their own mount path: with `app.use('/a', f)`,
   `app.use('/a/b', g)` and a request to `/a/b/c`, `f` sees `/b/c`, `g` sees `/c`, and the route `/a/b/c` sees
   `/a/b/c`.
3. A guard mounted after another middleware on the same path still runs for the routes under it.
4. Mount paths with params, percent-encoded or not: the prefix stripped from `req.url` is the part of the raw url the
   mount path matched. A middleware on `/p/:name` gets `req.url` `/c`, `req.baseUrl` `/p/a%20b` and
   `req.params.name` `a b` for `/p/a%20b/c`; a sub-app mounted on `/:tenant` gets `req.url` `/users` for
   `/%C3%A9admin/users`. A route after such a middleware keeps its own params and the full original `req.url`.
5. A middleware that rewrites `req.url` and calls `next()` forwards the request to the routes matching the new url,
   and the middleware registered after it (for example an authentication check) still runs, exactly once, matched
   against the new url. This holds for a middleware mounted on a path that rewrites `req.url` too.

Add regression tests for what you fix next to the existing ones, keep the repro, and do not remove or skip tests.
At the end, all of these pass from the repository root: `pnpm install --frozen-lockfile`, `pnpm build`,
`pnpm exec biome ci .` and `pnpm exec vitest run --dir tests`. Land the work on this repository's base branch (the
branch checked out now).
