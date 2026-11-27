// What a person reads under a message that isn't in yet (the apps show its first sentence alone, shared/wake.ts
// heldWords): the reason, that it goes in by itself, and no node or API jargon. Seen in the second quality sweep: a
// refused Claude key read "Not sent yet: the node on factory-a refused or failed the send request: claude refused its
// login: Failed to authenticate.", and an offline machine "factory-a is offline: its node isn't connected.", each cut
// before it said the message goes in by itself.
import { expect, test } from "bun:test";
import { notSentYet } from "../src/hub/chat/flow.ts";
import { runnerRefusal, WriteError } from "../src/hub/queue/index.ts";

const firstSentence = (s: string) => /^.+?[.!?](?=\s|$)/u.exec(s)?.[0] ?? s;

test("a refused Claude login: plain words, it goes in by itself, the node's own fix", () => {
  const refused = runnerRefusal("factory-a", {
    login: "logged_out",
    problem: "claude refused its login: Failed to authenticate. API Error: 401 OAuth token has expired. Please obtain a new token or refresh your existing token. Fix: claude auth login",
  });
  expect(refused).toBeInstanceOf(WriteError);
  const line = notSentYet(refused);
  expect(firstSentence(line)).toBe("Not sent yet: Claude isn't signed in on factory-a; it goes in by itself once that's fixed.");
  expect(line).toBe("Not sent yet: Claude isn't signed in on factory-a; it goes in by itself once that's fixed. On factory-a: claude auth login.");
});

test("another runner problem: its first sentence, never Claude's raw API error", () => {
  const refused = runnerRefusal("devbox", { login: "unknown", problem: "Claude Code 2.0.1 is older than the tested range. Install 2.1.302." });
  expect(firstSentence(notSentYet(refused))).toBe("Not sent yet: Claude can't run on devbox: Claude Code 2.0.1 is older than the tested range; it goes in by itself once that's fixed.");
  expect(runnerRefusal("devbox", { login: "logged_in" })).toBeUndefined();
});

test("a plain error says its first sentence and goes in by itself", () => {
  expect(notSentYet(new Error("the session ended. try later"))).toBe("Not sent yet: the session ended; it goes in by itself once that's fixed.");
  expect(notSentYet("thread gone")).toBe("Not sent yet: thread gone; it goes in by itself once that's fixed.");
});
