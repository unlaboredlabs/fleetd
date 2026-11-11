// The session calls the node answers outside its sessions: MCP
// servers' secrets and their Test, Claude accounts and the hub's model list, 1Password tokens, their Test and cards,
// a Navi's sign-ins, repo clones and `gh repo list`, the landed log, a checkout's skills and an agent's images. The
// session service hands each here (sessions/index.ts); a refusal is a CallRefusal.
import type { SessionCall, SessionOutput } from "../../shared/sessions.ts";
import type { NodeBoxKey } from "../identity.ts";
import { Masker } from "../mask.ts";
import { inspect } from "../repos/index.ts";
import { readConfig } from "../config.ts";
import { adopt } from "../secrets/adopt.ts";
import { projectSecrets, projectVars } from "../secrets/env.ts";
import { seal } from "../../shared/sealed_box.ts";
import type { VaultImportCandidate, VaultImportError } from "../../shared/contracts.ts";
import type { VaultImportRead } from "../../shared/sessions.ts";
import { homeDir, type Env } from "../util.ts";
import type { NodeFrame } from "../wire.ts";
import { applyAccount, BASE_URL_ENV, endpointSilent, envFor, hubModels, putOn, tryAccount } from "./accounts.ts";
import { ghRepoList, repoClone } from "./clone.ts";
import { readImage } from "./image.ts";
import { landedLog } from "./landed.ts";
import { applySecrets, MissingSecrets, resolve } from "./mcp.ts";
import { probe } from "./mcp_probe.ts";
import { applyToken, importedFields, importKind, OnePassword, readToken, TOKEN_ENV } from "./onepassword.ts";
import { CallRefusal, invalid, notFound } from "./refusal.ts";
import { forgetSignins } from "./signins.ts";
import { repoSkills } from "./skills.ts";

/** What these calls need of the node: its home and box key, its claude, and the session service's lookups. */
export type CallContext = {
  home: string;
  boxKey?: NodeBoxKey;
  claudeBin: string;
  /** The project's folder; throws not_found for a project this machine doesn't have. */
  projectRoot(projectId: string): string;
  /** The working directory this node started a session in. */
  sessionCwd(sessionId: string): string | undefined;
  /** What every claude the node starts gets. */
  runnerEnv(): Env;
  /** A frame on the link that is up, if any. */
  send(frame: NodeFrame): void;
  /** Forgets a project's sign-ins: its browser ends, then its kept profile goes (sessions' `forgetSignins`). */
  forgetSignins?(projectId: string): Promise<void>;
};

export const OPS = [
  "mcp_secrets",
  "mcp_test",
  "navi_signins_forget",
  "claude_account_secret",
  "claude_account_reseal",
  "claude_account_test",
  "onepassword_token",
  "onepassword_test",
  "onepassword_cards",
  "claude_models",
  "repo_clone",
  "gh_repo_list",
  "landed_log",
  "skills_list",
  "read_image",
  "vault_adopt",
  "vault_import_search",
  "vault_import_read",
] as const;
export type CallOp = (typeof OPS)[number];
export const handles = (op: string): op is CallOp => (OPS as readonly string[]).includes(op);

/** A website's host, as the vault keeps sites: `https://shop.example.com/login` is `shop.example.com`. */
const siteHost = (url: string) => {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
};

const NO_TOKEN = "this machine holds no 1Password token of yours: save it again while it is online";

/** Any failure as an `invalid` refusal, as the Rust node's `map_err(invalid)`. */
function asInvalid<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CallRefusal) throw error;
    throw invalid((error as Error).message);
  }
}

/** The 1Password helper's answer with the token masked out of any error: the helper may echo what it was given. */
async function withToken<T>(home: string, token: string, ask: (op: OnePassword) => Promise<T>): Promise<{ ok: T } | { error: string }> {
  const helper = new OnePassword(home, token);
  try {
    return { ok: await ask(helper) };
  } catch (error) {
    return { error: new Masker([[TOKEN_ENV, token]]).text((error as Error).message) };
  } finally {
    helper.close();
  }
}

