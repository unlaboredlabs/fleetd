This repository is the tinyhttp monorepo. Make its TypeScript stricter: turn on `noImplicitAny` and
`noUncheckedIndexedAccess` for every package, and fix every error that brings, without changing behavior.

- Set `"noImplicitAny": true` and `"noUncheckedIndexedAccess": true` in the root `tsconfig.json`, which every
  package's `tsconfig.json` extends. No package may turn either option off again.
- Fix the code so that `pnpm build` (which runs `tsc` in every package) passes with them on. Fix the types for real:
  do not add `// @ts-ignore`, `// @ts-expect-error` or `// @ts-nocheck`, and do not add explicit `any` (`: any`,
  `as any`, `any[]`, `<any>` and the like) in `packages/*/src`. Prefer real narrowing over non-null assertions where
  a value can actually be missing.
- No behavior changes: the existing tests must keep passing without being changed. Public type signatures may only
  get more precise where the old type was an implicit `any`.

At the end, all of these pass from the repository root: `pnpm install --frozen-lockfile`, `pnpm build`,
`pnpm exec biome ci .` and `pnpm exec vitest run --dir tests`. Land the work on this repository's base branch (the
branch checked out now).
