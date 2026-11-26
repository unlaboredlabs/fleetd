// A sign-in form in an agent's browser (src/node/browser/sign_in.ts), on a real headless Chrome and a throwaway login
// site that asks for a password, then a one-time code: with no vault login the person's form fills the page (the
// username and password, then the code) and signs it in; a vault login fills it with no form; the agent never hears
// a value, and reading one back is refused. A fake hub stands in for the workspace. Never a real login.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { NodeBoxKey } from "../src/node/identity.ts";
import { publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import { chrome, driver, forms, formValue, rig, THREAD } from "./browser_rig.ts";

setDefaultTimeout(30_000);
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const USER = "grace@login.devbox.test";
const PASSWORD = 'Sign-In+Pw &q<9"';
const CODE = "otp-58Xq21";

/** The login site on 127.0.0.1: /login takes the username and password, /code the one-time code, then it is signed in.
 * Each POST body is kept. */
function loginSite() {
  const bodies: { path: string; body: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const path = new URL(req.url).pathname;
      const html = (title: string, body: string) => new Response(`<html><head><title>${title}</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });
      if (req.method === "POST") {
        const body = await req.text();
        bodies.push({ path, body });
        if (path === "/login") return html("Code", "<form method=post action=/code><label>Code <input id=code name=code autocomplete=one-time-code></label><button>Verify</button></form>");
        if (path === "/code") return html("Signed in", `<h1>Signed in as ${formValue(body, "code") === CODE ? "the right person" : "nobody"}</h1>`);
      }
      return html("Sign in", "<form method=post action=/login><input id=email name=email><input id=pw name=pw type=password><button>Sign in</button></form>");
    },
  });
  cleanups.push(() => void server.stop(true));
  return { site: `http://127.0.0.1:${server.port}`, bodies };
}

test.skipIf(!chrome)("no vault login: the person's form signs the page in, the code after the password too, and the agent never sees either", async () => {
  const r = await rig([]);
  cleanups.push(r.done);
  const { site, bodies } = loginSite();
  const opened: Record<string, unknown>[] = [];
  r.answers.set("sign_in_open", (args) => {
    opened.push(args);
    return { requestId: `Q${opened.length}`, state: "open" };
  });
  const started = await r.call("session_start", { purpose: "Sign in to the login site" });
  const d = await driver(String(started.result!.cdp));
  cleanups.push(d.close);
  const page = await d.page();
  await d.ok("Page.navigate", { url: `${site}/` }, page);
  await d.until(page, "document.title", "Sign in");
  const devbox = { domain: "127.0.0.1", name: "Devbox login" };

  // Refused before anything opens: no field, a selector the page lacks, another site.
  expect((await r.call("request_sign_in", { site: devbox, why: "the release" })).error?.message).toContain("at least one field");
  expect((await r.call("request_sign_in", { site: devbox, username: "#nope", why: "the release" })).error?.message).toBe("No field on the page matches #nope (the username).");
  expect((await r.call("request_sign_in", { site: { domain: "other.devbox.test", name: "Other" }, password: "#pw", why: "the release" })).error?.message).toContain("not other.devbox.test");
  expect(opened).toEqual([]);

  const asked = await r.call("request_sign_in", { site: devbox, username: "#email", password: "#pw", why: "the release" });
  expect(asked.result!.requestId).toBe("Q1");
  expect(String(asked.result!.message)).toStartWith("Asked the person to sign in to 127.0.0.1, in a secure form (Q1).");
  expect(opened[0]).toEqual({ sessionId: started.result!.sessionId, input: { site: devbox, username: "#email", password: "#pw", why: "the release" } });

  // The person's fields, sealed by the hub to this machine.
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const box = new NodeBoxKey(secret);
  const sealed = (fields: Record<string, string>) => Buffer.from(seal(publicKeyOf(secret), new TextEncoder().encode(JSON.stringify(fields)))).toString("base64");
  const frame = (requestId: string, fields: Record<string, string>) => ({ id: `d-${requestId}`, sink: `fill:devbox:${started.result!.sessionId}`, sealed: sealed(fields), requestId, secretKey: "browser.sign_in" });
  const login = await r.broker.deliver(frame("Q1", { username: USER, password: PASSWORD }) as never, box, "devbox");
  expect(login.error).toBeUndefined();
  expect(login.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  await d.until(page, "document.title", "Code");
  expect(bodies[0]!.path).toBe("/login");
  expect(formValue(bodies[0]!.body, "email")).toBe(USER);
  expect(formValue(bodies[0]!.body, "pw")).toBe(PASSWORD);
  expect((await r.broker.deliver(frame("Q1", { username: USER, password: PASSWORD }) as never, box, "devbox")).error).toBe("nothing waits for Q1 in that browser session: it was filled already");

  // The site asks for a code: its own form.
  const code = await r.call("request_sign_in", { site: devbox, otp: "#code", why: "the release" });
  expect(code.result!.requestId).toBe("Q2");
  expect(String(code.result!.message)).toStartWith("Asked the person for the code 127.0.0.1 sent them, in a secure form (Q2).");
  expect((await r.broker.deliver(frame("Q2", { otp: CODE }) as never, box, "devbox")).error).toBeUndefined();
  await d.until(page, "document.title", "Signed in");
  expect(bodies[1]).toEqual({ path: "/code", body: `code=${CODE}` });

  // Sealed: reading a filled value back is refused, and nothing the agent heard holds one.
  const session = r.broker.live(THREAD)!;
  expect(session.sealed()).toBe(true);
  const heard = JSON.stringify([asked, code, d.got]);
  for (const value of [USER, PASSWORD, CODE]) for (const form of forms(value).slice(0, 5)) expect(heard).not.toContain(form);
  expect(r.broker.credentials.filledSince(THREAD, 0)?.map(([name]) => name)).toEqual(["Q1 username", "Q1 password", "Q2 otp"]);
});

test.skipIf(!chrome)("a vault login for the site fills the page with no form", async () => {
  const r = await rig([]);
  cleanups.push(r.done);
  const { site, bodies } = loginSite();
  const to = () => Buffer.from(r.broker.boxKey().publicKey(), "base64");
  const asked: Record<string, unknown>[] = [];
  r.answers.set("sign_in_open", () => ({ vault: { itemId: `V${"c".repeat(32)}`, label: "Devbox login" } }));
  let audit = 0;
  r.answers.set("vault_fill", (args) => {
    asked.push(args);
    const value = args.field === "username" ? USER : PASSWORD;
    audit += 1;
    return { itemId: args.item, label: "Devbox login", auditId: audit, sealed: Buffer.from(seal(to(), new TextEncoder().encode(JSON.stringify({ value, sites: ["127.0.0.1"] })))).toString("base64") };
  });
  r.answers.set("vault_filled", (args) => ({ auditId: args.auditId }));
  const started = await r.call("session_start", { purpose: "Sign in again" });
  const d = await driver(String(started.result!.cdp));
  cleanups.push(d.close);
  const page = await d.page();
  await d.ok("Page.navigate", { url: `${site}/` }, page);
  await d.until(page, "document.title", "Sign in");
  const out = await r.call("request_sign_in", { site: { domain: "127.0.0.1", name: "Devbox login" }, username: "#email", password: "#pw", why: "the release" });
  expect(out.error).toBeUndefined();
  expect(out.result!.requestId).toBeUndefined();
  expect(String(out.result!.message)).toStartWith("Filled the username and password from the vault's Devbox login and submitted the form; nobody was asked.");
  await d.until(page, "document.title", "Code");
  expect(asked.map((a) => [a.item, a.field])).toEqual([
    [`V${"c".repeat(32)}`, "username"],
    [`V${"c".repeat(32)}`, "password"],
  ]);
  expect(formValue(bodies[0]!.body, "email")).toBe(USER);
  expect(formValue(bodies[0]!.body, "pw")).toBe(PASSWORD);
  expect(JSON.stringify([out, d.got])).not.toContain(PASSWORD);
});
