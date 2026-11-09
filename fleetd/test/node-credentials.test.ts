// Logins from 1Password (onepassword.rs and credentials.rs's
// tests), with a fake 1Password: the node fills them on the item's own site, and the values never reach the agent (its
// tool results, its raw CDP reads), the recording or what the node reports, in any form a page or an encoding shows
// them. The site checks it got them.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OnePassword, SDK_VERSION, installDir } from "../src/node/actions/onepassword.ts";
import { sealedRefusal } from "../src/node/browser/guard.ts";
import { Cache, CredError, expiry, hostOf, originAllowed, RATE_LIMIT_COOLDOWN_MS, type Vault } from "../src/node/browser/onepassword.ts";
import { Scrub } from "../src/node/browser/record.ts";
import { Masker } from "../src/node/mask.ts";
import { chrome, driver, eventually, fakeVault, forms, formValue, rig, THREAD, TOKEN, uploaded } from "./browser_rig.ts";
import { tempHome } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const USER = "ada@shop.example.test";
/** With the characters a form body, HTML and JSON each encode their own way. */
const PASSWORD = 'Pw-Sekr3t+/ &x<9"';
const OTP = "492817";
const USER_REF = "op://Team/Shop/username";
const PASSWORD_REF = "op://Team/Shop/password";
const OTP_REF = "op://Team/Shop/one-time password?attribute=otp";

/** Fails, naming where, if any value is in `text` in any form. */
function expectClean(what: string, text: string): void {
  for (const value of [USER, PASSWORD, OTP]) for (const form of forms(value)) if (text.includes(form)) throw new Error(`${what} holds ${JSON.stringify(form)}: ${text.slice(0, 2000)}`);
}

test("a page is on the item's site by its host or a subdomain; an expiry reads in each way 1Password keeps it", () => {
  const urls = ["https://shop.example.com/login"];
  expect(originAllowed("https://shop.example.com/account", urls)).toBe(true);
  expect(originAllowed("https://eu.shop.example.com:8443/", urls)).toBe(true);
  expect(originAllowed("https://example.com/", urls)).toBe(false);
  expect(originAllowed("https://shop.example.com.evil.test/", urls)).toBe(false);
  expect(originAllowed("https://evilshop.example.com/", urls)).toBe(false);
  expect(originAllowed("about:blank", urls)).toBe(false);
  expect(originAllowed("https://shop.example.com/", [])).toBe(false);
  expect(hostOf("http://user@127.0.0.1:9/x")).toBe("127.0.0.1");
  for (const [kept, month, year] of [["03/2030", "03", "2030"], ["3/30", "03", "2030"], ["203003", "03", "2030"], ["032030", "03", "2030"], ["0330", "03", "2030"]]) {
    expect(expiry(kept!)).toEqual([month!, year!]);
  }
  for (const bad of ["", "13/2030", "march", "03/203"]) expect(expiry(bad)).toBeUndefined();
});

/** A vault 1Password rate-limits for its first `limited` reads. */
function flaky(limited: number): Vault & { calls: number } {
  const v = {
    calls: 0,
    async resolve(reference: string) {
      v.calls += 1;
      if (v.calls <= limited) throw new CredError("429 Too Many Requests", true);
      return { value: `v-${reference}-${v.calls}`, urls: ["https://shop.example.com/"] };
    },
  };
  return v;
}

test("a session keeps what it resolved but one-time codes, backs off a rate limit, and cools down after one", async () => {
  const slept: number[] = [];
  const sleep = async (ms: number) => void slept.push(ms);
  const vault = flaky(2);
  const cache = new Cache(sleep);
  const first = await cache.get(vault, "op://Team/Shop/password");
  expect(vault.calls).toBe(3);
  expect(slept).toEqual([2000, 4000]);
  expect((await cache.get(vault, "op://Team/Shop/password")).value).toBe(first.value);
  expect(vault.calls).toBe(3);
  const otp = "op://Team/Shop/one-time password?attribute=otp";
  await cache.get(vault, otp);
  await cache.get(vault, otp);
  expect(vault.calls).toBe(5);

  let now = 1_000_000;
  const stuck = flaky(100);
  const cooling = new Cache(sleep);
  const refused = await cooling.get(stuck, "op://Team/Shop/password", () => now).catch((e: CredError) => e);
  expect(refused).toMatchObject({ rateLimited: true });
  expect((refused as Error).message).toContain("try again in a few minutes");
  expect(stuck.calls).toBe(3);
  const again = await cooling.get(stuck, "op://Team/Shop/other", () => now).catch((e: CredError) => e);
  expect((again as Error).message).toContain("asks again in");
  expect(stuck.calls).toBe(3);
  now += RATE_LIMIT_COOLDOWN_MS;
  stuck.calls = 1000;
  expect((await cooling.get(stuck, "op://Team/Shop/password", () => now)).value).toStartWith("v-");
});

