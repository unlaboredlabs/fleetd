// Finish-all: the project's finish-all lead inventories open work (`fleetd inventory`) and starts a child workstream
// per item with a value source (`fleetd workstream spawn`), at most the policy's `finishAll.maxChildren` open at once.
// When it has no open child and nothing it could start, its workstream goes idle: that is the finish line.
import crypto from "node:crypto";
import type { PlaybookName, PlaybookRef, ProjectRef, Workstream, WorkstreamId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ClaimRecords from "../checks/ClaimRecords.ts";
import { GitHub } from "../checks/GitHub.ts";
import { NodeCommands } from "../checks/NodeCommands.ts";
import { Policies } from "../leases/Policy.ts";
import { describeCheck, oneLine } from "../leads/digest.ts";
import { LeadError } from "../leads/LeadError.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as Workstreams from "../leads/Workstreams.ts";
import { Asks } from "../ledger/Asks.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import {
  DEFAULT_MAX_CHILDREN,
  FINISH_ALL_IDLE,
  githubRepoOf,
  type InventoryInput,
  type InventoryItem,
  isFinishAll,
  isSpawnable,
  renderInventory,
  shouldIdle,
  spawnRefusal,
  TODO_GREP,
  todoCount,
} from "./finishAllRules.ts";

export interface Caller {
  readonly projectRef: ProjectRef;
  readonly by: string;
}

export class FinishAll extends Context.Service<
  FinishAll,
  {
    /** `fleetd workstream spawn`: a child of the project's open finish-all workstream, for one value source. */
    readonly spawn: (
      caller: Caller,
      input: { readonly text: string; readonly serves: string; readonly template?: PlaybookName },
    ) => Effect.Effect<{ readonly workstreamId: WorkstreamId; readonly parent: WorkstreamId; readonly playbook?: PlaybookRef; readonly next?: string }, LeadError>;
    /** `fleetd inventory`: the ranked list, and the idle rule applied to the project's finish-all workstream. */
    readonly inventory: (caller: Caller) => Effect.Effect<{ readonly text: string; readonly spawnable: number; readonly idle: boolean }, LeadError>;
  }
>()("fleetd/playbooks/FinishAll") {}

const Issues = Schema.Array(
  Schema.Struct({ number: Schema.Int, title: Schema.String, html_url: Schema.String, pull_request: Schema.optionalKey(Schema.Unknown) }),
);
const decodeIssues = Schema.decodeUnknownOption(Issues);
const ISSUES_LIMIT = 50;