/** The project's own secret OP_SERVICE_ACCOUNT_TOKEN, which wins over the person's, as it does for fills. */
function projectToken(home: string, projectId: string): string | undefined {
  const secrets = new Set(projectSecrets(home, projectId));
  return projectVars(home, projectId).find(([name, value]) => name === TOKEN_ENV && secrets.has(value))?.[1];
}

export async function nodeCall(ctx: CallContext, call: Extract<SessionCall, { op: CallOp }>): Promise<SessionOutput> {
  const home = ctx.home;
  switch (call.op) {
    case "mcp_secrets": {
      if (call.scope.kind === "project") ctx.projectRoot(call.scope.projectId);
      const { scope, server } = call;
      return { kind: "mcp_secrets", secrets: asInvalid(() => applySecrets(home, scope, server, call.set ?? [], call.keep ?? [], ctx.boxKey)) };
    }
    case "mcp_test": {
      const env = ctx.runnerEnv();
      let cwd = homeDir();
      if (call.projectId) {
        cwd = ctx.projectRoot(call.projectId);
        for (const [k, v] of projectVars(home, call.projectId)) if (!(k in env) && k !== TOKEN_ENV) env[k] = v;
      }
      try {
        return { kind: "mcp_tested", ...(await probe(resolve(home, call.server), cwd, env)) };
      } catch (error) {
        if (!(error instanceof MissingSecrets)) throw error;
        return { kind: "mcp_tested", tools: [], error: `this machine doesn't hold its ${error.message}: save the server again` };
      }
    }
    case "navi_signins_forget":
      ctx.projectRoot(call.projectId);
      if (ctx.forgetSignins) await ctx.forgetSignins(call.projectId);
      else asInvalid(() => forgetSignins(home, call.projectId));
      return { kind: "done" };
    case "claude_account_secret": {
      const fingerprint = asInvalid(() => applyAccount(home, call.account, call.set, ctx.boxKey));
      return { kind: "claude_account_saved", ...(fingerprint ? { fingerprint } : {}) };
    }
    case "claude_account_test": {
      const env = ctx.runnerEnv();
      let account: ReturnType<typeof envFor>;
      try {
        account = envFor(home, call.account);
      } catch (error) {
        return { kind: "claude_account_tested", ok: false, error: (error as Error).message };
      }
      putOn(env, account.vars);
      const endpoint = account.vars.find(([k]) => k === BASE_URL_ENV)?.[1];
      const silent = endpoint === undefined ? undefined : await endpointSilent(endpoint);
      if (silent !== undefined) return { kind: "claude_account_tested", ok: false, error: new Masker(account.secrets).text(silent) };
      try {
        await tryAccount(ctx.claudeBin, env);
        return { kind: "claude_account_tested", ok: true };
      } catch (error) {
        // claude may echo what it was given: the value never leaves the machine.
        return { kind: "claude_account_tested", ok: false, error: new Masker(account.secrets).text((error as Error).message) };
      }
    }
    case "onepassword_token": {
      const fingerprint = asInvalid(() => applyToken(home, call.personId, call.sealed, ctx.boxKey));
      return { kind: "onepassword_saved", ...(fingerprint ? { fingerprint } : {}) };
    }
    case "onepassword_test": {
      let token: string | undefined;
      try {
        token = readToken(home, call.personId);
      } catch (error) {
        return { kind: "onepassword_tested", vaults: [], error: (error as Error).message };
      }
      if (token === undefined) return { kind: "onepassword_tested", vaults: [], error: NO_TOKEN };
      const said = await withToken(home, token, (op) => op.vaultNames());
      return "ok" in said ? { kind: "onepassword_tested", vaults: said.ok } : { kind: "onepassword_tested", vaults: [], error: said.error };
    }
    case "onepassword_cards": {
      let token: string | undefined;
      try {
        token = (call.projectId && projectToken(home, call.projectId)) || readToken(home, call.personId);
      } catch (error) {
        return { kind: "onepassword_carded", cards: [], error: (error as Error).message };
      }
      if (token === undefined) return { kind: "onepassword_carded", cards: [], error: NO_TOKEN };
      const said = await withToken(home, token, (op) => op.cards());
      return "ok" in said ? { kind: "onepassword_carded", cards: said.ok } : { kind: "onepassword_carded", cards: [], error: said.error };
    }
    case "vault_adopt": {
      let roots: string[];
      try {
        roots = readConfig(home)?.cmdRoots ?? [homeDir()];
      } catch {
        roots = [homeDir()];
      }
      const held = asInvalid(() => adopt({ home, roots, machineId: "" }, call.to));
      return { kind: "vault_adopted", ...held };
    }
    case "vault_import_search": {
      let token: string | undefined;
      try {
        token = readToken(home, call.personId);
      } catch (error) {
        return { kind: "vault_import_found", items: [], error: (error as Error).message };
      }
      if (token === undefined) return { kind: "vault_import_found", items: [], error: NO_TOKEN };
      const said = await withToken(home, token, (op) => op.search(call.query));
      if (!("ok" in said)) return { kind: "vault_import_found", items: [], error: said.error };
      const items: VaultImportCandidate[] = [];
      for (const found of said.ok) {
        const kind = importKind(found.category);
        if (!kind || (call.kinds && !call.kinds.includes(kind))) continue;
        const sites = [...new Set((found.sites ?? []).map(siteHost).filter((h): h is string => h !== undefined))];
        items.push({ ref: found.ref, title: found.title, kind, vault: found.vault, ...(sites.length ? { sites } : {}) });
      }
      return { kind: "vault_import_found", items };
    }
    case "vault_import_read": {
      const to = Buffer.from(call.to, "base64");
      if (to.length !== 32) throw invalid("the hub's box key is not 32 bytes");
      const refs = [...new Set(call.refs)];
      let token: string | undefined;
      try {
        token = readToken(home, call.personId);
      } catch (error) {
        return { kind: "vault_import_read", items: [], errors: refs.map((ref) => ({ ref, message: (error as Error).message })) };
      }
      if (token === undefined) return { kind: "vault_import_read", items: [], errors: refs.map((ref) => ({ ref, message: NO_TOKEN })) };
      const items: VaultImportRead[] = [];
      const errors: VaultImportError[] = [];
      const helper = new OnePassword(home, token);
      const masked = new Masker([[TOKEN_ENV, token]]);
      try {
        for (const ref of refs) {
          try {
            const read = await helper.read(ref);
            const kind = importKind(read.category);
            if (!kind) throw new Error(`${read.title} is not a login, card or identity item`);
            // Sealed to the hub at once: the fields are never kept, logged or sent in the clear.
            const plain = Buffer.from(JSON.stringify(importedFields(read)), "utf8");
            try {
              items.push({ ref, kind, sealed: Buffer.from(seal(to, plain)).toString("base64") });
            } finally {
              plain.fill(0);
            }
          } catch (error) {
            errors.push({ ref, message: masked.text((error as Error).message).slice(0, 500) });
          }
        }
      } finally {
        helper.close();
      }
      return { kind: "vault_import_read", items, errors };
    }
    case "claude_models":
      try {
        return { kind: "claude_models", models: await hubModels(home) };
      } catch (error) {
        return { kind: "claude_models", models: [], error: (error as Error).message };
      }
    case "repo_clone":
      await repoClone(call.addId, call.url, call.dest, (p) => ctx.send({ t: "clone_progress", ...p }));
      return { kind: "repo_facts", ...(await inspect(call.dest)) };
    case "gh_repo_list":
      return { kind: "gh_repos", ...(await ghRepoList()) };
    case "landed_log":
      return { kind: "landed_log", ...(await landedLog(ctx.projectRoot(call.projectId), call.branch, call.sinceMs, call.stopAt)) };
    case "skills_list":
      return { kind: "skills", skills: repoSkills(ctx.projectRoot(call.projectId)) };
    case "read_image": {
      // The session's own working directory, as this node started it: never one the call names.
      const root = ctx.sessionCwd(call.sessionId);
      if (!root) throw notFound(`no session ${call.sessionId} on this machine`);
      const image = asInvalid(() => readImage(root, call.path, call.offset ?? 0, !!call.file));
      return { kind: "image", name: image.name, mime: image.mime, bytes: image.bytes, dataB64: image.piece.toString("base64") };
    }
  }
}