test("the thorough scrub masks every form a page shows a value in, and a short value only where a field holds it", () => {
  const scrub = new Scrub([["op://T/S/password", PASSWORD], ["op://T/S/pin", "42"]]);
  for (const form of forms(PASSWORD).slice(0, 6)) expect(scrub.text(`before ${form} after`)).not.toContain(form);
  // Its base64 inside a longer encoded string, at any alignment.
  for (const prefix of ["", "a", "ab"]) {
    const encoded = Buffer.from(`${prefix}${PASSWORD}tail`).toString("base64");
    expect(scrub.text(encoded)).toContain("***op://T/S/password***");
  }
  expect(scrub.text("42")).toBe("***op://T/S/pin***");
  expect(scrub.text('<input value="42"> and 4242')).toBe('<input value="***op://T/S/pin***"> and 4242');
  expect(new Masker([["X", PASSWORD]]).and(Masker.thorough([["X", PASSWORD]])).text(PASSWORD.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"))).toBe("***X***");
});

test("a sealed session refuses whatever could carry a value off the page or tell it, and runs agent-browser's own scripts", () => {
  for (const [method, params] of [
    ["Runtime.evaluate", { expression: "document.title" }],
    ["Runtime.callFunctionOn", { functionDeclaration: "function() { return this.getAttribute('href'); }" }],
    ["Page.navigate", { url: "https://shop.example.test/" }],
    ["Page.reload", {}],
    ["Input.insertText", { text: "hello" }],
    ["DOM.querySelectorAll", { selector: "input[type=password]" }],
  ] as const) {
    expect(sealedRefusal(method, params)).toBeUndefined();
  }
  for (const [method, params, says] of [
    ["Runtime.evaluate", { expression: "btoa(document.querySelector('#pw').value)" }, "not one of agent-browser 0.39.4's own scripts"],
    ["Runtime.callFunctionOn", { functionDeclaration: "function() { return this.value; }" }, "not one of agent-browser 0.39.4's own scripts"],
    ["Runtime.evaluate", { expression: "document.title +" }, "not a script fleetd can read"],
    ["Runtime.evaluate", { expression: "document.querySelector('#pw')?.removeAttribute('type')" }, "it changes the type attribute"],
    ["DOM.querySelectorAll", { selector: "input:INVALID" }, "a field's state (:invalid)"],
    ["Runtime.evaluate", { expression: "document.querySelectorAll('#pw:valid').length" }, "it queries a field's state (:valid)"],
    ["Fetch.continueRequest", {}, "Fetch.continueRequest is off"],
    ["Page.reload", { scriptToEvaluateOnLoad: "x()" }, "Page.reload is off"],
    ["Page.navigate", { url: " JavaScript:alert(1)" }, "Page.navigate is off"],
  ] as const) {
    const why = sealedRefusal(method, params) ?? "";
    expect(why).toContain(says);
    expect(why).toContain("filled a login from 1Password");
  }
});

/** A fake `@1password/sdk` at the pinned version, so the node runs its real helper against it with no npm and no
 * 1Password (onepassword.rs `fake_sdk`). It takes FAKE_TOKEN only. None without Node.js. */
const FAKE_TOKEN = "ops_devbox-fake-service-account";
function fakeSdk(home: string): boolean {
  if (Bun.spawnSync(["node", "--version"]).exitCode !== 0) return false;
  const sdk = join(installDir(home), "node_modules/@1password/sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@1password/sdk", version: SDK_VERSION, type: "module", main: "index.js" }));
  writeFileSync(
    join(sdk, "index.js"),
    `export class RateLimitExceededError extends Error {}
export async function createClient({ auth }) {
  if (auth !== "${FAKE_TOKEN}") throw new Error(\`invalid service account token \${auth}\`);
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined) throw new Error("the token is in the environment");
  return {
    vaults: { list: async () => [{ id: "v1", title: "Agents" }, { id: "v2", title: "Shared" }] },
    items: {
      list: async (vault) =>
        vault === "v1"
          ? [{ id: "i1", title: "Shop", category: "Login", websites: [{ url: "https://shop.devbox.test/login" }] }]
          : [
              { id: "i2", title: "Visa", category: "CreditCard", websites: [] },
              { id: "i3", title: "Passport", category: "Passport", websites: [] },
            ],
      get: async (vault, item) => ({
        id: item,
        fields: [
          { id: "cardholder", title: "cardholder name", fieldType: "Text", value: "Ada Devbox" },
          { id: "ccnum", title: "number", fieldType: "CreditCardNumber", value: "4242 4242 4242 4242" },
          { id: "cvv", title: "verification number", fieldType: "Concealed", value: "737" },
          { id: "expiry", title: "expiry date", fieldType: "MonthYear", value: "03/2030" },
        ],
      }),
    },
    secrets: { resolve: async (ref) => \`pw-\${ref.split("/").at(-1)}\` },
  };
}
`,
  );
  return true;
}

