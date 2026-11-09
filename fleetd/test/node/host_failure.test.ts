// The session host's failure classification (crates/fleetd/src/node/runner/claude/failure.rs tests) and its time spans
// (spans.rs tests): recorded runs land in their class with claude's words, resets come from the structured event first
// and the texts second, and a run's spans tile its wall time.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FailureClass } from "../../src/shared/sessions.ts";
import { classify, clockResetMs, contextFullText, evidence as make, gatewayLimit, loudMessage, textLimit, timestamp, type FailureEvidence } from "../../src/node/runner/host/failure.ts";
import { decode } from "../../src/node/runner/host/protocol.ts";
import { SpanBuilder } from "../../src/node/runner/host/spans.ts";

/** 2026-10-18T10:00:00Z, before every reset in the fixtures. */
const NOW = 1_792_317_600_000;
const MIN = 60_000;
const iso = timestamp;
const retryable = (c: FailureClass) => c === "overloaded" || c === "network";

/** The evidence a runner collects from one recorded run, as the mapper does: the synthetic assistant error, the
 * session's latest rate_limit_event, the result (or the exit without one), and stderr. */
function evidence(fixture: string): FailureEvidence {
  const file = fixture.endsWith(".jsonl") ? fixture : `claude-2.1.302-${fixture}.jsonl`;
  const e = make({ nowMs: NOW });
  let result = false;
  let assistantText = "";
  let exit: FailureEvidence["exit"];
  for (const raw of readFileSync(join(import.meta.dir, "../fixtures/runner", file), "utf8").split("\n").filter(Boolean)) {
    const rec = JSON.parse(raw);
    if (rec.dir === "stderr") e.stderr += rec.raw;
    else if (rec.dir === "meta" && rec.msg.exit !== undefined) {
      if (rec.msg.signal !== undefined && rec.msg.signal !== null && rec.msg.signal !== "SIGKILL") throw new Error(`signal ${rec.msg.signal}`);
      exit = { code: typeof rec.msg.exit === "number" ? rec.msg.exit : null, signal: rec.msg.signal === "SIGKILL" ? 9 : null, stderr_tail: "" };
    } else if (rec.dir === "out") {
      const line = decode(rec.msg)!;
      if (line.type === "assistant" && line.error !== undefined) {
        e.assistantError = line.error;
        e.apiErrorStatus = line.api_error_status;
        for (const b of line.message.content) if (b.type === "text") assistantText += b.text;
      } else if (line.type === "rate_limit_event") {
        const i = line.rate_limit_info;
        e.rateLimit = { status: i.status, resets_at: i.resetsAt ?? null, limit_type: i.rateLimitType ?? null, utilization: i.utilization ?? null };
      } else if (line.type === "result") {
        result = true;
        e.isError = line.is_error;
        e.text = line.result ?? "";
        e.terminalReason = line.terminal_reason;
        e.startupFailureReason = line.startup_failure_reason;
        e.apiErrorStatus = line.api_error_status ?? e.apiErrorStatus;
      }
    }
  }
  if (!e.text) e.text = assistantText;
  if (!result) e.exit = exit;
  return e;
}

const classOf = (fixture: string) => classify(evidence(fixture))?.class;

test("clean and interrupted runs are not failures", () => {
  for (const fixture of ["init-partial-two-turns", "resume", "resume-after-kill", "permission-allow", "permission-deny", "allowlisted-tool", "compact-manual", "interrupt-mid-tool"])
    expect(classOf(fixture), fixture).toBeUndefined();
});

test("a usage limit from the rate limit event resets at its resetsAt", () => {
  const f = classify(evidence("usage-limit-subscription.documented"))!;
  expect(f.class).toBe("usage_limit");
  // resetsAt (15:00) wins over the text's "resets 4pm (UTC)".
  expect(f.resetAt).toBe("2026-10-18T15:00:00.000Z");
  expect(f.apiStatus).toBe(429);
  expect(f.message).toBe("You've hit your limit · resets 4pm (UTC)");
});

test("a usage limit without the event reads the plan text or names no reset", () => {
  const e = evidence("usage-limit-subscription.documented");
  e.rateLimit = undefined;
  let f = classify(e)!;
  expect([f.class, f.resetAt]).toEqual(["usage_limit", "2026-10-18T16:00:00.000Z"]);
  // A prefix with no reset at all: none, never a made-up hour; the hub checks the login instead.
  e.text = "You're out of extra usage";
  f = classify(e)!;
  expect([f.class, f.resetAt]).toEqual(["usage_limit", undefined]);
  // An event already past is stale: the text decides.
  e.text = "You've hit your limit · resets 4pm (UTC)";
  e.rateLimit = { status: "rejected", resets_at: NOW / 1000 - 60, limit_type: "five_hour", utilization: null };
  expect(classify(e)!.resetAt).toBe("2026-10-18T16:00:00.000Z");
  // claude's blocking_limit terminal reason is a plan limit whatever the text.
  expect(classify(make({ isError: true, text: "Claude stopped.", terminalReason: "blocking_limit", nowMs: NOW }))!.class).toBe("usage_limit");
});

