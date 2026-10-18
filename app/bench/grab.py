#!/usr/bin/env python3
"""Constant-rate X11 screen grabber for app/bench/record.sh. Run with `python3 -I`.

Writes one JPEG per tick to stdout (for ffmpeg's image2pipe), at exactly --fps: when a grab falls behind, the
previous frame is written again, so the stream's timing is wall-clock real. --png writes one still and exits.

    grab.py --display :47 --fps 60 --region 0,0,1440,900 [--seconds 30] | ffmpeg -f image2pipe -c:v mjpeg ...
    grab.py --display :47 --region 0,0,1440,900 --png still.png
"""

import argparse
import io
import signal
import sys
import time

from PIL import ImageGrab


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--display", required=True)
    p.add_argument("--fps", type=float, default=60.0)
    p.add_argument("--region", default="0,0,1440,900", help="x,y,width,height")
    p.add_argument("--seconds", type=float, default=None)
    p.add_argument("--png", default=None)
    a = p.parse_args()
    x, y, w, h = (int(v) for v in a.region.split(","))
    box = (x, y, x + w, y + h)

    def grab():
        return ImageGrab.grab(bbox=box, xdisplay=a.display).convert("RGB")

    if a.png:
        grab().save(a.png)
        return 0

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    out = sys.stdout.buffer
    period = 1.0 / a.fps
    total = None if a.seconds is None else int(a.seconds * a.fps)
    start = time.monotonic()
    n, last, repeated = 0, None, 0
    try:
        while total is None or n < total:
            due = start + n * period
            now = time.monotonic()
            if now < due:
                time.sleep(due - now)
            if last is not None and time.monotonic() > due + period:
                repeated += 1
            else:
                buf = io.BytesIO()
                grab().save(buf, "JPEG", quality=92)
                last = buf.getvalue()
            out.write(last)
            n += 1
    except (BrokenPipeError, KeyboardInterrupt, SystemExit):
        pass
    finally:
        print(f"grab.py: {n} frames at {a.fps:g} fps, {repeated} repeated", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
