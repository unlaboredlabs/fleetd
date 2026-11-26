// What Hermes, the phone's JavaScript engine, has past ES2022, the library the app is typed against (tsconfig.json's
// lib): a call to a built-in Hermes lacks throws on the phone and ends the app (Array.prototype.toSorted did, W272), so
// the typecheck refuses anything newer than these. Add one here only once react-native's Hermes has it (hermes.test.ts).

interface Array<T> {
  findLast<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S, thisArg?: unknown): S | undefined;
  findLast(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): T | undefined;
  findLastIndex(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): number;
}

interface ReadonlyArray<T> {
  findLast<S extends T>(predicate: (value: T, index: number, array: readonly T[]) => value is S, thisArg?: unknown): S | undefined;
  findLast(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: unknown): T | undefined;
  findLastIndex(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: unknown): number;
}
