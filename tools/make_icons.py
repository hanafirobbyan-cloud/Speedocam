#!/usr/bin/env python3
"""Generates the SpeedoCam PNG icons with no dependencies (signed-distance-field rasterizer).

Usage: python3 tools/make_icons.py   (writes into ./icons)
"""
import math
import os
import struct
import zlib

BG = (11, 11, 12)
TRACK = (58, 58, 60)
ACCENT = (255, 159, 10)
WHITE = (245, 245, 247)
RED = (255, 69, 58)

CX, CY = 0.5, 0.53
R, T = 0.30, 0.065
A0, SWEEP = 135.0, 270.0
VALUE = 0.62  # fraction of the arc that is "lit"


def arc_sdf(x, y, start, sweep):
    dx, dy = x - CX, y - CY
    dist = math.hypot(dx, dy)
    ang = (math.degrees(math.atan2(dy, dx)) - start) % 360.0
    if ang <= sweep:
        return abs(dist - R) - T / 2
    best = 1e9
    for a in (start, start + sweep):
        ex = CX + R * math.cos(math.radians(a))
        ey = CY + R * math.sin(math.radians(a))
        best = min(best, math.hypot(x - ex, y - ey))
    return best - T / 2


def capsule_sdf(x, y, ax, ay, bx, by, r):
    pax, pay = x - ax, y - ay
    bax, bay = bx - ax, by - ay
    h = max(0.0, min(1.0, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
    return math.hypot(pax - bax * h, pay - bay * h) - r


def circle_sdf(x, y, cx, cy, r):
    return math.hypot(x - cx, y - cy) - r


def render(size, scale=1.0):
    px = 1.0 / size
    needle_a = math.radians(A0 + SWEEP * VALUE)
    nx, ny = CX + 0.24 * math.cos(needle_a), CY + 0.24 * math.sin(needle_a)
    rows = []
    for j in range(size):
        row = bytearray([0])  # PNG filter type 0
        for i in range(size):
            # map pixel center into content space, scaled about the center (maskable safe zone)
            x = 0.5 + ((i + 0.5) / size - 0.5) / scale
            y = 0.5 + ((j + 0.5) / size - 0.5) / scale
            p = px / scale
            col = list(BG)

            def over(c, d):
                a = max(0.0, min(1.0, 0.5 - d / p))
                if a > 0:
                    for k in range(3):
                        col[k] = col[k] * (1 - a) + c[k] * a

            over(TRACK, arc_sdf(x, y, A0, SWEEP))
            over(ACCENT, arc_sdf(x, y, A0, SWEEP * VALUE))
            over(WHITE, capsule_sdf(x, y, CX, CY, nx, ny, 0.018))
            over(WHITE, circle_sdf(x, y, CX, CY, 0.045))
            over(BG, circle_sdf(x, y, CX, CY, 0.018))
            over(RED, circle_sdf(x, y, CX, 0.80, 0.045))
            row.extend(int(round(c)) for c in col)
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path, size, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(out, exist_ok=True)
    jobs = [
        ("apple-touch-icon.png", 180, 1.0),
        ("icon-192.png", 192, 1.0),
        ("icon-512.png", 512, 1.0),
        ("icon-maskable-512.png", 512, 0.78),
    ]
    for name, size, scale in jobs:
        write_png(os.path.join(out, name), size, render(size, scale))
        print("wrote", name)


if __name__ == "__main__":
    main()
