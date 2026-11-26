// The policy pages opened from the phone app (?app=1, set on <html> as .app before the page paints): legal.css hides
// the site's header and footer; here the policy pages link each other with the flag kept, and every other link of the
// site (pricing, home, the docs, sign-in) becomes plain text, so nothing leads to buying from inside the app.
(function () {
  var root = document.documentElement;
  if (!root.classList.contains("app")) return;
  var POLICIES = /^\/(terms|privacy|refunds|imprint|support|security|subprocessors)$/;
  document.querySelectorAll("a[href]").forEach(function (a) {
    var url = new URL(a.getAttribute("href"), location.href);
    if (url.protocol === "mailto:" || url.host === "status.fleetd.dev") return;
    if (url.host === location.host && POLICIES.test(url.pathname)) {
      url.searchParams.set("app", "1");
      a.setAttribute("href", url.pathname + url.search + url.hash);
      return;
    }
    if (url.host === location.host && url.hash !== "" && url.pathname === location.pathname) return;
    var text = document.createElement("span");
    text.textContent = a.textContent;
    a.replaceWith(text);
  });
})();
