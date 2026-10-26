// The Sessions fixture's pages as the HTML the node reads after a step (dom.jsonl): the shop and the payments dashboard
// pages.ts draws, in plain semantic markup. A password field carries no value, as the node's scrub leaves it.

const shopHead = (cart: number) => `<header><a href="/">Linen &amp; Co.</a><nav><a href="/shop">Shop</a><a href="/journal">Journal</a><a href="/account/sign-in">Sign in</a><a href="/cart">Cart (${String(cart)})</a></nav></header>`;

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title><script src="/app.js"></script></head><body>${body}</body></html>`;

export const shopHome = () =>
  page(
    "Linen & Co.",
    `${shopHead(0)}<main><section class="hero" aria-label="Autumn"><h1>Autumn linen</h1><p>Washed, breathable, made to last.</p></section><ul aria-label="Products"><li><a href="/products/linen-shirt">Linen shirt, $68.00</a></li><li><a href="/products/linen-trousers">Linen trousers, $84.00</a></li><li><a href="/products/overshirt">Overshirt, $96.00</a></li><li><a href="/products/throw">Throw, $120.00</a></li></ul></main>`,
  );

export const shopSignIn = (filled: boolean) =>
  page(
    "Sign in · Linen & Co.",
    `${shopHead(0)}<main><h1>Sign in to Linen &amp; Co.</h1><form><label for="email">Email</label><input id="email" type="email"${filled ? ' value="qa-checkout"' : ""}><label for="password">Password</label><input id="password" type="password"><button type="submit">Sign in</button></form><a href="/account/forgot">Forgot your password?</a></main>`,
  );

export const shopProduct = (cart: number, share = false) =>
  page(
    "Linen shirt · Linen & Co.",
    `${shopHead(cart)}<main><img src="/img/shirt.jpg" alt="Linen shirt"><h1>Linen shirt</h1><p>$68.00</p><div role="radiogroup" aria-label="Size"><input type="radio" name="size" aria-label="S"><input type="radio" name="size" aria-label="M" checked><input type="radio" name="size" aria-label="L"></div><button id="add-to-cart">${cart > 0 ? "Added to cart" : "Add to cart"}</button><p>Washed linen, relaxed fit. Made in Portugal.</p><button id="share" aria-expanded="${String(share)}">Share</button>${share ? '<div id="share-menu" role="menu" aria-label="Share"><a role="menuitem" class="copy-link" href="#copy">Copy link</a><a role="menuitem" href="#email">Email</a></div>' : ""}</main>`,
  );

export const shopNotFound = () => page("Not found · Linen & Co.", `${shopHead(0)}<main><h1>This page isn’t here</h1><p>The link may be broken, or the page may have moved.</p><a href="/">Back to the shop</a></main>`);