test("the helper takes its token on stdin, resolves logins, cards and identities, and refuses another token", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  if (!fakeSdk(home.dir)) return console.warn("no Node.js here: the helper isn't tried");
  const { OnePasswordVault } = await import("../src/node/browser/onepassword.ts");
  const helper = new OnePassword(home.dir, FAKE_TOKEN);
  cleanups.push(() => helper.close());
  const vault = new OnePasswordVault(helper);
  expect(await helper.vaultNames()).toEqual(["Agents", "Shared"]);
  expect(await vault.resolve("op://Agents/Shop/password")).toEqual({ value: "pw-password", urls: ["https://shop.devbox.test/login"] });
  expect(await helper.cards()).toEqual([{ ref: "op://Shared/Visa", title: "Visa", vault: "Shared" }]);
  expect(await vault.card("op://Shared/Visa")).toEqual({ number: "4242424242424242", month: "03", year: "2030", cvc: "737", name: "Ada Devbox" });
  expect((await vault.identity("op://Shared/Passport/number")).value).toBe("pw-number");
  expect((await vault.identity("op://Shared/Visa/number").then(() => undefined, (e: Error) => e))?.message).toContain("is not an Identity");
  expect((await vault.card("op://Agents/Shop").then(() => undefined, (e: Error) => e))?.message).toBe("1Password: Shop is not a Credit Card item");
  const wrong = new OnePassword(home.dir, "ops_wrong");
  cleanups.push(() => wrong.close());
  expect((await wrong.vaultNames().then(() => undefined, (e: Error) => e))?.message).toBe("1Password: invalid service account token ops_wrong");
});

/** The shop: a sign-in form at /, one at /elsewhere that sends to another host, /login (which greets the user and,
 * carelessly, echoes the password into the page) with a one-time code form, and /otp. Each POST body is kept. */
function shop() {
  const bodies: string[] = [];
  const signIn = (action: string) =>
    `<html><head><title>Sign in</title></head><body><form method=post action=${action}><input id=user name=user><input id=pw name=pw type=password><button id=go>Sign in</button></form><input id=file type=file></body></html>`;
  let port = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const path = new URL(req.url).pathname;
      const html = (page: string) => new Response(page, { headers: { "content-type": "text/html" } });
      if (req.method === "POST") {
        const body = await req.text();
        bodies.push(body);
        if (path === "/login") {
          const pw = (formValue(body, "pw") ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
          return html(
            `<html><head><title>Welcome</title></head><body><h1>Welcome ${formValue(body, "user")}</h1><input id=echo value="${pw}"><form method=post action=/otp><input id=otp name=otp><button id=verify>Verify</button></form></body></html>`,
          );
        }
        return html("<html><head><title>Verified</title></head><body><h1>Verified</h1></body></html>");
      }
      if (path === "/elsewhere") return html(signIn(`http://localhost:${port}/login`));
      return html(signIn("/login"));
    },
  });
  port = server.port ?? 0;
  cleanups.push(() => void server.stop(true));
  return { site: `http://127.0.0.1:${port}`, bodies };
}

