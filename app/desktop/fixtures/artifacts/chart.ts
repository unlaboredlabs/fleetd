// The HTML artifact the artifacts fixtures publish: where a release build's time goes, as horizontal bars its own
// script draws (a sandboxed page runs its scripts, with no network), with a tooltip on each bar and a link to the
// builds it read, which opens in the browser. One series, one hue.
export const BUILD_TIMES_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Build times</title>
<style>
  .viz-root { color-scheme: light; --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e; --grid: #e4e3df; --series-1: #2a78d6; }
  html, body { margin: 0; background: var(--surface-1); }
  body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text-primary); padding: 20px 24px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
  p { margin: 0 0 16px; color: var(--text-secondary); }
  a { color: var(--series-1); }
  .source { margin: 12px 0 0; font-size: 12px; }
  svg { display: block; width: 100%; overflow: visible; }
  .label, .value { font-size: 12px; fill: var(--text-secondary); }
  .value { fill: var(--text-primary); font-variant-numeric: tabular-nums; }
  .bar { fill: var(--series-1); }
  .hit:hover + .bar, .bar.on { opacity: .82; }
  #tip { position: fixed; pointer-events: none; background: #0b0b0b; color: #fcfcfb; font-size: 12px; padding: 4px 8px; border-radius: 6px; opacity: 0; transition: opacity .1s; }
</style>
</head>
<body class="viz-root">
<h1>Where a release build's 18 minutes go</h1>
<p>Median of the last 14 builds on main, by step. Linking dominates; caching the toolchain would save little.</p>
<svg id="chart" role="img" aria-label="Minutes per build step"></svg>
<p class="source">From <a id="source" href="https://github.com/acme/storefront/actions/workflows/release.yml">the release workflow's runs</a>.</p>
<div id="tip" role="tooltip"></div>
<script>
  const steps = [["Link release binary", 7.4], ["Typecheck", 5.1], ["Desktop app bundle", 2.6], ["Tests", 1.7], ["Toolchain setup", 0.8], ["Upload", 0.4]];
  const svg = document.getElementById("chart"), tip = document.getElementById("tip"), ns = "http://www.w3.org/2000/svg";
  const draw = () => {
    const w = svg.clientWidth || 600, labelW = 150, valueW = 52, row = 30, bar = 18, max = Math.max(...steps.map((s) => s[1]));
    svg.innerHTML = "";
    svg.setAttribute("height", String(steps.length * row));
    const scale = (v) => ((w - labelW - valueW) * v) / max;
    steps.forEach(([name, min], i) => {
      const y = i * row, el = (tag, attrs, text) => { const n = document.createElementNS(ns, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (text) n.textContent = text; svg.appendChild(n); return n; };
      el("text", { x: 0, y: y + 6 + bar / 2 + 4, class: "label" }, name);
      const hit = el("rect", { x: labelW, y, width: w - labelW, height: row, fill: "transparent", class: "hit" });
      const b = el("rect", { x: labelW, y: y + 6, width: Math.max(2, scale(min)), height: bar, rx: 4, class: "bar" });
      el("text", { x: labelW + scale(min) + 8, y: y + 6 + bar / 2 + 4, class: "value" }, min.toFixed(1) + " min");
      hit.addEventListener("mousemove", (e) => { b.classList.add("on"); tip.textContent = name + ": " + min.toFixed(1) + " min, " + Math.round((min / 18) * 100) + "% of the build"; tip.style.left = e.clientX + 12 + "px"; tip.style.top = e.clientY + 12 + "px"; tip.style.opacity = 1; });
      hit.addEventListener("mouseleave", () => { b.classList.remove("on"); tip.style.opacity = 0; });
    });
  };
  draw();
  addEventListener("resize", draw);
</script>
</body>
</html>
`;
