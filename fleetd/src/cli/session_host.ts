// `fleetd session-host …`: a session's host (src/node/runner/host/serve.ts), which the node starts once per session and
// which outlives it; `fleetd session-host stop-all <hosts dir>` stops every host there (machine remove). Imports only
// the host's own modules: one host runs per session, so what it loads is paid per session.
export async function run(argv: string[]): Promise<number> {
  const { main } = await import("../node/runner/host/serve.ts");
  return main(argv);
}