test.skipIf(!chrome)("a login filled from 1Password never reaches the agent, the recording or what the node reports", async () => {
  const r = await rig();
  cleanups.push(r.done);
  const { site, bodies } = shop();
  const fake = fakeVault({ [USER_REF]: USER, [PASSWORD_REF]: PASSWORD, [OTP_REF]: OTP }, [`${site}/`]);
  r.broker.credentials.vaultFor = fake.vaultFor;
  let heard = "";
  const started = await r.call("session_start", { purpose: "Sign in to the shop" });
  const d = await driver(String(started.result!.cdp));
  cleanups.push(d.close);
  const page = await d.page();
  await d.ok("Network.enable", {}, page);
  await d.ok("Page.navigate", { url: site }, page);
  await d.until(page, "document.title", "Sign in");

  const user = await r.call("fill_credential", { ref: USER_REF, target: "#user", submit: false });
  expect(String(user.result?.message)).toStartWith("Filled #user from op://Team/Shop/username.");
  const password = await r.call("fill_credential", { ref: PASSWORD_REF, target: "#pw" });
  expect(String(password.result?.message)).toContain("and submitted its form");
  heard += JSON.stringify([user, password]);
  await d.until(page, "document.title", "Welcome");

  // Raw CDP, as an agent's own script would read: only agent-browser's own script shapes run, and their reads come
  // back scrubbed. Any other script is refused, however it reads or reshapes.
  const echo = "document.querySelector('#echo')";
  for (const expression of [
    `${echo}.value`,
    `btoa(${echo}.value)`,
    `encodeURIComponent(${echo}.value)`,
    `${echo}.value.split('').reverse().join('')`,
    `(${echo}.value || '').slice(1)`,
    `${echo}.type = 'text'`,
    "document.body.innerHTML",
    "document.forms[0].action = 'http://127.0.0.1:9/steal'",
  ]) {
    const answer = await d.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, page);
    heard += JSON.stringify(answer);
    expect(answer.error?.message ?? "").toContain("filled a login from 1Password");
  }
  expect(await d.evaluate(page, "document.title")).toBe("Welcome");
  const object = (await d.ok("Runtime.evaluate", { expression: echo }, page)).result.objectId;
  const attr = await d.ok("Runtime.callFunctionOn", { objectId: object, functionDeclaration: "function() { return this.getAttribute('value'); }", returnByValue: true }, page);
  expect(attr.result.value).toBe("***op://Team/Shop/password***");
  heard += JSON.stringify(attr);
  const reshaped = await d.send("Runtime.callFunctionOn", { objectId: object, functionDeclaration: "function() { return this.value; }", returnByValue: true }, page);
  expect(reshaped.error?.message ?? "").toContain("not one of agent-browser 0.39.4's own scripts");
  // agent-browser's snapshot: the page's text, scrubbed.
  const tree = await d.send("Accessibility.getFullAXTree", {}, page);
  expect(tree.error).toBeUndefined();
  heard += JSON.stringify(tree);
  for (const method of ["DOMSnapshot.captureSnapshot", "Network.getRequestPostData", "DOM.getOuterHTML", "Page.printToPDF", "Fetch.enable"]) {
    const answer = await d.send(method, {}, page);
    expect(answer.error).toBeDefined();
    heard += JSON.stringify(answer);
  }
  // The login's request, as the driver's own Network events showed it: its body scrubbed.
  const login = d.got.find((m) => m.method === "Network.requestWillBeSent" && (m.params as any)?.request?.method === "POST") as any;
  expect(login.params.request.postData).toContain("***op://Team/Shop/password***");

  // The one-time code: kept from the video and the live view (dots, blurred), then sent with the agent's Enter.
  const otp = await r.call("fill_credential", { ref: OTP_REF, target: "#otp", submit: false });
  expect(String(otp.result?.message)).toContain("(a one-time code)");
  heard += JSON.stringify(otp);
  const session = r.broker.live(THREAD)!;
  const own = session.page()![1];
  const style = await session.cdp.call(own, "Runtime.evaluate", {
    expression: "(s => s.webkitTextSecurity + ' ' + s.filter)(getComputedStyle(document.querySelector('#otp')))",
    returnByValue: true,
  });
  expect((style.result as { value: string }).value).toBe("disc blur(6px)");
  for (const type of ["keyDown", "keyUp"]) {
    await d.ok("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }, page);
  }
  await d.until(page, "document.title", "Verified");
  heard += JSON.stringify(d.got);
  // An agent-browser command whose output held a value anyway: logged scrubbed.
  r.broker.item(THREAD, {
    id: "i1",
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    kind: { type: "command", command: "agent-browser get value #echo", output: `${PASSWORD}\n${USER}`, exitCode: 0 },
  } as never);
  // What the node reports for the agent's session is masked too, from the fill on.
  const filled = r.broker.credentials.filledSince(THREAD, 0)!;
  expect(filled.length).toBe(3);
  expect(r.broker.credentials.filledSince(THREAD, 3)).toBeUndefined();
  expectClean("a report", Masker.thorough(filled).text(`printed ${PASSWORD} and ${Buffer.from(USER).toString("base64")} and ${OTP}`));

  expectClean("what the agent heard", heard);
  expect(formValue(bodies[0]!, "user")).toBe(USER);
  expect(formValue(bodies[0]!, "pw")).toBe(PASSWORD);
  expect(formValue(bodies[1]!, "otp")).toBe(OTP);
  expect(fake.asked.length).toBe(3);
  // The agent-browser policy denies its reads from the first fill.
  const policy = JSON.parse(await Bun.file(join(r.home, "sessions", THREAD, "agent-browser-policy.json")).text());
  expect(policy.deny).toEqual(["connect", "evaluate", "inputvalue", "addinitscript", "addscript"]);

  const ended = await r.call("session_end");
  expectClean("session_end's answer", JSON.stringify(ended));
  const id = String(ended.result!.sessionId);
  await eventually(() => r.link.calls.some((c) => c.op === "browser_session" && c.args.state === "recorded"));
  const reports = r.link.calls.filter((c) => c.op === "browser_session");
  expect(reports.at(-1)!.args.credentialsFilled).toBe(3);
  expectClean("the hub's session", JSON.stringify(reports));
  const actions = uploaded(r.link, id);
  expectClean("the action log", actions);
  const fills = actions
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((a) => a.tool === "fill_credential");
  expect(fills.length).toBe(3);
  expect(fills[1].args.ref).toBe(PASSWORD_REF);
  expect(actions).toContain("***op://Team/Shop/password***");
  // The DOM trace, after each command and each fill: the page greets the user by name, scrubbed.
  const dom = uploaded(r.link, id, "dom");
  expectClean("the DOM trace", dom);
  expect(dom).toContain("Welcome ***op://Team/Shop/username***");
  const filledSeqs = new Set(fills.map((f) => f.seq));
  const traced = dom.trim().split("\n").map((l) => JSON.parse(l).seq);
  expect(traced.some((seq: number) => filledSeqs.has(seq))).toBe(true);
});

