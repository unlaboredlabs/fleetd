// A live frame's way from the node to the app, hop by hop as fleetd's real code does it, timed: the node link's JSON
// and deflate (src/node/link), the hub's inflate, parse and the app connection's JSON and deflate (src/hub/browser/
// app.ts, src/hub/app_ws), and the desktop app's inflate and parse (app/desktop/src/main/hub/transport.ts). The
// network itself is the bench's to add (scripts/netem.ts); this is the CPU and bytes of each hop.
import type { BrowserFrame } from "../../src/shared/contracts.ts";
import { Deflater, Inflater } from "../../src/node/link/deflate.ts";

const MAX = 64 << 20;

export type Hops = { nodeMs: number; hubMs: number; appMs: number; linkBytes: number; appBytes: number };

/** One watched screen's frames through every hop, with each hop's zlib window kept between frames as the links keep it. */
export class Wire {
  private readonly nodeOut = new Deflater();
  private readonly hubIn = new Inflater(MAX);
  private readonly hubOut = new Deflater();
  private readonly appIn = new Inflater(MAX);
  readonly totals: Hops = { nodeMs: 0, hubMs: 0, appMs: 0, linkBytes: 0, appBytes: 0 };
  frames = 0;

  async carry(frame: BrowserFrame): Promise<{ frame: BrowserFrame; hops: Hops }> {
    let t = performance.now();
    const linkData = await this.nodeOut.deflate(JSON.stringify({ t: "browser_frame", ...frame }));
    const nodeMs = performance.now() - t;
    t = performance.now();
    const atHub = JSON.parse(await this.hubIn.inflate(linkData)) as BrowserFrame & { t?: string };
    delete atHub.t;
    const appData = await this.hubOut.deflate(JSON.stringify({ ...atHub, t: "browser_frame" }));
    const hubMs = performance.now() - t;
    t = performance.now();
    const atApp = JSON.parse(await this.appIn.inflate(appData)) as BrowserFrame;
    const appMs = performance.now() - t;
    const hops = { nodeMs, hubMs, appMs, linkBytes: linkData.length, appBytes: appData.length };
    for (const k of Object.keys(hops) as (keyof Hops)[]) this.totals[k] += hops[k];
    this.frames++;
    return { frame: atApp, hops };
  }

  close(): void {
    for (const z of [this.nodeOut, this.hubIn, this.hubOut, this.appIn]) z.close();
  }
}
