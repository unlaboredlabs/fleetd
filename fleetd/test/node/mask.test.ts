// node/mask.ts: the masker every report goes through, the thorough one a screen's recording scrubs with, and the
// recording's Scrub (browser/record.rs tests, ported).
import { expect, test } from "bun:test";
import { Masker, Scrub } from "../../src/node/mask.ts";

const formEncoded = (v: string) =>
  [...Buffer.from(v)].map((b) => (b === 32 ? "+" : /[A-Za-z0-9*\-._]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`)).join("");
const percent = (v: string) => encodeURIComponent(v);
const htmlEscaped = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

test("two maskers together mask both and the longer form first", () => {
  const both = new Masker([["KEY", "abcd-1234"]]).and(Masker.thorough([["op://T/I/password", "abcd-1234-xyz"]]));
  expect(both.text("a abcd-1234-xyz b abcd-1234")).toBe("a ***op://T/I/password*** b ***KEY***");
  expect(new Masker().and(new Masker()).empty).toBe(true);
});

test("a thorough masker also catches what a script posts with plus for space", () => {
  const value = "it's a top secret!";
  const m = Masker.thorough([["CODE", value]]);
  const posted = `code=${percent(value).replaceAll("%20", "+")}`;
  expect(posted).toBe("code=it's+a+top+secret!");
  expect(m.text(posted)).toBe("code=***CODE***");
  expect(m.text(`code=${formEncoded(value)}`)).toBe("code=***CODE***");
});

test("a thorough masker also catches escaped and embedded encodings", () => {
  const value = 'hunter2<&>"pass word';
  const m = Masker.thorough([["LOGIN", value]]);
  expect(m.text(JSON.stringify({ v: value }))).not.toContain("hunter2");
  expect(m.text(`<input value="${htmlEscaped(value)}">`)).not.toContain("hunter2");
  expect(m.text(`user=a&pw=${formEncoded(value)}`)).not.toContain("hunter2");
  // btoa of a longer string the value sits in, at each alignment.
  for (const prefix of ["", "a", "ab", "abc"]) {
    const masked = m.text(Buffer.from(`${prefix}${value}${prefix}`).toString("base64"));
    expect(masked).toContain("***LOGIN***");
  }
  // The plain masker doesn't: it is for reports, where these forms would garble ordinary output less often.
  expect(new Masker([["LOGIN", value]]).text(JSON.stringify({ v: value }))).toContain("hunter2");
});

test("a recording scrubs a short value only where it is a field's whole value", () => {
  const scrub = new Scrub([["CVC", "123"], ["KEY", "sk_test_4242"]]);
  expect(scrub.text("123")).toBe("***CVC***");
  expect(scrub.text('<input value="123"> and 1234 and value=\'123\'')).toBe('<input value="***CVC***"> and 1234 and value=\'***CVC***\'');
  expect(scrub.text("order 123 of sk_test_4242")).toBe("order 123 of ***KEY***");
  expect(scrub.value({ cvc: "123", note: "x123", key: ["sk_test_4242"] })).toEqual({ cvc: "***CVC***", note: "x123", key: ["***KEY***"] });
  // Thorough: a page's JSON escaping of a filled value is scrubbed too.
  expect(new Scrub([["PW", 'a"b\\c-long']]).text(JSON.stringify('a"b\\c-long'))).toBe('"***PW***"');
});
