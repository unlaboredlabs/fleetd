// `node_action` frames from the hub (crates/fleetd/src/node/actions.rs): the doctor's probe of the commit identity,
// the hold ahead of an update, and the rest. Each always answers, in plain words. Self-update, Claude Code's install
// and login, and screen settings are the Rust binary's own release machinery: the Bun node answers them as not done
// (`ok: false`, nothing changed), and lists none of their capabilities, so a hub sends them only by mistake.
import { exec, headUtf16 } from "../util.ts";
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
      const steps = hooks.hold?.() ?? 0;
      return answer(frame.id, true, `holding; ${steps} mid-step`, { steps });
    }
    case "update":
    case "fetch":
      return answer(frame.id, false, "this machine runs the Bun node, which doesn't update itself: update it by hand", {
        stage: frame.action === "fetch" ? "download" : "install",
      });
    case "claude":
      return answer(frame.id, false, "the Bun node doesn't install Claude Code: run `claude install` on the machine", {
        stage: "install",
      });
    case "claude_login":
    case "claude_login_code":
      return answer(frame.id, false, "the Bun node doesn't log Claude Code in: run `claude auth login` on the machine");
    case "screens":
      return answer(frame.id, false, "the Bun node keeps its screen settings in node.json: edit them there");
    default:
      return answer(frame.id, false, `this node doesn't know the action ${String((frame as NodeAction).action)}`);
  }
}
