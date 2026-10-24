This repository is the tinyhttp monorepo. Rename the request and response extension packages and their helpers,
and move the HTML escaping helper into its own package. This is a breaking rename; behavior does not change.

1. `@tinyhttp/req` (`packages/req`) becomes `@tinyhttp/request` (`packages/request`). Its files keep their names
   (`src/index.ts`, `src/fresh.ts`, `src/accepts.ts`, ...). Rename its exports:
   `getRequestHeader` to `requestHeader`, `getRangeFromHeader` to `requestRange`, `getFreshOrStale` to
   `isRequestFresh`, `checkIfXMLHttpRequest` to `isXhr`. Every other export keeps its name.
2. `@tinyhttp/res` (`packages/res`) becomes `@tinyhttp/response` (`packages/response`). Its files keep their names.
   Rename its exports: `getResponseHeader` to `responseHeader`, `setLinksHeader` to `setLinks`, `setVaryHeader` to
   `setVary`, `setLocationHeader` to `setLocation`, `formatResponse` to `formatByAccept`. Every other export keeps its
   name, and `acceptParams` and `normalizeType` stay in `src/util.ts`.
3. `escapeHTML` moves out of `packages/res/src/util.ts` into a new package `@tinyhttp/html-escape`
   (`packages/html-escape`, exporting `escapeHTML` from `src/index.ts`), and `@tinyhttp/response` no longer exports
   it. The new package follows the layout of the existing ones: `package.json` with `"type": "module"`,
   `"exports": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, `"files": ["dist"]`, `"license": "MIT"` and a
   `"build": "tsc"` script; a `tsconfig.json` like the other packages'; and a short `README.md`.
4. Each renamed or new package's `package.json` has its new `name` and a `repository.directory` naming its new
   directory. Every user of the old packages and names (other packages, tests, examples, READMEs, `CLAUDE.md`) uses
   the new ones; no old package name, old directory path or old export name is left anywhere in the repository,
   except in `CHANGELOG.md` files, existing changesets and `pnpm-lock.yaml`.
5. Add a changeset (`.changeset/<name>.md`) for the rename that names `@tinyhttp/request`, `@tinyhttp/response` and
   `@tinyhttp/html-escape`.

At the end, all of these pass from the repository root: `pnpm install --frozen-lockfile`, `pnpm build`,
`pnpm exec biome ci .` and `pnpm exec vitest run --dir tests`, and existing tests keep passing (updated to the new
names). Land the work on this repository's base branch (the branch checked out now).
