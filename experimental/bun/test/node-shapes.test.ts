import { expect, test } from "bun:test";
import pinnedFile from "../../../crates/fleetd/src/node/browser/agent_browser_shapes.json";
import { refusal } from "../src/node/browser/guard.ts";
import { pinned, refusal as scriptRefusal, shape, writes } from "../src/node/browser/shapes.ts";

const sealed = { isOwn: () => false, isOwnTarget: () => false, sealed: () => true };
const evaluate = (expression: string) => refusal(sealed, { method: "Runtime.evaluate", params: { expression } });
const callOn = (functionDeclaration: string) => refusal(sealed, { method: "Runtime.callFunctionOn", params: { functionDeclaration } });

test("every pinned agent-browser shape reads, and is its own shape again", () => {
  const shapes = (pinnedFile as { shapes: { script: string }[] }).shapes;
  expect(shapes.length).toBe(34);
  for (const s of shapes) expect(pinned(s.script, "script")).toBe(true);
  // Values aside, two prints of one script are one shape: quotes, spacing, parentheses, the numbers in it.
  expect(shape(`document.querySelectorAll('input').length`, "script")).toBe(shape(`(document.querySelectorAll("a, b")).length`, "script"));
  expect(shape("document.title", "script")).not.toBe(shape("document.cookie", "script"));
});

test("a sealed session runs agent-browser's own scripts and refuses the rest", () => {
  // As credentials.rs's test: agent-browser's own, whatever values they carry.
  expect(evaluate("document.title")).toBeUndefined();
  expect(evaluate("document.querySelectorAll('input').length")).toBeUndefined();
  expect(callOn("function() { this.scrollIntoView({ block: 'center', inline: 'nearest' }); }")).toBeUndefined();
  expect(callOn("function() { return this.getAttribute('href'); }")).toBeUndefined();
  for (const [why, says] of [
    [evaluate("btoa(document.querySelector('#pw').value)"), "not one of agent-browser 0.39.4's own scripts"],
    [callOn("function() { return this.value; }"), "not one of agent-browser 0.39.4's own scripts"],
    [evaluate("document.title +"), "not a script fleetd can read"],
    [evaluate("document.querySelectorAll('#pw:valid').length"), "it queries a field's state (:valid)"],
    [evaluate("document.querySelectorAll(`input\\x3ainvalid`).length"), "it queries a field's state (:invalid)"],
    [evaluate("document.title <!-- x"), "an HTML comment marker"],
  ] as const) {
    expect(why).toContain(says);
  }
});

test("a pinned shape still may not write where a value could leave by", () => {
  // The writes check alone, on scripts of any shape, as shapes.rs's `writes` cases.
  const cases: [string, string][] = [
    ["(() => { const el = document.querySelector('form'); if (el) { el.setAttribute('onsubmit', 'x()'); return false; } return false; })()", "it changes the onsubmit attribute"],
    ["document.querySelector('#pw')?.removeAttribute('type')", "it changes the type attribute"],
    ["document.forms[0].action = 'https://evil.test/'", "it sets action"],
    ["fetch('//x')", "it uses fetch"],
    ["navigator.clipboard.writeText('x')", "it uses clipboard"],
    ["setTimeout('x()', 1)", "it runs a string as code"],
    ["document.body.appendChild(document.createElement('img'))", "it moves elements in the page (appendChild)"],
    ["Object.assign(document.forms[0], {})", "it sets properties it names at run time"],
    ["const k = 'action'; document.forms[0][k] = 'x'", "it sets a property it names at run time"],
    ["import('x')", "it imports a module"],
  ];
  // A sealed session refuses each: as no shape of agent-browser's, or, for one that is, as what it writes.
  for (const [script, says] of cases) {
    const why = scriptRefusal(script, "script");
    expect(why === says || why === "it is not one of agent-browser 0.39.4's own scripts").toBe(true);
  }
  for (const [script, says] of cases) expect(writes(script, "script")).toBe(says);
  // A local object of its own may be filled by name; reading and a declared `fetch` are no writes.
  expect(writes("const o = {}; o[k] = 1", "script")).toBeUndefined();
  expect(writes("const { fetchy } = x; a.b.c", "script")).toBeUndefined();
});
