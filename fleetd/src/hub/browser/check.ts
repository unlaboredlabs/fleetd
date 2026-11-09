// The node's browser lead calls checked against the contract before any handler runs, as the Rust hub decodes them
// (`BrowserRecordingPartCall`, `BrowserTakeoverCall`):
// a session id is `^B[0-9a-f]{32}$` (it names a folder under `<home>/browser`), a file one of the recording's own,
// and each enum one of its values. A call that doesn't decode is `invalid`, and nothing of it reaches the disk.
import { ToolError } from "../../shared/errors.ts";
import {
  RECORDING_FILES,
  type BrowserRecordingPartCall,
  type BrowserSessionCall,
  type BrowserTakeoverCall,
  type RecordingFileName,
} from "../../shared/screens_wire.ts";

const SESSION_ID = /^B[0-9a-f]{32}$/;
const STATES = new Set(["live", "uploading", "recorded", "lost", "expired"]);
const CONTROLS = new Set(["agent", "human", "handing_back"]);
const KINDS = new Set(["browser", "android", "ios", "linux_desktop", "mac"]);

export const isSessionId = (id: unknown): id is string => typeof id === "string" && SESSION_ID.test(id);
export const isRecordingFile = (file: unknown): file is RecordingFileName =>
  typeof file === "string" && Object.hasOwn(RECORDING_FILES, file);

const invalid = (field: string, expected: string, got: unknown) =>
  new ToolError("invalid", `${field}: expected ${expected}, got ${JSON.stringify(got) ?? String(got)}.`);

function sessionId(call: Record<string, unknown>): string {
  if (!isSessionId(call.sessionId)) throw invalid("sessionId", "a string matching ^B[0-9a-f]{32}$", call.sessionId);
  return call.sessionId;
}

function text(call: Record<string, unknown>, field: string, min: number, max: number, optional = false): void {
  const v = call[field];
  if (v === undefined && optional) return;
  if (typeof v !== "string" || [...v].length < min || [...v].length > max) {
    throw invalid(field, `a string of ${min} to ${max} characters`, v);
  }
}

function count(call: Record<string, unknown>, field: string, optional = false): void {
  const v = call[field];
  if (v === undefined && optional) return;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw invalid(field, "a count (a whole number from 0)", v);
}

function oneOf(call: Record<string, unknown>, field: string, values: Set<string>, optional = false): void {
  const v = call[field];
  if (v === undefined && optional) return;
  if (typeof v !== "string" || !values.has(v)) throw invalid(field, `one of ${[...values].join(", ")}`, v);
}

/** A `browser_session` report as the contract has it. */
export function sessionCall(call: Record<string, unknown>): BrowserSessionCall {
  sessionId(call);
  oneOf(call, "kind", KINDS, true);
  text(call, "threadId", 1, Number.MAX_SAFE_INTEGER);
  text(call, "purpose", 1, 200);
  oneOf(call, "state", STATES);
  oneOf(call, "control", CONTROLS, true);
  text(call, "startedAt", 1, 64);
  text(call, "endedAt", 1, 64, true);
  count(call, "credentialsFilled", true);
  text(call, "note", 0, 500, true);
  if (call.files !== undefined) {
    if (!Array.isArray(call.files) || call.files.length > 3) throw invalid("files", "a list of at most 3 recording files", call.files);
    for (const [i, entry] of call.files.entries()) {
      const e = entry as Record<string, unknown>;
      if (typeof e !== "object" || e === null || !isRecordingFile(e.file)) {
        throw invalid(`files[${i}].file`, `one of ${Object.keys(RECORDING_FILES).join(", ")}`, e?.file);
      }
      count(e, "bytes");
    }
  }
  return call as unknown as BrowserSessionCall;
}

/** A `browser_recording_part` as the contract has it. */
export function partCall(call: Record<string, unknown>): BrowserRecordingPartCall {
  sessionId(call);
  if (!isRecordingFile(call.file)) throw invalid("file", `one of ${Object.keys(RECORDING_FILES).join(", ")}`, call.file);
  count(call, "offset");
  text(call, "dataB64", 1, Number.MAX_SAFE_INTEGER);
  return call as unknown as BrowserRecordingPartCall;
}

/** A `browser_takeover` as the contract has it. */
export function takeoverCall(call: Record<string, unknown>): BrowserTakeoverCall {
  sessionId(call);
  text(call, "reason", 1, 500);
  return call as unknown as BrowserTakeoverCall;
}
