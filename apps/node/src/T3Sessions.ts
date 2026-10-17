import { execFile } from "node:child_process";
import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";

/** A bearer session minted with T3's own CLI against this machine's T3 home. */
export interface T3Session {
  readonly sessionId: string;
  readonly bearer: Redacted.Redacted<string>;
  readonly expiresAt: string;
}

/** Carries only T3's exit code and the tail of its stderr; stdout holds the bearer and is never kept. */
export class T3SessionError extends Data.TaggedError("T3SessionError")<{
  readonly operation: "issue" | "revoke";
  readonly exitCode: number | null;
  readonly stderrTail: string;
}> {
  override get message() {
    return `t3 auth session ${this.operation} failed (exit ${this.exitCode ?? "none"}): ${this.stderrTail}`;
  }
}

export class T3Sessions extends Context.Service<
  T3Sessions,
  {
    readonly mint: Effect.Effect<T3Session, T3SessionError>;
    readonly revoke: (sessionId: string) => Effect.Effect<void, T3SessionError>;
  }
>()("fleetd/node/T3Sessions") {}

const IssuedSession = Schema.Struct({ sessionId: Schema.NonEmptyString, token: Schema.NonEmptyString, expiresAt: Schema.String });
const decodeIssued = Schema.decodeUnknownOption(Schema.fromJsonString(IssuedSession));

/** Children get only these variables, so the `CLAUDE*` ones of whatever started the node never leak into T3. */
export const scrubbedEnv = () =>
  Object.fromEntries(["HOME", "PATH", "USER", "LANG"].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));

const runT3 = (t3Cmd: ReadonlyArray<string>, operation: T3SessionError["operation"], args: ReadonlyArray<string>) =>
  Effect.callback<string, T3SessionError>((resume, signal) => {
    const [command = "t3", ...prefix] = t3Cmd;
    execFile(command, [...prefix, ...args], { env: scrubbedEnv(), signal, timeout: 60_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error === null) return resume(Effect.succeed(stdout));
      const exitCode = typeof error.code === "number" ? error.code : null;
      resume(Effect.fail(new T3SessionError({ operation, exitCode, stderrTail: String(stderr).trim().slice(-300) })));
    });
  });

/**
 * Mints with `--json` rather than `--token-only`: rotation has to revoke the previous session, and only the JSON
 * output carries the session id `auth session revoke` takes.
 */
export const layerCli = (options: { readonly t3Cmd: ReadonlyArray<string>; readonly t3Home: string; readonly ttl?: string }) =>
  Layer.succeed(T3Sessions)({
    mint: runT3(options.t3Cmd, "issue", [
      "auth", "session", "issue", "--base-dir", options.t3Home, "--ttl", options.ttl ?? "1h", "--label", "fleetd-node", "--json",
    ]).pipe(
      Effect.flatMap((stdout) => {
        const issued = decodeIssued(stdout.slice(stdout.indexOf("{")));
        return issued._tag === "Some"
          ? Effect.succeed({ sessionId: issued.value.sessionId, bearer: Redacted.make(issued.value.token), expiresAt: issued.value.expiresAt })
          : Effect.fail(new T3SessionError({ operation: "issue", exitCode: 0, stderrTail: "output is not the expected JSON" }));
      }),
    ),
    revoke: (sessionId) =>
      runT3(options.t3Cmd, "revoke", ["auth", "session", "revoke", "--base-dir", options.t3Home, sessionId]).pipe(Effect.asVoid),
  });
