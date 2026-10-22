// What every contender's claude runs with, held equal: the user's own ~/.claude setup (read, copied, never modified),
// the same claude CLI, and one model at one effort for every call, pinned with flags, settings and env, plus a
// recorded snapshot of the machine's load at the start and end of each run.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MODEL = "claude-opus-5-5";
export const EFFORT = "high";

/**
 * claude's model knobs, all pointed at MODEL: the main loop, the opus/sonnet/haiku/fable aliases a subagent or tool
 * may name, the small fast model background helpers use, subagents (forced), workflows and classifiers. Effort is
 * pinned the same way; fast mode (the same model at another price and speed) is off.
 */
export const PIN_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_MODEL: MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
  ANTHROPIC_DEFAULT_FABLE_MODEL: MODEL,
  ANTHROPIC_SMALL_FAST_MODEL: MODEL,
  CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
  CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
  CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: MODEL,
  CLAUDE_CODE_AUTO_MODE_MODEL: MODEL,
  CLAUDE_CODE_BG_CLASSIFIER_MODEL: MODEL,
  CLAUDE_CODE_EFFORT_LEVEL: EFFORT,
  CLAUDE_CODE_DISABLE_FAST_MODE: "1",
};

const userSettingsFile = () => path.join(os.homedir(), ".claude/settings.json");
const userSettings = (): Record<string, any> => (fs.existsSync(userSettingsFile()) ? (JSON.parse(fs.readFileSync(userSettingsFile(), "utf8")) as Record<string, any>) : {});

/** The user's endpoint: where the proxy forwards to. */
export const upstreamUrl = () => (userSettings().env?.ANTHROPIC_BASE_URL as string | undefined) ?? "https://api.anthropic.com";

/**
 * The settings.json every contender's ~/.claude gets: the user's own (hooks, env with their login, every other key),
 * with the model pins merged in and the endpoint pointed at the run's logging proxy.
 */
export const pinnedSettings = (proxyUrl: string): Record<string, unknown> => {
  const user = userSettings();
  return { ...user, model: MODEL, effortLevel: EFFORT, env: { ...(user.env ?? {}), ...PIN_ENV, ANTHROPIC_BASE_URL: proxyUrl } };
};

/** The pins as plain environment variables, for a process that reads env rather than settings. */
export const pinnedEnv = (proxyUrl: string): Record<string, string> => ({ ...PIN_ENV, ANTHROPIC_BASE_URL: proxyUrl });

/**
 * Lays out `<home>/.claude` from the user's setup: pinned settings.json, their CLAUDE.md and credentials if any, and
 * their user-scope MCP servers in `<home>/.claude.json`. Their files are read and copied, never written.
 */
export const copyClaudeSetup = (home: string, proxyUrl: string) => {
  const claude = path.join(home, ".claude");
  fs.mkdirSync(claude, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(claude, "settings.json"), `${JSON.stringify(pinnedSettings(proxyUrl), null, 2)}\n`, { mode: 0o600 });
  for (const f of ["CLAUDE.md", ".credentials.json"]) {
    const src = path.join(os.homedir(), ".claude", f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(claude, f));
      fs.chmodSync(path.join(claude, f), 0o600);
    }
  }
  const mcp = userMcpServers();
  if (Object.keys(mcp).length > 0) fs.writeFileSync(path.join(home, ".claude.json"), `${JSON.stringify({ mcpServers: mcp }, null, 2)}\n`, { mode: 0o600 });
};

const userMcpServers = (): Record<string, unknown> => {
  const file = path.join(os.homedir(), ".claude.json");
  try {
    return ((JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {});
  } catch {
    return {};
  }
};

/** What of the user's claude setup is active, by name only (no values, no secrets). */
export const activeSetup = () => {
  const s = userSettings();
  return {
    hooks: Object.keys(s.hooks ?? {}),
    mcpServers: Object.keys(userMcpServers()),
    claudeMd: fs.existsSync(path.join(os.homedir(), ".claude/CLAUDE.md")),
    enabledPlugins: Object.keys(s.enabledPlugins ?? {}),
    settingsKeys: Object.keys(s).sort(),
    envKeys: Object.keys(s.env ?? {}).sort(),
  };
};

export const claudeVersion = () => spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim();

/** Load average and how many claude processes run on the machine (counted from /proc, read only). */
export const loadSnapshot = () => {
  let claudes: number | null = null;
  if (fs.existsSync("/proc")) {
    claudes = 0;
    for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/u.test(d))) {
      try {
        if (/\/claude\/versions\/|\/claude$/u.test(fs.readlinkSync(`/proc/${pid}/exe`))) claudes++;
      } catch {
        // Gone.
      }
    }
  }
  const [one, five] = os.loadavg();
  return { at: new Date().toISOString(), loadavg1: Math.round(one! * 100) / 100, loadavg5: Math.round(five! * 100) / 100, cpus: os.cpus().length, claudeProcesses: claudes };
};

/** True when the machine was busy enough to skew a timing: load above half the cores. */
export const busy = (s: ReturnType<typeof loadSnapshot>) => s.loadavg1 > s.cpus / 2;

/**
 * A `claude` for fleetd's node and hub PATH: every print-mode call runs MODEL at EFFORT whatever model or effort the
 * caller asked for, and the asked values are logged (one line per call: time, model, effort) so a run shows what
 * fleetd would have picked. Other invocations (`claude auth status`, the init probe's flags) pass through untouched.
 */
export const writeClaudeShim = (dir: string, logFile: string) => {
  const real = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
  if (real === "") throw new Error("claude is not on PATH");
  fs.mkdirSync(dir, { recursive: true });
  const script = `#!/bin/sh
# Bench pin: print-mode claude runs ${MODEL} at effort ${EFFORT}; the caller's own choice is logged.
real='${real}'
case " $* " in *" -p "*|*" --print "*) ;; *) exec "$real" "$@" ;; esac
model=-; effort=-; n=$#
while [ "$n" -gt 0 ]; do
  a=$1; shift; n=$((n - 1))
  case $a in
    --model) model=$1; shift; n=$((n - 1)); continue ;;
    --model=*) model=\${a#--model=}; continue ;;
    --effort) effort=$1; shift; n=$((n - 1)); continue ;;
    --effort=*) effort=\${a#--effort=}; continue ;;
    --fallback-model) shift; n=$((n - 1)); continue ;;
    --fallback-model=*) continue ;;
  esac
  set -- "$@" "$a"
done
printf '%s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$model" "$effort" >> '${logFile}'
exec "$real" --model ${MODEL} --effort ${EFFORT} "$@"
`;
  fs.writeFileSync(path.join(dir, "claude"), script, { mode: 0o755 });
};
