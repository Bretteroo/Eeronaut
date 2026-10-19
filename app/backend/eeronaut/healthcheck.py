"""The Docker image's health check: does Eeronaut answer on its port?

A module rather than a line in the Dockerfile, because in Home Assistant the
port comes from the app's options, which only Eeronaut's own code reads.
"""
from __future__ import annotations

import os
import sys
import urllib.request

from .core import haoptions


def main() -> int:
    haoptions.apply()
    port = os.environ.get("EERONAUT_PORT") or "3340"
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=4) as r:
            return 0 if r.status == 200 else 1
    except OSError:
        return 1


if __name__ == "__main__":
    sys.exit(main())