test("huge reset numbers saturate and cap at 31 days", () => {
  const cap = iso(NOW + 31 * 24 * 60 * MIN);
  for (const text of [
    'API Error: 429 {"error":{"code":"model_cooldown","reset_seconds":9223372036854775807}}',
    'model_cooldown "reset_seconds":99999999999999999999999',
    "rate limit (reset after 9223372036854775807h9223372036854775807m)",
    "Claude AI usage limit reached|9999999999",
  ]) {
    const limit = gatewayLimit(text, NOW) ?? textLimit(text, NOW);
    expect(iso(limit!.resetMs!), text).toBe(cap);
  }
  const e = evidence("usage-limit-subscription.documented");
  e.rateLimit!.resets_at = Number.MAX_SAFE_INTEGER;
  expect(classify(e)!.resetAt).toBe(cap);
});

test("plan text resets roll to the next day and need a zone", () => {
  const at = (text: string) => {
    const ms = clockResetMs(text, NOW);
    return ms === undefined ? undefined : iso(ms);
  };
  expect(at("resets 9am (UTC)")).toBe("2026-10-19T09:00:00.000Z");
  expect(at("resets 10:30am (UTC)")).toBe("2026-10-18T10:30:00.000Z");
  // 10:00Z is 12:00 in Berlin (CEST); 4pm there is 14:00Z.
  expect(at("· resets 4pm (Europe/Berlin)")).toBe("2026-10-18T14:00:00.000Z");
  expect(at("resets 12am (UTC)")).toBe("2026-10-19T00:00:00.000Z");
  expect(at("resets 4pm")).toBeUndefined();
  expect(at("resets 4pm (Mars/Olympus)")).toBeUndefined();
  expect(at("resets 13pm (UTC)")).toBeUndefined();
});

test("request rate limits name no reset", () => {
  for (const fixture of ["rate-limit-429", "usage-429-api-key"]) {
    const f = classify(evidence(fixture))!;
    expect(f.class, fixture).toBe("rate_limit");
    expect([f.resetAt, f.model], fixture).toEqual([undefined, undefined]);
    expect(f.message, fixture).toStartWith("API Error: Request rejected (429)");
  }
});

/** A real pause, 2026-10-25 22:40 UTC: every agent behind a CLIProxyAPI gateway failed with this one text. It names no
 * reset; it is the proxy resting its credentials after a 429, so the hub checks again from a minute on. */
test("a proxy cooldown names no reset and its model", () => {
  const e = evidence("claude-2.1.310-proxy-cooldown-429.jsonl");
  expect([e.assistantError, e.apiErrorStatus]).toEqual(["rate_limit", 429]);
  let f = classify(e)!;
  expect(f.message).toBe(
    "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down (last error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.)",
  );
  expect([f.class, f.resetAt, f.model]).toEqual(["rate_limit", undefined, "claude-opus-5-5"]);
  // Its JSON form with reset_seconds is the account's quota, and parks until then.
  e.text = 'API Error: 429 {"error":{"code":"model_cooldown","message":"All credentials for model claude-opus-5-5 are cooling down","reset_seconds":90}}';
  f = classify(e)!;
  expect([f.class, f.resetAt, f.model]).toEqual(["usage_limit", iso(NOW + 90_000), "claude-opus-5-5"]);
});

test("auth failures are auth with claude's words", () => {
  let f = classify(evidence("not-logged-in"))!;
  expect([f.class, f.message, f.resetAt]).toEqual(["auth", "Not logged in · Please run /login", undefined]);
  f = classify(evidence("auth-expired-401"))!;
  expect([f.class, f.apiStatus]).toEqual(["auth", 401]);
  expect(f.message).toContain("OAuth token has expired");
});

test("server errors are overloaded and refused connections network", () => {
  for (const [fixture, cls, status] of [
    ["overloaded-529", "overloaded", 529],
    ["server-500", "overloaded", 500],
    ["network-refused", "network", undefined],
  ] as const) {
    const f = classify(evidence(fixture))!;
    expect([f.class, f.apiStatus, f.resetAt], fixture).toEqual([cls, status, undefined]);
    expect(f.message, fixture).toStartWith("API Error: ");
    expect(retryable(f.class)).toBe(true);
  }
});

