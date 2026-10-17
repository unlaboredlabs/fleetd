// The intake router: one `claude -p` run on the hub machine, the only way fleetd reaches a model. It uses the login the
// user's own `claude` uses (~/.claude: OAuth, or a base URL and token in its settings' env), in safe mode so none of
// the user's hooks, plugins, MCP servers or CLAUDE.md load, and nothing of any `CLAUDE*` session the hub was started from.
import { RouterResult, type ProjectRef } from "@fleetd/contracts";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const DEFAULT_ROUTER_MODEL = "claude-haiku-5-5";
const RUN_TIMEOUT_MS = 90_000;
const MAX_STDOUT = 1 << 20;

/** Copied from the hub's environment into the run: what lets `claude` reach the user's login or proxy. */
export const LOGIN_ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
const BASE_ENV = ["HOME", "PATH", "USER", "LANG"] as const;

export interface RouterProject {
  readonly ref: ProjectRef;
  readonly title: string;
  readonly root: string;
  /** Titles of its latest workstreams, newest first. */
  readonly recentIntents: ReadonlyArray<string>;
}

/** One `claude` run, recorded as `orchestrator` usage. Tokens only when the CLI reported them. */
export interface RouterRun {
  readonly kind: "orchestrator";
  readonly model: string;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Why the run gave no usable answer. */
  readonly error?: string;
}

export interface RouteOutcome {
  /** Absent when the router could not place the intent: the caller asks the human. */
  readonly result?: RouterResult;
  /** Why there is no result, for the fallback ask. */
  readonly why?: string;
  readonly runs: ReadonlyArray<RouterRun>;
}

export class IntakeRouter extends Context.Service<
  IntakeRouter,
  {
    readonly route: (input: { readonly text: string; readonly projects: ReadonlyArray<RouterProject> }) => Effect.Effect<RouteOutcome>;
  }
>()("fleetd/intake/IntakeRouter") {}

export interface RouterOptions {
  /** The hub home; runs use the empty `<home>/claude-router` as their working directory. */
  readonly home: string;
  readonly model?: string;
  /** Where the login variables and PATH come from; the hub's own environment by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Read from beside this module: the source tree, or the CLI bundle's dist, where its build copies it. */
export const readRouterPrompt = () => fs.readFileSync(new URL("./router-prompt.md", import.meta.url), "utf8");

export const renderRouterPrompt = (template: string, input: { readonly text: string; readonly projects: ReadonlyArray<RouterProject> }) =>
  template
    .replace(
      "{{projects}}",
      input.projects
        .map((p) =>
          JSON.stringify({ machineId: p.ref.machineId, projectId: p.ref.projectId, title: p.title, folder: path.basename(p.root), recentIntents: p.recentIntents }),
        )
        .join("\n"),
    )
    .replace("{{intent}}", input.text.trim());

/**
 * The child's whole environment: an allowlist, so the hub's own `CLAUDE*` variables never reach it. Without
 * `CLAUDE_CONFIG_DIR`, `claude` reads the user's login from `$HOME/.claude`, as it does in their own shell.
 */
export const routerEnv = (source: Readonly<Record<string, string | undefined>>) => {
  const env: Record<string, string> = {};
  for (const key of [...BASE_ENV, ...LOGIN_ENV]) {
    const value = source[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
};

/** `claude <args>` with the router's environment and nothing else, for the doctor's login check (no model call). */
export const claudeRunner = (args: ReadonlyArray<string>) =>
  Effect.callback<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }, { readonly spawnError: string }>((resume, signal) => {
    execFile("claude", [...args], { signal, timeout: 30_000, env: routerEnv(process.env), maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error === null) return resume(Effect.succeed({ exitCode: 0, stdout, stderr }));
      if (typeof error.code === "number") return resume(Effect.succeed({ exitCode: error.code, stdout, stderr }));
      resume(Effect.fail({ spawnError: error.code === "ENOENT" ? "ENOENT" : error.message }));
    });
  });

/** No tools, no MCP servers, no saved session, and none of the user's customizations; the login still applies. */
export const ONE_SHOT_FLAGS = ["--tools", "", "--strict-mcp-config", "--no-session-persistence", "--safe-mode"] as const;

const decodeResult = Schema.decodeUnknownResult(RouterResult);

type Verdict =
  | { readonly kind: "ok"; readonly result: RouterResult }
  | { readonly kind: "unsure"; readonly reason: string }
  | { readonly kind: "invalid"; readonly error: string };

/** The model's answer from the text of the CLI's `result`, checked against the projects it was offered. */
export const judgeAnswer = (text: string, projects: ReadonlyArray<RouterProject>): Verdict => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return { kind: "invalid", error: "the answer has no JSON object" };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { kind: "invalid", error: "the answer is not valid JSON" };
  }
  if (typeof raw === "object" && raw !== null && "projectRef" in raw && raw.projectRef === null) {
    const reason = "reason" in raw && typeof raw.reason === "string" ? raw.reason.replace(/\s+/gu, " ").trim().slice(0, 200) : "";
    return { kind: "unsure", reason: reason === "" ? "the router could not tell which project" : reason };
  }
  const decoded = decodeResult(raw);
  if (decoded._tag === "Failure") return { kind: "invalid", error: `the answer does not match {projectRef, template, reason}: ${String(decoded.failure).slice(0, 300)}` };
  const result = decoded.success;
  const known = projects.some((p) => p.ref.machineId === result.projectRef.machineId && p.ref.projectId === result.projectRef.projectId);
  if (!known) return { kind: "invalid", error: `${result.projectRef.machineId}/${result.projectRef.projectId} is not one of the listed projects` };
  return { kind: "ok", result };
};

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** `claude -p --output-format json` stdout: the `result` text and the usage it reports. */
export const readEnvelope = (stdout: string): { readonly text?: string; readonly error?: string; readonly inputTokens?: number; readonly outputTokens?: number } => {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { error: "the CLI printed no JSON result" };
  }
  if (typeof envelope !== "object" || envelope === null) return { error: "the CLI printed no JSON result" };
  const e = envelope as { readonly result?: unknown; readonly is_error?: unknown; readonly usage?: Record<string, unknown> };
  const tokens =
    e.usage === undefined
      ? {}
      : {
          inputTokens: count(e.usage.input_tokens) + count(e.usage.cache_creation_input_tokens) + count(e.usage.cache_read_input_tokens),
          outputTokens: count(e.usage.output_tokens),
        };
  if (e.is_error === true || typeof e.result !== "string") {
    return { ...tokens, error: `the CLI reported an error: ${String(e.result ?? "no result").slice(0, 200)}` };
  }
  return { ...tokens, text: e.result };
};

