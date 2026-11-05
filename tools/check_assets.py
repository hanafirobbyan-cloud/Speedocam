#!/usr/bin/env python3
"""Verifies the service worker precache list: every listed file exists and every app file is listed.

Run before deploying (the GitHub workflow runs it automatically): python3 tools/check_assets.py
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def main():
    sw = open(os.path.join(ROOT, "sw.js"), encoding="utf-8").read()
    block = re.search(r"const ASSETS = \[(.*?)\];", sw, re.S)
    if not block:
        print("ASSETS list not found in sw.js")
        return 1
    listed = re.findall(r"'\./([^']*)'", block.group(1))
    errors = []
    for rel in listed:
        if rel and not os.path.isfile(os.path.join(ROOT, rel)):
            errors.append(f"listed but missing: {rel}")

    required = ["index.html", "manifest.webmanifest"]
    for folder, exts in (("js", (".js",)), ("css", (".css",)), ("icons", (".png",))):
        for dirpath, _, files in os.walk(os.path.join(ROOT, folder)):
            for f in files:
                if f.endswith(exts):
                    required.append(os.path.relpath(os.path.join(dirpath, f), ROOT).replace(os.sep, "/"))
    for rel in required:
        if rel not in listed:
            errors.append(f"not precached (add to sw.js ASSETS): {rel}")

    for e in errors:
        print("ERROR:", e)
    if not errors:
        print(f"OK: {len(listed)} precached assets verified")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