test("an unknown model is invalid and a drained gateway pool exhausted", () => {
  // claude tags the model as unknown on stderr: a bad model name, never retried or parked.
  const e = evidence("invalid-model");
  let f = classify(e)!;
  expect([f.class, f.apiStatus]).toEqual(["invalid_request", 400]);
  // It names the model, so the node falls back from a setting claude refused.
  expect(f.model).toBe("claude-does-not-exist-9");
  expect(f.message).toStartWith("API Error: 400 unknown provider for model claude-does-not-exist-9");
  expect(f.message).toContain("--- stderr tail ---\n[claude-code:unrecognized_model]");
  // The same gateway text for a model claude knows: every credential behind the gateway is gone.
  f = classify({ ...e, stderr: "" })!;
  expect([f.class, f.resetAt, f.model]).toEqual(["pool_exhausted", undefined, "claude-does-not-exist-9"]);
  f = classify(make({ isError: true, assistantError: "model_not_found", apiErrorStatus: 404, text: "There's an issue with the selected model (claude-x). It may not exist.", nowMs: NOW }))!;
  expect([f.class, f.model]).toEqual(["invalid_request", "claude-x"]);
});

/** The unrecognized-model tag on stderr (any model claude doesn't know, e.g. a gateway alias) must not mask the real
 * failure. */
test("the unrecognized model tag leaves retries and parking alone", () => {
  const tag = '[claude-code:unrecognized_model] {"model":"gw-alias","query_source":"sdk"}\n';
  const tagged = (fixture: string) => {
    const e = evidence(fixture);
    e.stderr += tag;
    return classify(e)!;
  };
  const f = tagged("overloaded-529");
  expect([f.class, f.apiStatus]).toEqual(["overloaded", 529]);
  expect(tagged("network-refused").class).toBe("network");
  const u = tagged("usage-limit-subscription.documented");
  expect([u.class, u.resetAt]).toEqual(["usage_limit", "2026-10-18T15:00:00.000Z"]);
  expect(tagged("rate-limit-429").class).toBe("rate_limit");
  expect(tagged("auth-expired-401").class).toBe("auth");
  // A cooldown or a signed-out pool behind the gateway still parks.
  const e = evidence("overloaded-529");
  e.stderr += tag;
  e.text = 'API Error: 429 {"error":{"code":"model_cooldown","reset_seconds":120}}';
  e.apiErrorStatus = 429;
  expect(classify(e)!.class).toBe("usage_limit");
  e.text = "API Error: 503 no available account for gw-alias";
  expect(classify(e)!.class).toBe("pool_exhausted");
});

/** A request refused for anything but its model, on a gateway alias claude tags on every run, names no refused model. */
test("a tagged invalid request names no refused model", () => {
  const tag = '[claude-code:unrecognized_model] {"model":"gw-alias","query_source":"sdk"}\n';
  for (const [reason, text] of [
    ["prompt_too_long", "Prompt is too long"],
    ["image_error", "API Error: 400 messages.0.content.1.image.source: image exceeds 5 MB maximum"],
  ]) {
    const f = classify(make({ isError: true, apiErrorStatus: 400, terminalReason: reason, text, stderr: tag, nowMs: NOW }))!;
    expect([f.class, f.model], reason).toEqual(["invalid_request", undefined]);
  }
});

test("a context overflow is invalid and asks for compaction", () => {
  const e = make({ isError: true, assistantError: "invalid_request", apiErrorStatus: 400, text: "Prompt is too long", terminalReason: "prompt_too_long", nowMs: NOW });
  expect(classify(e)!.class).toBe("invalid_request");
  expect(contextFullText(e.text)).toBe(true);
  expect(contextFullText(evidence("invalid-model").text)).toBe(false);
  expect(classify({ ...e, assistantError: "unknown", terminalReason: undefined, text: "API Error: 400 something new" })!.class).toBe("invalid_request");
});

test("an exit without a result is process_exited with how it ended", () => {
  let f = classify(evidence("sigkill-mid-tool"))!;
  expect([f.class, f.message]).toEqual(["process_exited", "claude was killed by SIGKILL before the run finished"]);
  f = classify(evidence("sigterm-mid-tool"))!;
  expect([f.class, f.message]).toEqual(["process_exited", "claude exited with code 143 before the run finished"]);
  // A refused start: only stderr says why.
  f = classify(evidence("session-id-in-use"))!;
  expect(f.class).toBe("process_exited");
  expect(f.message).toEndWith("is already in use.");
  expect(retryable(f.class)).toBe(false);
});

