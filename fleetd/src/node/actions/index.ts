// `node_action` frames from the hub: the doctor's probe of the commit identity,
// the hold ahead of an update, Claude Code's install and its login from the app. Each always answers, in plain words.
// Screen settings are the screens' areas' (node/browser and the rest) and answer as not done until they take them.
import { exec, headUtf16, type Env } from "../util.ts";
import { PROTOCOL as HOST_PROTOCOL } from "../runner/host.ts";
import { ALREADY, bringTo, type Claude } from "../runner/install.ts";
import type { Logins } from "../runner/login.ts";
import type { NodeAction, NodeActionResult } from "../wire.ts";

/** `git config --global user.email`, absent when unset or git is missing. */
async function gitConfigEmail(): Promise<string | undefined> {
  const out = await exec(["git", "config", "--global", "user.email"], 10_000);
  const email = out.stdout.trim();
  return out.error === undefined && email ? headUtf16(email, 320) : undefined;
}

/** The email commits made here carry: the node unit's GIT_AUTHOR_* / GIT_COMMITTER_* win over git's global config. */
export async function probeHost(): Promise<NonNullable<NodeActionResult["probe"]>> {
  const fromEnv = (process.env.GIT_AUTHOR_EMAIL ?? process.env.GIT_COMMITTER_EMAIL)?.trim();
  if (fromEnv) return { gitEmail: headUtf16(fromEnv, 320), gitEmailFrom: "env" };
  const email = await gitConfigEmail();
  return email ? { gitEmail: email, gitEmailFrom: "git_config" } : {};
}

export type ActionHooks = {
  /** Holds every agent's tool call that hasn't started yet; how many sessions are still mid-step. */
  hold?: () => number;
  /** How many sessions that aren't hosted are mid-step, holding none (`hold` with `unhosted`). */
  unhostedMidStep?: () => number;
  /** Whether this machine's session hosts start in systemd scopes of their own, which outlive the node (scope.ts). */
  scoped?: () => Promise<boolean>;
  /** The machine's Claude Code, and its login, with the runner's environment. */
  claude?: { installer: Claude; binary: string; env: () => Env; logins: Logins; reprobe: () => Promise<{ login: string }> };
  /** A self-update: install `update` and restart (node/update). */
  update?: (frame: NodeAction) => Promise<NodeActionResult>;
};

const answer = (id: string, ok: boolean, message: string, extra: Partial<NodeActionResult> = {}): NodeActionResult => ({
  id,
  ok,
  message: headUtf16(message, 500),
  ...extra,
});

export async function runNodeAction(frame: NodeAction, hooks: ActionHooks): Promise<NodeActionResult> {
  switch (frame.action) {
    case "probe":
      return answer(frame.id, true, "probed", { probe: await probeHost() });
    case "hold": {
      // Hosts outlive the node only in scopes of their own: without one a host shares the node's cgroup.
      const scoped = frame.unhosted === true && (await hooks.scoped?.()) === true;
      if (scoped) {
        const steps = hooks.unhostedMidStep?.() ?? 0;
        return answer(frame.id, true, `hosted agents carry on; ${steps} not hosted mid-step`, { steps, hosted: HOST_PROTOCOL });
      }
      const steps = hooks.hold?.() ?? 0;
      return answer(frame.id, true, `holding; ${steps} mid-step`, { steps });
    }
    case "update":
    case "fetch":
      if (hooks.update) return hooks.update(frame);
      return answer(frame.id, false, "this node doesn't update itself", { stage: frame.action === "fetch" ? "download" : "install" });
    case "claude": {
      if (!frame.claude) return answer(frame.id, false, "the hub named no Claude Code version", { stage: "install" });
      if (!hooks.claude) return answer(frame.id, false, "this node doesn't install Claude Code", { stage: "install" });
      try {
        const installed = await bringTo(hooks.claude.installer, frame.claude);
        // The runner's version as the hub sees it, at once rather than at the next probe.
        if (installed.kind === "done") await hooks.claude.reprobe();
        return answer(
          frame.id,
          true,
          installed.kind === "current"
            ? `${ALREADY} ${installed.version}`
            : installed.kind === "done"
              ? `Claude Code ${installed.from} -> ${installed.to}: new sessions start on ${installed.to}, running ones finish on ${installed.from}`
              : installed.said,
        );
      } catch (error) {
        return answer(frame.id, false, (error as Error).message, { stage: "install" });
      }
    }
    case "claude_login": {
      if (!hooks.claude) return answer(frame.id, false, "this node doesn't log Claude Code in");
      try {
        const url = await hooks.claude.logins.start(hooks.claude.binary, hooks.claude.env());
        return answer(frame.id, true, "sign in at the URL, then give the code it shows", { login_url: headUtf16(url, 4000) });
      } catch (error) {
        return answer(frame.id, false, (error as Error).message);
      }
    }
    case "claude_login_code": {
      if (!frame.code) return answer(frame.id, false, "the hub sent no code");
      if (!hooks.claude) return answer(frame.id, false, "this node doesn't log Claude Code in");
      try {
        const said = await hooks.claude.logins.finish(frame.code);
        // Logged in as the hub sees it, at once: the login is the probe's to judge.
        const info = await hooks.claude.reprobe();
        if (info.login === "logged_out") return answer(frame.id, false, `${said}; but claude still reports no login`);
        return answer(frame.id, true, said);
      } catch (error) {
        return answer(frame.id, false, (error as Error).message);
      }
    }
    case "screens":
      return answer(frame.id, false, "the Bun node keeps its screen settings in node.json: edit them there");
    default:
      return answer(frame.id, false, `this node doesn't know the action ${String((frame as NodeAction).action)}`);
  }
}
