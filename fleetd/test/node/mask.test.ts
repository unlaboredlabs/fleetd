// node/mask.ts: the masker every report goes through, the thorough one a screen's recording scrubs with, and the
// recording's Scrub (browser/record.rs tests, ported).
import { expect, test } from "bun:test";
import { HIDDEN, Masker, Scrub } from "../../src/node/mask.ts";

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

test("a private key's PEM block is hidden whoever's it is, and an open one is held back in live text", () => {
  const body = Buffer.from("made-up filler, not a key ".repeat(4)).toString("base64").match(/.{1,64}/g)!.join("\n");
  const block = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
  const m = new Masker();
  expect(m.text(`key:\n${block}\nafter`)).toBe(`key:\n${HIDDEN}\nafter`);
  // As JSON escapes it, and cut short at the end of a text.
  expect(m.text(JSON.stringify({ k: block }))).toBe(JSON.stringify({ k: HIDDEN }));
  expect(m.text(`cut: -----BEGIN PRIVATE KEY-----\n${body.slice(0, 30)}`)).toBe(`cut: ${HIDDEN}`);
  expect(m.text("-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----")).toContain("abc");
  // Live text holds back an open block and what could become its header; a closed one goes.
  const open = `see -----BEGIN PRIVATE KEY-----\n${body.slice(0, 20)}`;
  expect(m.held(open)).toBe(open.length - 4);
  expect(m.held("ends ---")).toBe(3);
  expect(m.held(`${block} done`)).toBe(0);
});

test("a multi-line value is masked line by line, a line cut at its = padding too", () => {
  const value = ["-----BEGIN PRIVATE KEY-----", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldY", "WVphYmNkZWZnaA==", "-----END PRIVATE KEY-----"].join("\n");
  const m = new Masker([["APP_KEY", value]]);
  // As `env | cut -d= -f1` prints it: the body lines, the last without its padding.
  expect(m.text("APP_KEY\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldY\nWVphYmNkZWZnaA\n-----END PRIVATE KEY-----")).toBe("APP_KEY\n***APP_KEY***\n***APP_KEY***\n-----END PRIVATE KEY-----");
  expect(m.text(value)).toBe("***APP_KEY***");
  // A short line isn't masked wherever it appears.
  expect(new Masker([["V", "line one is long\nshort"]]).text("a short word")).toBe("a short word");
});

test("text that only names a private key's header is left as it is, and isn't held back in live text", () => {
  const m = new Masker();
  for (const prose of [
    "The parser expects -----BEGIN PRIVATE KEY----- but this file has an RSA header, so convert it",
    "convert -----BEGIN RSA PRIVATE KEY----- to -----BEGIN PRIVATE KEY----- with openssl",
    'grep -n "-----BEGIN PRIVATE KEY-----" src/keys.ts',
  ])
    expect(m.text(prose)).toBe(prose);
  // Held only while what follows could still be a key's body: a word could, words with a space between can't.
  expect(m.held("expects -----BEGIN PRIVATE KEY----- but")).toBe(31);
  expect(m.held("expects -----BEGIN PRIVATE KEY----- but this")).toBe(0);
  // A key's block cut short keeps the text after its body lines.
  const body = Buffer.from("made-up filler, not a key ".repeat(3)).toString("base64").match(/.{1,64}/g)!.join("\n");
  expect(m.text(`-----BEGIN PRIVATE KEY-----\n${body}\n(output cut)`)).toBe(`${HIDDEN}\n(output cut)`);
});

test("live text streamed in small pieces never cuts a secret in two, even where one line's end starts another", () => {
  // A value whose lines repeat: one line's end is another line's start.
  const filler = Buffer.from("not a real key, only filler for a test of fleetd's masking: ".repeat(7) + "end.").toString("base64").match(/.{1,64}/g)!;
  const key = ["-----BEGIN PRIVATE KEY-----", ...filler, "-----END PRIVATE KEY-----"].join("\n");
  const m = new Masker([["APP_KEY", key]]);
  for (const line of filler.slice(1, -1)) {
    for (const size of [1, 3, 5, 7]) {
      const said = `a line ${line} there`;
      // As the pump's flushDelta: hold back what could still be cut, mask what goes.
      let out = "";
      let buffered = "";
      for (const piece of said.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))!) {
        buffered += piece;
        const keep = m.held(buffered);
        out += m.text(buffered.slice(0, buffered.length - keep));
        buffered = buffered.slice(buffered.length - keep);
      }
      out += m.text(buffered);
      expect(out).toBe("a line ***APP_KEY*** there");
    }
  }
});
