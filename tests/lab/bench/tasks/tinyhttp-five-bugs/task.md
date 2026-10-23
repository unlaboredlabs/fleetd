This repository is the tinyhttp monorepo. Five bug reports came in. Fix each one at its root cause, and add a
regression test for each next to the existing tests. They are independent of each other.

1. **HEAD runs the wrong handler.** With `app.post('/item', ...)` registered before `app.get('/item', ...)`, a `HEAD
   /item` request runs the POST handler. A HEAD request must only run the GET, HEAD and `all` routes for its path (the
   GET handler, without a body), as in express, wherever they were registered.
2. **`req.hostname` is wrong for an escaped Host.** A request sent with `Host: %41pi.example.com` gets `req.hostname`
   `api.example.com`, a host the request was not sent to, and `Host: %` fails the request with a 500. The host from
   `Host`, `:authority` or a trusted `X-Forwarded-Host` must only be lowercased, never percent-decoded. `getHost(req,
   trust)`, exported by `@tinyhttp/app`, derives it and must return the right host on its own.
3. **HTTPS requests report `http`.** On an HTTPS server (`https.createServer(options, app.attach)`), `req.protocol`
   is `http` and `req.secure` is `false`, unless a trusted proxy sent `X-Forwarded-Proto`. They must be `https` and
   `true` when the connection is encrypted, as in express. `getProtocol(req, trust)`, exported by `@tinyhttp/app`,
   derives it and must return the right protocol on its own.
4. **The rate limiter counts every client together.** With `@tinyhttp/rate-limit`'s default options and the app's
   `networkExtensions` setting off, all clients share one limit. The default key must be the client's address:
   `req.ip` when set, else the socket's remote address.
5. **`res.cookie` changes its options argument.** Calling `res.cookie('a', 'b', opts)` twice with one
   `opts = { maxAge: 60000 }` sends `Max-Age=60` the first time and a wrong `Max-Age` the second, because the options
   object was modified. `res.cookie` must leave the options object it is given exactly as it was (no changed or added
   keys), and send the same cookie attributes every time.

Do not remove or skip existing tests. At the end, all of these pass from the repository root:
`pnpm install --frozen-lockfile`, `pnpm build`, `pnpm exec biome ci .` and `pnpm exec vitest run --dir tests`. Land the
work on this repository's base branch (the branch checked out now).