export const make = Effect.gen(function* () {
  const records = yield* LeadRecords.LeadRecords;
  const workstreams = yield* Workstreams.Workstreams;
  const claims = yield* ClaimRecords.ClaimRecords;
  const asks = yield* Asks;
  const policies = yield* Policies;
  const github = yield* GitHub;
  const commands = yield* NodeCommands;
  const store = yield* HubStore.HubStore;
  const events = yield* EventLog.EventLog;

  const openIn = (ref: ProjectRef) => records.workstreams.list({ ref, open: true, limit: 200 });
  const childrenOf = (open: ReadonlyArray<Workstream>, parent: Workstream) => open.filter((w) => w.parent?.workstreamId === parent.workstreamId);
  const maxChildren = (ref: ProjectRef) => Effect.map(policies.get(ref), (p) => p.finishAll?.maxChildren ?? DEFAULT_MAX_CHILDREN);

  const setState = (w: Workstream, state: Workstream["state"], why: string) =>
    Effect.gen(function* () {
      const stored = yield* records.workstreams.get(w.workstreamId);
      if (stored === undefined || stored.workstream.state === state) return;
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* records.workstreams.put({ ...stored, workstream: { ...stored.workstream, state, updatedAt: at } });
      yield* events.append({
        at,
        type: "workstream.state",
        machineId: w.projectRef.machineId,
        projectId: w.projectRef.projectId,
        summary: `${w.workstreamId} is ${state}: ${why}`,
        data: { workstreamId: w.workstreamId, state },
      });
    });

  /** An idle finish-all with work again goes back to where it was before. */
  const reopen = (parent: Workstream, why: string) => (parent.state === "idle" ? setState(parent, parent.brief === undefined ? "draft" : "running", why) : Effect.void);

  const spawn: FinishAll["Service"]["spawn"] = (caller, input) =>
    Effect.gen(function* () {
      const ref = caller.projectRef;
      const open = yield* openIn(ref);
      const parent = open.find(isFinishAll);
      if (parent === undefined) {
        return yield* new LeadError({
          code: "invalid",
          message: "Your project has no open finish-all workstream; only one spawns child workstreams.",
          fix: "Work on the intents you have. A finish-all run starts from an intent like 'finish: everything open'.",
        });
      }
      if (input.template === "finish-all") {
        return yield* new LeadError({ code: "invalid", message: "A child of a finish-all workstream cannot be another finish-all.", fix: "Pass --template bugfix, feature or research." });
      }
      const refusal = spawnRefusal(input.serves, parent, childrenOf(open, parent), yield* maxChildren(ref));
      if (refusal !== undefined) return yield* new LeadError({ code: "invalid", message: refusal.message, fix: refusal.fix });
      const template = input.template ?? (input.serves.startsWith("defect:") ? "bugfix" : "feature");
      const created = yield* workstreams.intake({
        ref,
        text: input.text,
        clientRequestId: crypto.randomUUID(),
        channel: "lead",
        by: caller.by,
        template,
        parent: { workstreamId: parent.workstreamId, serves: input.serves },
      });
      yield* reopen(parent, `child ${created.workstreamId} serves ${input.serves}`);
      return {
        workstreamId: created.workstreamId,
        parent: parent.workstreamId,
        ...(created.playbook === undefined ? {} : { playbook: created.playbook }),
        next: `${created.workstreamId} (${template}) serves ${input.serves} for ${parent.workstreamId}; register its brief when its intent wake arrives.`,
      };
    });

  /** Failing done-when checks from each workstream's latest claim; open workstreams other than the parent own theirs. */
  const failingChecks = (ref: ProjectRef, open: ReadonlyArray<Workstream>, parent: Workstream | undefined, servedBy: (serves: string) => WorkstreamId | undefined) =>
    Effect.gen(function* () {
      const closed = [
        ...(yield* records.workstreams.list({ ref, state: "failed", limit: 20 })),
        ...(yield* records.workstreams.list({ ref, state: "stopped", limit: 20 })),
      ];
      const items: Array<InventoryItem> = [];
      for (const w of [...open, ...closed]) {
        const [latest] = yield* claims.list({ workstreamId: w.workstreamId, limit: 1 });
        if (latest?.outcome !== "fail") continue;
        for (const r of latest.results.filter((r) => r.result !== "pass")) {
          const what = `${w.workstreamId} done:${r.checkIndex} (${oneLine(describeCheck(r.spec), 80)}) ${r.result} in ${latest.claimId}`;
          if (w.workstreamId === parent?.workstreamId) {
            const serves = `done:${r.checkIndex}`;
            items.push({ kind: "failing_check", text: what, serves, ...withServedBy(servedBy(serves)) });
          } else if (open.includes(w)) {
            items.push({ kind: "failing_check", text: what, serves: `defect:${w.workstreamId} done:${r.checkIndex} fails`, servedBy: w.workstreamId });
          } else {
            const serves = `defect:${w.workstreamId} done:${r.checkIndex} fails`;
            items.push({ kind: "failing_check", text: `${what}; ${w.workstreamId} is ${w.state}`, serves, ...withServedBy(servedBy(serves)) });
          }
        }
      }
      return items;
    });

  const inventory: FinishAll["Service"]["inventory"] = (caller) =>
    Effect.gen(function* () {
      const ref = caller.projectRef;
      const project = yield* store.projects.get(ref);
      if (project === undefined) return yield* new LeadError({ code: "not_found", message: `The hub has no record of project ${ref.projectId}.` });
      const open = yield* openIn(ref);
      const parent = open.find(isFinishAll);
      const children = parent === undefined ? [] : childrenOf(open, parent);
      const servedBy = (serves: string) => children.find((c) => c.parent?.serves === serves)?.workstreamId;
      const items: Array<InventoryItem> = [...(yield* failingChecks(ref, open, parent, servedBy))];
      const unread: Array<string> = [];
      const notes: Array<string> = [];
      const run = (argv: ReadonlyArray<string>) => commands.run(ref.machineId, { cwd: project.workspaceRoot, argv, timeoutSec: 60 });

      // Open issues of the checkout's GitHub repo; a checkout without one has none, which is not a read failure.
      const remote = yield* Effect.result(run(["git", "remote", "get-url", "origin"]));
      if (remote._tag === "Failure") {
        unread.push(`open issues: ${remote.failure.message}`);
      } else {
        const repo = remote.success.exitCode === 0 ? githubRepoOf(remote.success.outputTail) : undefined;
        if (repo === undefined) {
          notes.push("No open issues to read: the checkout's origin is not a GitHub repository.");
        } else {
          const listed = yield* Effect.result(github.api(`repos/${repo}/issues?state=open&per_page=${ISSUES_LIMIT}&sort=created&direction=asc`));
          const issues = listed._tag === "Success" ? decodeIssues(listed.success) : undefined;
          if (listed._tag === "Failure") unread.push(`open issues of ${repo}: ${listed.failure.message}`);
          else if (issues?._tag !== "Some") unread.push(`open issues of ${repo}: GitHub returned an unexpected shape`);
          else {
            for (const issue of issues.value.filter((i) => i.pull_request === undefined)) {
              const serves = `issue:#${issue.number}`;
              items.push({ kind: "issue", text: `${repo}#${issue.number} ${oneLine(issue.title, 120)}`, serves, ...withServedBy(servedBy(serves) ?? servedBy(`issue:${issue.html_url}`)) });
            }
            if (issues.value.length === ISSUES_LIMIT) notes.push(`Only the oldest ${ISSUES_LIMIT} open issues of ${repo} are listed.`);
          }
        }
      }

      for (const ask of yield* asks.list({ state: "open", projectRef: ref, limit: 20 })) {
        items.push({ kind: "ask", text: `${ask.askId} open ask ${ask.key}: ${oneLine(ask.text, 120)} (the human answers it)` });
      }

      const grep = yield* Effect.result(run(TODO_GREP));
      const grepText = `\`${TODO_GREP.join(" ")}\``;
      if (grep._tag === "Failure" || (grep.success.exitCode !== 0 && grep.success.exitCode !== 1)) {
        notes.push(`TODO/FIXME markers not counted: ${grep._tag === "Failure" ? grep.failure.message : oneLine(grep.success.outputTail, 200)}`);
      } else {
        const { count, atLeast } = todoCount(grep.success.exitCode === 0 ? grep.success.outputTail : "", grep.success.outputTail.length >= 1990);
        if (count > 0) items.push({ kind: "todo", text: `${atLeast ? "at least " : ""}${count} TODO/FIXME markers (${grepText}): file an issue for one worth doing` });
        else notes.push(`No TODO/FIXME markers (${grepText}).`);
      }

      const input: InventoryInput = {
        project: `${project.title} (${ref.machineId}/${ref.projectId})`,
        ...(parent === undefined ? {} : { parent: { workstreamId: parent.workstreamId, openChildren: children.length, maxChildren: yield* maxChildren(ref) } }),
        items,
        unread,
      };
      const idle = shouldIdle(input);
      const spawnable = items.filter(isSpawnable).length;
      if (parent !== undefined && idle) yield* setState(parent, "idle", FINISH_ALL_IDLE);
      if (parent !== undefined && spawnable > 0) yield* reopen(parent, `${spawnable} item${spawnable === 1 ? "" : "s"} with a value source`);
      return { text: [renderInventory(input), ...notes].join("\n"), spawnable, idle };
    });

  return FinishAll.of({ spawn, inventory });
});

const withServedBy = (servedBy: WorkstreamId | undefined) => (servedBy === undefined ? {} : { servedBy });

/** Needs LeadRecords, Workstreams, ClaimRecords, Asks, Policies, GitHub, NodeCommands, HubStore and EventLog. */
export const layer = Layer.effect(FinishAll, make);
