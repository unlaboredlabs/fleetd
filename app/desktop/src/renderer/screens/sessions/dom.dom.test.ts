// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { structureOf } from "./dom";
import { nodeLine } from "./model";

const PAGE = `<!doctype html><html><head><title>Sign in</title><script>alert(1)</script></head><body>
<header><a href="/">Linen &amp; Co.</a><nav><a href="/shop">Shop</a><a href="/sign-in">Sign in</a></nav></header>
<main><h1>Sign in to Linen &amp; Co.</h1>
<form><label for="email">Email</label><input id="email" type="email" value="qa@acme.test">
<label for="password">Password</label><input id="password" type="password" value="hunter2">
<button type="submit" id="go">Sign in</button></form>
<ul><li>One</li><li>Two</li></ul></main></body></html>`;

describe("a step's page as structure", () => {
  it("is the page's elements by role, name and value, under their parents", () => {
    const { nodes } = structureOf(PAGE);
    const lines = nodes.map((n) => `${"  ".repeat(n.depth)}${n.role}${n.name === undefined ? "" : ` ${n.name}`}${n.value === undefined ? "" : ` = ${n.value}`}`);
    expect(lines).toEqual([
      "banner",
      "  link Linen & Co.",
      "  navigation",
      "    link Shop",
      "    link Sign in",
      "main",
      "  heading Sign in to Linen & Co.",
      "  form",
      "    textbox Email = qa@acme.test",
      "    textbox Password",
      "    button Sign in",
      "  list",
      "    listitem One",
      "    listitem Two",
    ]);
  });

  it("never shows a password field's value, whatever the HTML holds", () => {
    const { nodes } = structureOf(PAGE);
    const password = nodes.find((n) => n.name === "Password");
    expect(password).toMatchObject({ secret: "vault" });
    expect(password?.value).toBeUndefined();
    expect(JSON.stringify(nodes.map(nodeLine))).not.toContain("hunter2");
  });

  it("points at what a CSS selector names, and at nothing for an agent-browser ref", () => {
    const at = (selector: string) => {
      const page = structureOf(PAGE, selector);
      return page.targets.map((i) => page.nodes[i]?.name);
    };
    expect(at("#go")).toEqual(["Sign in"]);
    expect(at("#email, #password")).toEqual(["Email", "Password"]);
    expect(at("@e3")).toEqual([]);
  });
});