test.skipIf(!chrome)("a login fills only on its item's site, into a form that sends there, and only with the session's token", async () => {
  const r = await rig();
  cleanups.push(r.done);
  const { site, bodies } = shop();
  const fake = fakeVault({ [USER_REF]: USER, [PASSWORD_REF]: PASSWORD }, ["https://shop.example.test/"]);
  r.broker.credentials.vaultFor = fake.vaultFor;
  const started = await r.call("session_start", { purpose: "Sign in" });
  const d = await driver(String(started.result!.cdp));
  cleanups.push(d.close);
  const page = await d.page();
  await d.ok("Page.navigate", { url: site }, page);
  await d.until(page, "document.title", "Sign in");
  const off = await r.call("fill_credential", { ref: PASSWORD_REF, target: "#pw" });
  expect(off.error).toMatchObject({ code: "forbidden", message: `${PASSWORD_REF} is for shop.example.test; this page is on 127.0.0.1.` });
  // Not sealed: nothing was filled.
  expect(r.broker.live(THREAD)!.sealed()).toBe(false);

  // The item's site is this one, but /elsewhere's form sends to another host.
  const here = fakeVault({ [PASSWORD_REF]: PASSWORD }, [`${site}/`]);
  r.broker.credentials.forget(r.broker.live(THREAD)!.id);
  r.broker.credentials.vaultFor = here.vaultFor;
  await d.ok("Page.navigate", { url: `${site}/elsewhere` }, page);
  await d.until(page, "document.title", "Sign in");
  const away = await r.call("fill_credential", { ref: PASSWORD_REF, target: "#pw" });
  expect(away.error?.message).toContain("its form sends to localhost, not to the item's website");
  expect(r.broker.live(THREAD)!.credentialsFilled).toBe(0);
  const notField = await r.call("fill_credential", { ref: PASSWORD_REF, target: "#go", submit: false });
  expect(notField.error?.message).toContain("#go is not a text or password field");
  const none = await r.call("fill_credential", { ref: "op://Team/Shop/nothing", target: "#pw" });
  expect(none.error).toMatchObject({ code: "failed" });
  expect(none.error!.message).toContain("op://Team/Shop/nothing was not read");
  expect(bodies).toEqual([]);

  // An item with no website fills nowhere.
  const bare = fakeVault({ [PASSWORD_REF]: PASSWORD }, []);
  r.broker.credentials.forget(r.broker.live(THREAD)!.id);
  r.broker.credentials.vaultFor = bare.vaultFor;
  expect((await r.call("fill_credential", { ref: PASSWORD_REF, target: "#pw" })).error?.message).toContain("has no website, so it fills nowhere");
});

