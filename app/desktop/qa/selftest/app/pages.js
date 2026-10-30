// Hash routes, like the app's. Each page root carries data-screen, which the harness waits for.
/** @type {Record<string, string | undefined>} */
const pages = {
  // Nothing on it may produce a finding.
  "#/": `<div class="page" data-screen="shell"><h1>fleetd</h1><p>Your console is connected.</p></div>`,
  "#/good": `<div class="page" data-screen="good">
    <p class="case w200">A long paragraph that wraps over several lines because body text always wraps instead of being cut off at the edge of its box.</p>
    <p class="case w200 ellipsis" title="Add a public frozen PNG snapshot under an unguessable link">Add a public frozen PNG snapshot under an unguessable link</p>
    <p class="case w200 ellipsis tight">A tight line, typography and its descenders</p>
    <p class="case w200 clamp">Two lines at most, then an ellipsis: this description goes on well past two lines so that the clamp is what shows the end of it.</p>
    <pre class="case" data-text="code">## Do not re-ask
- share.public_link = eac3e0fe-ec61-4954-4f78-67240a80c42b @ 3e760f96</pre>
    <p class="case">Inline <code>share.window</code> keys are fine in code, e.g. fleetd.sh, app-pair.json, v1.2.3 and end-to-end tests.</p>
    <p class="case">A follow-up note - with a dash mid-sentence - costs $1,840 at 08:15:17 on 2026-10-19, order W1 task T12.</p>
    <h2 class="case">Why you are woken</h2>
    <ul class="case"><li>The human settled 2 of your asks.</li><li>See the answers since your last wake.</li></ul>
    <div class="case scroller">${Array.from({ length: 12 }, (_, i) => `<div>Row ${i + 1} in a list that scrolls</div>`).join("")}</div>
    <p class="case">A dialog title<span class="sr-only">read aloud to screen readers only, far longer than its one pixel box</span></p>
    <p class="case">Close<span class="sr-only-inset">a second hidden label, clipped with clip-path instead</span></p>
    <div class="case scroller"><div class="sticky-head">Opaque sticky header</div>${Array.from({ length: 12 }, (_, i) => `<div>Row ${i + 1} scrolls under the header <button>Open</button></div>`).join("")}</div>
    <div class="case pane"><div class="row"><span>W1</span><div class="grow shrinks"><div class="ellipsis">A flex child that may shrink, so its ellipsis shows inside the pane</div></div></div></div>
    <div class="case w200" style="overflow-x: auto"><span class="nowrap">A wide line that scrolls sideways inside its own scroller</span></div>
    <div class="case drag-bar"><button class="no-drag">Close</button></div>
    <div class="case drag-stack"><div class="drag-bar"></div><div class="over-bar no-drag"><button>Close</button></div></div>
  </div>`,
  // A popover (an opaque surface in a fixed positioner, as Radix draws them) over the start of a line: the covered
  // part is hidden, not overlapping, and the rest of the line touches nothing. No finding.
  "#/popover": `<div class="page" data-screen="popover"><div class="stage">
    <p class="at" style="top: 0">A line of chat text the open popover covers at its start, and that nothing else touches at all</p>
    <div class="positioner" style="top: 14px; left: 34px"><div class="popover"><p>Max agents</p><p>6 of 12 running</p></div></div>
  </div></div>`,
  // What the popover rule must still report: text seen through a see-through popover, text overlapping inside a
  // popover, and an overlap on the uncovered end of a line a popover covers in part. That line is in flow and the
  // label over it is not, so only the text-run check (not the sibling-box one) can see their overlap.
  "#/popover-bad": `<div class="page" data-screen="popover-bad"><div class="stage">
    <p class="at" style="top: 0" data-testid="exp-overlap-clear-a">A line the see-through popover is drawn over</p>
    <div class="positioner" style="top: 26px; left: 34px"><div class="popover-clear"><p data-testid="exp-overlap-clear-b">Max agents</p></div></div>
    <div class="positioner" style="top: 104px; left: 34px"><div class="popover"><p data-testid="exp-overlap-inside-a">First line in the popover</p><p style="margin-top: -20px" data-testid="exp-overlap-inside-b">drawn over by the second</p></div></div>
    <p class="flow" style="margin-top: 200px" data-testid="exp-overlap-partial-a">A long line whose start the popover covers and whose end another label is drawn over</p>
    <span class="at" style="top: 202px; left: 520px" data-testid="exp-overlap-partial-b">badge</span>
    <div class="positioner" style="top: 216px; left: 24px"><div class="popover narrow"><p>Covers the start</p></div></div>
  </div></div>`,
  // A route to an order the fixture doesn't have.
  "#/order/W2": `<div class="page" data-screen="order.not-found"><p>This order doesn't exist.</p></div>`,
  // Every marked element must be reported, and nothing else.
  "#/bad": `<div class="page" data-screen="bad">
    <div class="case w200 nowrap clip" data-testid="exp-overflow-clip">A long single line clipped at the edge with no ellipsis at all</div>
    <div class="case w200 nowrap" data-testid="exp-overflow-spill">A long single line that spills out of its box to the right</div>
    <div class="case w200 short clip" data-testid="exp-overflow-bottom">A paragraph that wraps onto three lines inside a box only one line tall, so the rest is cut</div>
    <div class="case chip" data-testid="exp-overflow-descender"><span class="chip-label">devbox · suggested</span></div>
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
    <div class="case scroller">
      ${Array.from({ length: 9 }, (_, i) => `<div>Row ${i + 1} in a list that scrolls</div>`).join("")}
      <div data-testid="exp-overlap-scrolled-a">A row far below the fold</div>
      <div class="pull-up" data-testid="exp-overlap-scrolled-b">drawn over by the next one</div>
    </div>
    <div class="case scroller"><div class="sticky-clear" data-testid="exp-overlap-sticky-a">See-through sticky header</div>${Array.from({ length: 12 }, (_, i) => `<div data-testid="exp-overlap-sticky-b">Row ${i + 1} shows through it</div>`).join("")}</div>
    <div class="case pane" data-testid="exp-overflow-flexchild"><div class="row"><span>W1</span><div class="grow"><div class="ellipsis">A flex child without min-width grows to its text, so the pane cuts the line</div></div></div></div>
    <div class="case flex-ellipsis" data-testid="exp-overflow-flexellipsis">A flex container never draws an ellipsis, so this is just cut off</div>
    <p class="case">Hidden label<span class="sr-only" data-testid="exp-raw-sronly">order eac3e0fe-ec61-4954-4f78-67240a80c42b</span></p>
    <span class="edge-left" data-testid="exp-edge-left">Touching the left edge</span>
    <button class="edge-right" data-testid="exp-edge-right">Right</button>
    <div class="case drag-bar"><button data-testid="exp-drag-inside">Close</button></div>
    <div class="case drag-stack"><div class="drag-bar"></div><div class="over-bar"><button data-testid="exp-drag-over">Close</button></div></div>
    <div class="case drag-stack"><div class="over-bar no-drag"><button data-testid="exp-drag-under">Close</button></div><div class="drag-bar"></div></div>
  </div>`,
};

// The palette has no route: Ctrl/Cmd+K brings it up over the current page, as in the app.
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && !document.querySelector("[data-screen='palette']")) {
    document.body.insertAdjacentHTML("beforeend", `<div class="palette" data-screen="palette"><p>Go to an order</p></div>`);
  }
});

const render = () => {
  document.body.innerHTML = pages[location.hash || "#/"] ?? `<p data-screen="missing">No page ${location.hash}</p>`;
};
window.addEventListener("hashchange", render);
render();