interface Exit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: string;
}

/** Runs `claude` once with the prompt on stdin. Interrupting the effect kills the child. */
const runClaude = (args: ReadonlyArray<string>, prompt: string, cwd: string, env: Record<string, string>, timeoutMs: number) =>
  Effect.callback<Exit>((resume, signal) => {
    const child = spawn("claude", [...args], { cwd, env, signal, timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (exit: Exit) => {
      if (done) return;
      done = true;
      resume(Effect.succeed(exit));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (error) => finish({ code: null, stdout, stderr, spawnError: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });

export interface OneShotOptions extends RouterOptions {
  /** Default 90 s. */
  readonly timeoutMs?: number;
}

/** The answer text of one run, absent when the run failed (`run.error` says why), and the run as orchestrator usage. */
export interface OneShotResult {
  readonly text?: string;
  readonly run: RouterRun;
}

/**
 * The `claude -p --output-format json` runner the router and the retro share: the user's own login, the empty
 * `<home>/claude-router` as cwd (so no project CLAUDE.md applies), the allowlisted environment and `ONE_SHOT_FLAGS`.
 */
export const makeOneShot = (options: OneShotOptions) =>
  Effect.gen(function* () {
    const model = options.model ?? DEFAULT_ROUTER_MODEL;
    const cwd = path.join(options.home, "claude-router");
    yield* Effect.sync(() => fs.mkdirSync(cwd, { recursive: true, mode: 0o700 }));
    const env = routerEnv(options.env ?? process.env);
    const args = ["-p", "--output-format", "json", "--model", model, ...ONE_SHOT_FLAGS];
    const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
    return (prompt: string): Effect.Effect<OneShotResult> =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const exit = yield* runClaude(args, prompt, cwd, env, timeoutMs);
        const durationMs = (yield* Clock.currentTimeMillis) - started;
        const envelope = exit.spawnError === undefined ? readEnvelope(exit.stdout) : { error: `could not start claude: ${exit.spawnError}` };
        const failed = envelope.error ?? (exit.code === 0 ? undefined : `claude exited with ${exit.code ?? "a signal"}: ${exit.stderr.trim().slice(-200)}`);
        const run: RouterRun = {
          kind: "orchestrator",
          model,
          durationMs,
          ok: failed === undefined,
          ...(envelope.inputTokens === undefined ? {} : { inputTokens: envelope.inputTokens }),
          ...(envelope.outputTokens === undefined ? {} : { outputTokens: envelope.outputTokens }),
          ...(failed === undefined ? {} : { error: failed.slice(0, 300) }),
        };
        return failed === undefined ? { text: envelope.text ?? "", run } : { run };
      });
  });

export const make = (options: RouterOptions) =>
  Effect.gen(function* () {
    const template = readRouterPrompt();
    const oneShot = yield* makeOneShot(options);

    const attempt = (prompt: string, projects: ReadonlyArray<RouterProject>) =>
      Effect.gen(function* () {
        const { text, run } = yield* oneShot(prompt);
        const verdict: Verdict = text === undefined ? { kind: "invalid", error: run.error ?? "no answer" } : judgeAnswer(text, projects);
        return {
          verdict,
          run: verdict.kind === "invalid" ? { ...run, ok: false, error: verdict.error.slice(0, 300) } : run,
        };
      });

    const route: IntakeRouter["Service"]["route"] = (input) =>
      Effect.gen(function* () {
        const prompt = renderRouterPrompt(template, input);
        const first = yield* attempt(prompt, input.projects);
        if (first.verdict.kind === "ok") return { result: first.verdict.result, runs: [first.run] };
        if (first.verdict.kind === "unsure") return { why: first.verdict.reason, runs: [first.run] };
        const retryPrompt = `${prompt}\n\nYour previous answer was not usable (${first.verdict.error}). Reply with only the JSON object.`;
        const second = yield* attempt(retryPrompt, input.projects);
        const runs = [first.run, second.run];
        if (second.verdict.kind === "ok") return { result: second.verdict.result, runs };
        if (second.verdict.kind === "unsure") return { why: second.verdict.reason, runs };
        return { why: `the router gave no usable answer twice (${second.verdict.error})`.slice(0, 300), runs };
      });

    return IntakeRouter.of({ route });
  });

export const layer = (options: RouterOptions) => Layer.effect(IntakeRouter, make(options));
