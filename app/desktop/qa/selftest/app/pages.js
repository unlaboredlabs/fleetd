// Hash routes, like the app's. Each page root carries data-screen, which the harness waits for.
/** @type {Record<string, string | undefined>} */
const pages = {
  // Nothing on it may produce a finding.
  "#/": `<div class="page" data-screen="shell"><h1>fleetd</h1><p>Your console is connected.</p></div>`,
  "#/good": `<div class="page" data-screen="good">
    <p class="case w200">A long paragraph that wraps over several lines because body text always wraps instead of being cut off at the edge of its box.</p>
    <p class="case w200 ellipsis" title="Add a public frozen PNG snapshot under an unguessable link">Add a public frozen PNG snapshot under an unguessable link</p>
    <p class="case w200 clamp">Two lines at most, then an ellipsis: this description goes on well past two lines so that the clamp is what shows the end of it.</p>
    <pre class="case" data-text="code">## Do not re-ask
- share.public_link = eac3e0fe-ec61-4954-4f78-67240a80c42b @ 3e760f96</pre>
    <p class="case">Inline <code>share.window</code> keys are fine in code, e.g. fleetd.sh, app-pair.json, v1.2.3 and end-to-end tests.</p>
    <p class="case">A follow-up note - with a dash mid-sentence - costs $1,840 at 08:15:17 on 2026-10-19, order W1 task T12.</p>
    <h2 class="case">Why you are woken</h2>
    <ul class="case"><li>The human settled 2 of your asks.</li><li>See the answers since your last wake.</li></ul>
    <div class="case scroller">${Array.from({ length: 12 }, (_, i) => `<div>Row ${i + 1} in a list that scrolls</div>`).join("")}</div>
    <div class="case w200" style="overflow-x: auto"><span class="nowrap">A wide line that scrolls sideways inside its own scroller</span></div>
  </div>`,
  // Every marked element must be reported, and nothing else.
  "#/bad": `<div class="page" data-screen="bad">
    <div class="case w200 nowrap clip" data-testid="exp-overflow-clip">A long single line clipped at the edge with no ellipsis at all</div>
    <div class="case w200 nowrap" data-testid="exp-overflow-spill">A long single line that spills out of its box to the right</div>
    <div class="case w200 short clip" data-testid="exp-overflow-bottom">A paragraph that wraps onto three lines inside a box only one line tall, so the rest is cut</div>
    <div class="case">
      <div data-testid="exp-overlap-rows-a">First row of a list with a fixed height</div>
      <div class="pull-up" data-testid="exp-overlap-rows-b">Second row drawn over the first</div>
    </div>
    <div class="case stack">
      <p data-testid="exp-overlap-idle-text">week', literal as in the request</p>
      <span class="overlay" data-testid="exp-overlap-idle-label">idle</span>
    </div>
    <p class="case" data-testid="exp-raw-uuid">LEAD eac3e0fe-ec61-4954-4f78-67240a80c42b opus idle</p>
    <p class="case" data-testid="exp-raw-hash">brief 3e760f96a1</p>
    <p class="case" data-testid="exp-raw-dotted">Keys already decided: share.public_link, share.pay_comparison</p>
    <p class="case" data-testid="exp-raw-kebab">a-monthly-vs-week</p>
    <p class="case" data-testid="exp-raw-heading">## Why you are woken</p>
    <p class="case" data-testid="exp-raw-bullet">- D3 share.w2_after_w1 = W2 writer starts after W1's PR merges</p>
    <p class="case" data-testid="exp-raw-bold">This is **important** text</p>
    <span class="edge-left" data-testid="exp-edge-left">Touching the left edge</span>
    <button class="edge-right" data-testid="exp-edge-right">Right</button>
  </div>`,
};

const render = () => {
  document.body.innerHTML = pages[location.hash || "#/"] ?? `<p data-screen="missing">No page ${location.hash}</p>`;
};
window.addEventListener("hashchange", render);
render();