test.skipIf(!chrome)("without a token a fill says where a person saves one, and a filled field takes no write of the driver's", async () => {
  const bare = await rig([]);
  cleanups.push(bare.done);
  await bare.call("session_start", { purpose: "Sign in" });
  const refused = await bare.call("fill_credential", { ref: PASSWORD_REF, target: "#pw" });
  expect(refused.error?.message).toBe("There is no 1Password service account token for this work (OP_SERVICE_ACCOUNT_TOKEN).");
  expect(refused.error?.fix).toContain("Settings › Your accounts › 1Password");

  const r = await rig();
  cleanups.push(r.done);
  const { site } = shop();
  r.broker.credentials.vaultFor = fakeVault({ [USER_REF]: USER }, [`${site}/`]).vaultFor;
  const started = await r.call("session_start", { purpose: "Sign in" }, THREAD);
  const d = await driver(String(started.result!.cdp));
  cleanups.push(d.close);
  const page = await d.page();
  await d.ok("Page.navigate", { url: site }, page);
  await d.until(page, "document.title", "Sign in");
  expect((await r.call("fill_credential", { ref: USER_REF, target: "#user", submit: false })).result).toBeDefined();
  const root = (await d.ok("DOM.getDocument", { depth: 0 }, page)).root.nodeId;
  const user = (await d.ok("DOM.querySelectorAll", { nodeId: root, selector: "#user" }, page)).nodeIds[0];
  const file = (await d.ok("DOM.querySelectorAll", { nodeId: root, selector: "#file" }, page)).nodeIds[0];
  const onFilled = await d.send("DOM.setFileInputFiles", { nodeId: user, files: [] }, page);
  expect(onFilled.error?.message).toContain("DOM.setFileInputFiles is off on this field");
  const unnamed = await d.send("DOM.setFileInputFiles", { files: [] }, page);
  expect(unnamed.error?.message).toContain("couldn't tell which element this write is for");
  // Another field takes it, and the commands after keep their order.
  const other = d.send("DOM.setFileInputFiles", { nodeId: file, files: [] }, page);
  const after = d.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, page);
  expect((await other).error).toBeUndefined();
  expect((await after).result.result.value).toBe("Sign in");
  // agent-browser's snapshot names the filled field, never its value.
  const tree = await d.ok("Accessibility.getFullAXTree", {}, page);
  expect(JSON.stringify(tree)).not.toContain(USER);
  expect(JSON.stringify(tree)).toContain("***filled***");
  expect(TOKEN).toStartWith("ops_");
});

test("fill_credential takes item and field, or ref: a vault item is refused plainly until the node fills from the vault", async () => {
  const { referenceOf } = await import("../src/node/browser/credentials.ts");
  expect(referenceOf({ ref: "op://Team/Shop/password", target: "#f" })).toBe("op://Team/Shop/password");
  expect(() => referenceOf({ item: "Example", field: "password", target: "#f" })).toThrow("Filling a vault item needs");
  for (const call of [{ target: "#f" }, { item: "Example", target: "#f" }, { item: "Example", field: "password", ref: "op://Team/Shop/password" }]) {
    expect(() => referenceOf(call)).toThrow(/give item and field, or ref|item goes with its field/);
  }
});
