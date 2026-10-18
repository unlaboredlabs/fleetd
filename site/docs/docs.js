// fleetd.sh/docs: copy buttons, the phone menu and search over /docs/search.json (fetched on first focus).
(function () {
  var d = document;

  d.querySelectorAll("pre[data-copy]").forEach(function (pre) {
    var box = d.createElement("div");
    var b = d.createElement("button");
    box.className = "cb";
    b.type = "button";
    b.className = "copy";
    b.textContent = "Copy";
    pre.parentNode.insertBefore(box, pre);
    box.appendChild(pre);
    box.appendChild(b);
    b.addEventListener("click", function () {
      // A transcript copies its commands, not their output.
      var text = pre.classList.contains("console")
        ? [].map.call(pre.querySelectorAll(".c"), function (c) { return c.textContent.replace(/^\$ /gm, ""); }).join("\n")
        : pre.textContent;
      var done = function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1600); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done);
      else {
        var t = d.createElement("textarea");
        t.value = text;
        d.body.appendChild(t);
        t.select();
        try { d.execCommand("copy"); done(); } catch (e) {}
        t.remove();
      }
    });
  });

  var menu = d.querySelector(".menu");
  if (menu) menu.addEventListener("click", function () {
    menu.setAttribute("aria-expanded", d.body.classList.toggle("nav-open"));
  });

  var q = d.getElementById("q");
  var list = d.getElementById("hits");
  if (!q || !list) return;
  var index = null;
  var found = [];
  var sel = 0;
  var load = function () {
    if (!index) index = fetch("/docs/search.json").then(function (r) { return r.json(); });
    return index;
  };
  var has = function (hay, terms) {
    return terms.every(function (t) { return hay.indexOf(t) >= 0; });
  };

  function search(pages) {
    var terms = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    found = [];
    if (terms.length === 0) { list.hidden = true; return; }
    pages.forEach(function (p) {
      var title = p.t.toLowerCase();
      var heads = p.h.map(function (h) { return h[0]; }).join(" ").toLowerCase();
      if (!has([title, p.d.toLowerCase(), heads, p.x.toLowerCase()].join(" "), terms)) return;
      var score = has(title, terms) ? 20 : 0;
      terms.forEach(function (t) { if (title.indexOf(t) >= 0) score += 4; if (heads.indexOf(t) >= 0) score += 2; });
      found.push({ s: score, u: p.u, b: p.t, i: p.d });
      p.h.forEach(function (h) {
        if (has(h[0].toLowerCase(), terms)) found.push({ s: score + 10, u: p.u + "#" + h[1], b: h[0], i: p.t });
      });
    });
    found.sort(function (a, b) { return b.s - a.s; });
    found = found.slice(0, 8);
    sel = 0;
    draw();
  }

  function draw() {
    list.textContent = "";
    if (found.length === 0) {
      var none = d.createElement("li");
      none.className = "none";
      none.textContent = "Nothing matches.";
      list.appendChild(none);
    }
    found.forEach(function (f, i) {
      var li = d.createElement("li");
      var a = d.createElement("a");
      var b = d.createElement("b");
      var s = d.createElement("span");
      a.href = f.u;
      a.setAttribute("role", "option");
      a.setAttribute("aria-selected", i === sel);
      b.textContent = f.b;
      s.textContent = f.i;
      a.appendChild(b);
      a.appendChild(s);
      li.appendChild(a);
      list.appendChild(li);
    });
    list.hidden = false;
  }

  q.addEventListener("focus", function () { load(); if (q.value) load().then(search); });
  q.addEventListener("input", function () { load().then(search); });
  q.addEventListener("blur", function () { setTimeout(function () { list.hidden = true; }, 150); });
  q.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (found.length) { sel = (sel + (e.key === "ArrowDown" ? 1 : found.length - 1)) % found.length; draw(); }
    } else if (e.key === "Enter" && found[sel]) {
      location.href = found[sel].u;
      list.hidden = true;
    } else if (e.key === "Escape") {
      q.value = "";
      list.hidden = true;
      q.blur();
    }
  });
  d.addEventListener("keydown", function (e) {
    var t = e.target.tagName;
    if (e.key === "/" && t !== "INPUT" && t !== "TEXTAREA" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); q.focus(); }
  });
})();
