"""The local update feed for desktop-update-check.sh: the files in a directory, with single byte ranges as GitHub's
asset store answers them, so the app's differential download runs as it does against a release.

  python3 -I feed-server.py <dir> <port>
"""
import http.server
import os
import re
import sys

root, port = sys.argv[1], int(sys.argv[2])


class Feed(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=root, **kwargs)

    def send_head(self):
        match = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
        path = self.translate_path(self.path)
        if match is None or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start = int(match.group(1))
        end = min(int(match.group(2)) if match.group(2) else size - 1, size - 1)
        if start > end:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self.left = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        left = getattr(self, "left", None)
        if left is None:
            return super().copyfile(source, outputfile)
        while left > 0:
            chunk = source.read(min(65536, left))
            if not chunk:
                break
            outputfile.write(chunk)
            left -= len(chunk)


http.server.ThreadingHTTPServer(("127.0.0.1", port), Feed).serve_forever()
