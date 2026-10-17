import { describe, expect, it } from "vitest";
import { classifyLimit, FALLBACK_WAIT_MS, type LimitInput } from "./classify.ts";

const AT = "2026-10-17T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(AT) + ms).toISOString();

// Error text shapes as T3 stores them in a thread's lastError: T3's own Claude adapter messages
// (ClaudeAdapterV2 providerFailureFromResult) and the CLI's or CLIProxyAPI's raw text it passes through
// (CLIProxyAPI handlers_routing.go, selector.go, errors.go). No live limit was hit to get them.
const FIXTURES: ReadonlyArray<{ readonly name: string; readonly input: Omit<LimitInput, "at">; readonly expected: ReturnType<typeof classifyLimit> }> = [
  {
    name: "T3 usage_limit with its reset",
    input: { errorClass: "usage_limit", message: "Claude usage limit reached. Send the message again once the limit resets.", resetAt: "2026-10-20T09:00:00.000Z" },
    expected: { class: "usage_limit", resumeAt: "2026-10-20T09:00:00.000Z" },
  },
  {
    name: "T3 blocking_limit without a reset",
    input: { errorClass: "usage_limit", message: "Claude stopped: a usage limit blocked the request." },
    expected: { class: "usage_limit", resumeAt: at(FALLBACK_WAIT_MS.usage_limit) },
  },
  {
    name: "the CLI's usage limit with an epoch reset",
    input: { errorClass: "provider_error", message: "Claude AI usage limit reached|1792483200" },
    expected: { class: "usage_limit", resumeAt: "2026-10-20T08:00:00.000Z" },
  },
  {
    name: "T3 429",
    input: { errorClass: "usage_limit", message: "Claude API rate limit reached. Try again later." },
    expected: { class: "rate_limit", resumeAt: at(FALLBACK_WAIT_MS.rate_limit) },
  },
  {
    name: "a raw API 429",
    input: { errorClass: "provider_error", message: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}' },
    expected: { class: "rate_limit", resumeAt: at(FALLBACK_WAIT_MS.rate_limit) },
  },
  {
    name: "a proxy 503 wrapping a 429, with its wait",
    input: {
      errorClass: "provider_error",
      message: 'API Error: 503 [claude] [429]: {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}} (reset after 1h30m)',
    },
    expected: { class: "rate_limit", resumeAt: at(90 * 60_000) },
  },
  {
    name: "CLIProxyAPI 400 unknown provider for model",
    input: {
      errorClass: "provider_error",
      message: 'API Error: 400 {"error":{"message":"unknown provider for model claude-opus-5-5","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
      model: "claude-sonnet-5-5",
    },
    expected: { class: "pool_exhausted", model: "claude-opus-5-5" },
  },
  {
    name: "CLIProxyAPI 503 no auth available",
    input: { errorClass: "provider_error", message: 'API Error: 503 {"error":{"message":"no auth available","code":"auth_unavailable"}}', model: "claude-opus-5-5" },
    expected: { class: "pool_exhausted", model: "claude-opus-5-5" },
  },
  {
    name: "a proxy 503 no available account",
    input: { errorClass: "provider_error", message: "API Error: 503 no available account for claude-opus-5-5" },
    expected: { class: "pool_exhausted" },
  },
  {
    name: "CLIProxyAPI model_cooldown with reset_seconds",
    input: {
      errorClass: "provider_error",
      message:
        'API Error: 429 {"error":{"code":"model_cooldown","message":"All credentials for model claude-opus-5-5 are cooling down","model":"claude-opus-5-5","reset_time":"1h2m0s","reset_seconds":3720}}',
    },
    expected: { class: "usage_limit", resumeAt: at(3_720_000) },
  },
  { name: "overloaded", input: { errorClass: "provider_error", message: "Claude API is overloaded (529). Try again shortly." }, expected: undefined },
  { name: "context window", input: { errorClass: "provider_error", message: "Claude stopped: the prompt exceeds the model's context window." }, expected: undefined },
  { name: "transport", input: { errorClass: "transport_error", message: "Claude API connection error." }, expected: undefined },
];

describe("classifyLimit", () => {
  for (const f of FIXTURES) {
    it(f.name, () => expect(classifyLimit({ ...f.input, at: AT })).toEqual(f.expected));
  }

  it("ignores a reported reset that is not after the failure", () => {
    expect(classifyLimit({ errorClass: "usage_limit", message: "Claude usage limit reached.", resetAt: at(-1000), at: AT })).toEqual({
      class: "usage_limit",
      resumeAt: at(FALLBACK_WAIT_MS.usage_limit),
    });
  });
});