test("startup refusals split into sign-in, transient and setup", () => {
  const start = (reason: string) => classify(make({ isError: true, text: "refused", startupFailureReason: reason }))!.class;
  expect(start("gateway_signin_required")).toBe("auth");
  expect(start("org_config_refused")).toBe("auth");
  expect(start("org_config_required_unavailable")).toBe("network");
  expect(start("cwd_unavailable")).toBe("invalid_request");
  expect(start("cli_version_too_old")).toBe("invalid_request");
});

test("other errors fail loudly without retry", () => {
  const f = classify(make({ isError: true, assistantError: "billing_error", text: "Credit balance is too low" }))!;
  expect([f.class, f.message]).toEqual(["other", "Credit balance is too low"]);
});

/** The hub's limit table (gateway texts, cooldown, the CLI's epoch suffix); a text with no reset names none. */
test("the moved text rules keep their answers", () => {
  const at = NOW;
  const table: [string, unknown][] = [
    ["Claude usage limit reached. Send the message again once the limit resets.", { class: "usage_limit" }],
    ["Claude AI usage limit reached|1792483200", { class: "usage_limit", resetMs: 1_792_483_200_000 }],
    ["You've hit your 5-hour limit", { class: "usage_limit" }],
    ["Claude API rate limit reached. Try again later.", { class: "rate_limit" }],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', { class: "rate_limit" }],
    ['API Error: 503 [claude] [429]: {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}} (reset after 1h30m)', { class: "rate_limit", resetMs: at + 90 * MIN }],
    [
      'API Error: 400 {"error":{"message":"unknown provider for model claude-opus-5-5","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
      { class: "pool_exhausted", model: "claude-opus-5-5" },
    ],
    ['API Error: 503 {"error":{"message":"no auth available","code":"auth_unavailable"}}', { class: "pool_exhausted" }],
    ["API Error: 503 no available account for claude-opus-5-5", { class: "pool_exhausted" }],
    [
      'API Error: 429 {"error":{"code":"model_cooldown","message":"All credentials for model claude-opus-5-5 are cooling down","model":"claude-opus-5-5","reset_time":"1h2m0s","reset_seconds":3720}}',
      { class: "usage_limit", resetMs: at + 3_720_000, model: "claude-opus-5-5" },
    ],
    ["Claude API is overloaded (529). Try again shortly.", undefined],
    ["Claude stopped: the prompt exceeds the model's context window.", undefined],
    ["Claude API connection error.", undefined],
  ];
  for (const [text, want] of table) expect(gatewayLimit(text, at) ?? textLimit(text, at), text).toEqual(want as never);
});

test("the message keeps claude's words and the stderr tail within 4000 units", () => {
  let m = loudMessage("API Error: 529 Overloaded.", `${"x".repeat(10_000)}END`, undefined);
  expect(m).toStartWith("API Error: 529 Overloaded.\n--- stderr tail ---\nxxx");
  expect(m).toEndWith("xxxEND");
  expect(m.length).toBe(4000);
  // A huge text keeps its start and leaves room for stderr.
  m = loudMessage("é".repeat(9000), "boom", undefined);
  expect(m).toEndWith("--- stderr tail ---\nboom");
  expect(m.length).toBeLessThanOrEqual(4000);
  // Astral characters count two units and are never split.
  m = loudMessage("😀".repeat(3000), "", undefined);
  expect(m.length).toBe(4000);
  expect(m.isWellFormed()).toBe(true);
  expect(loudMessage("  ", "", undefined)).toBe("claude reported an error without any text");
});

test("overlapping tool calls share one group and every run tiles exactly", () => {
  const b = new SpanBuilder("s");
  b.runStarted("r", 1000);
  b.toolUse("a", "Bash", { command: "sleep 3" }, 1100);
  b.toolUse("b", "Read", { file_path: "/x" }, 1200);
  b.toolResult("b", "x", "ok", undefined, undefined, 1300);
  b.toolResult("a", "ok", "ok", 0, undefined, 1500);
  const spans = b.runEnded("r", "ok", [undefined, undefined], 2000);
  expect(spans.reduce((n, s) => n + (s.exclMs ?? 0), 0)).toBe(1000);
  const group = spans.find((s) => s.kind === "tools.parallel")!;
  expect([group.startMs, group.endMs, group.exclMs]).toEqual([1200, 1300, 100]);
  const bash = spans.find((s) => s.kind === "tool.bash")!;
  expect([bash.exclMs, bash.parent, bash.outBytes]).toEqual([300, "s/r/par/1", 2]);
});
