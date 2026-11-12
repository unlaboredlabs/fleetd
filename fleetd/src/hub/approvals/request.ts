// A person's request as the store keeps it, without the database (store.ts numbers and stores them): what a new one
// holds, a list's filter, its row's key order, the kind rule a reader holds it to, and the words for one already settled.
import type {
  GatedRunSpec,
  HumanRequest,
  ProjectRef,
  Purchase,
  RequestKind,
  RequestState,
  SecretRequest,
  SecureInput,
  ToolPermission,
} from "../../shared/contracts.ts";

/** What a new request holds; the store numbers it and opens it. */
export type NewRequest = {
  projectRef: ProjectRef;
  workstreamId?: string;
  kind: RequestKind;
  text: string;
  secret?: SecretRequest;
  gated?: GatedRunSpec;
  permission?: ToolPermission;
  purchase?: Purchase;
  secureInput?: SecureInput;
  at: string;
  atMs: number;
};

export type RequestFilter = {
  projectRef?: ProjectRef;
  states?: RequestState[];
  kind?: RequestKind;
  limit: number;
};

/** What a request already came to, for a change that finds it settled: "Q1 is already approved", "Q1 already ran". */
export function settled(id: string, state: RequestState): string {
  if (state === "ran") return `${id} already ran`;
  if (state === "failed") return `${id} already ran, and failed`;
  return `${id} is already ${state}`;
}

/** Why a write was refused. */
export class RequestStoreError extends Error {
  constructor(
    readonly kind: "not_found" | "invalid" | "moved",
    readonly id: string,
    message: string,
    /** `moved`: the state someone else moved it to first. */
    readonly now?: RequestState,
  ) {
    super(message);
    this.name = "RequestStoreError";
  }
}

export const projectKey = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

export function nOf(id: string): number | undefined {
  const m = /^Q([1-9][0-9]*)$/.exec(id);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

export const KEYS: (keyof HumanRequest)[] = [
  "requestId",
  "projectRef",
  "workstreamId",
  "kind",
  "text",
  "state",
  "secret",
  "gated",
  "permission",
  "purchase",
  "secureInput",
  "evidence",
  "exitCode",
  "outputTail",
  "createdAt",
  "answeredAt",
  "answeredBy",
  "answeredByPerson",
  "finishedAt",
];

/** The request as the Rust hub stores it: its struct's key order, absent fields left out. */
export function canonical(r: HumanRequest): HumanRequest {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
  return out as HumanRequest;
}

export const SECRET_STATES: RequestState[] = ["open", "stored", "withdrawn"];
export const APPROVAL_STATES: RequestState[] = ["open", "approved", "denied", "ran", "failed"];

/** The contracts' `request_kind_rule`: why `r` is no request a reader accepts, or undefined. */
export function kindRule(r: HumanRequest): string | undefined {
  if (!/^Q[1-9][0-9]*$/.test(r.requestId)) return `${r.requestId} is not a request id`;
  if (typeof r.text !== "string" || [...r.text].length < 1 || [...r.text].length > 500) return "text must be 1 to 500 characters";
  if (r.kind === "secret") {
    if (!r.secret || r.gated || r.permission || r.purchase) return "a secret request has a secret and nothing else";
    if (r.secret.sink.startsWith("fill:") !== (r.secureInput !== undefined)) {
      return "a secret request has a secure input exactly when its sink is fill:";
    }
    if (r.secret.envName !== undefined && !r.secret.sink.startsWith("env:") && !r.secret.sink.startsWith("order:")) {
      return "only an env: or order: sink has an env name";
    }
  } else if (r.kind === "approval") {
    const held = [r.gated, r.permission, r.purchase, r.secureInput].filter((h) => h !== undefined).length;
    if (r.secret || held !== 1) {
      return "an approval has exactly one of a gated run, a tool prompt, a purchase and a secure input";
    }
  } else {
    return `unknown kind ${String(r.kind)}`;
  }
  const allowed = r.kind === "secret" ? SECRET_STATES : APPROVAL_STATES;
  if (!allowed.includes(r.state)) return `a ${r.kind === "secret" ? "Secret" : "Approval"} request is never ${r.state}`;
  return undefined;
}

export const kindText = (kind: RequestKind) => (kind === "secret" ? "secret" : "approval");
