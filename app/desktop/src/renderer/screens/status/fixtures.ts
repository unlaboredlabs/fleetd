// The status fixtures (app/desktop/fixtures/status/*.json, each a status_get answer) by name, for the tests and the
// screen registry. Bundled at build time, so nothing reads the disk.
import type { StatusDoc } from "./contracts";

export const fixtureFiles: Record<string, unknown> = Object.fromEntries(
  Object.entries(import.meta.glob<unknown>("../../../../fixtures/status/*.json", { eager: true, import: "default" })).map(
    ([path, output]) => [path.replace(/^.*\/|\.json$/gu, ""), output],
  ),
);

export const fixture = (name: string): StatusDoc => {
  const output = fixtureFiles[name] as { doc: StatusDoc } | undefined;
  if (!output) throw new Error(`no status fixture ${name}`);
  return output.doc;
};
