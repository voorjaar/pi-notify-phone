#!/usr/bin/env python3
"""Render the pi logo mark as square PNG notification icons.

Geometry is taken from https://pi.dev/logo-auto.svg (viewBox 0 0 800 800), redrawn by hand so
the icons need no image libraries. Run from the repository root:

    python3 assets/make-icon.py
"""

import struct
import zlib
from pathlib import Path

ASSETS_DIR = Path(__file__).resolve().parent

SHAPES = [
    (
        (0xF0, 0x90, 0x82, 255),
        [(165.29, 165.29), (517.36, 165.29), (517.36, 400), (400, 400), (400, 282.65), (165.29, 282.65)],
    ),
    (
        (0x4D, 0x9A, 0xBF, 255),
        [
            (165.29, 282.65),
            (282.65, 282.65),
            (282.65, 400),
            (400, 400),
            (400, 517.36),
            (282.65, 517.36),
            (282.65, 634.72),
            (165.29, 634.72),
        ],
    ),
    ((0xF1, 0xBE, 0x58, 255), [(517.36, 400), (634.72, 400), (634.72, 634.72), (517.36, 634.72)]),
]

TRANSPARENT = (0, 0, 0, 0)


def inside_polygon(polygon, x, y):
    """Even-odd point-in-polygon test."""
    hit = False
    count = len(polygon)
    for index in range(count):
        x1, y1 = polygon[index]
        x2, y2 = polygon[(index + 1) % count]
        if (y1 > y) != (y2 > y):
            t = (y - y1) / (y2 - y1)
            if x < x1 + t * (x2 - x1):
                hit = not hit
    return hit


def render(size, samples):
    """Render the mark at `size` pixels, supersampled by `samples` and averaged down."""
    super_size = size * samples
    scale = 800.0 / super_size
    grid = [[TRANSPARENT] * super_size for _ in range(super_size)]

    for pixel_y in range(super_size):
        y = (pixel_y + 0.5) * scale
        row = grid[pixel_y]
        for color, polygon in SHAPES:
            xs = [point[0] for point in polygon]
            ys = [point[1] for point in polygon]
            if not (min(ys) <= y < max(ys)):
                continue
            first = max(0, int(min(xs) / scale))
            last = min(super_size - 1, int(max(xs) / scale) + 1)
            for pixel_x in range(first, last + 1):
                if inside_polygon(polygon, (pixel_x + 0.5) * scale, y):
                    row[pixel_x] = color

    if samples == 1:
        return grid

    pixels = []
    for block_y in range(size):
        row = []
        for block_x in range(size):
            totals = [0, 0, 0, 0]
            for offset_y in range(samples):
                for offset_x in range(samples):
                    color = grid[block_y * samples + offset_y][block_x * samples + offset_x]
                    for channel in range(4):
                        totals[channel] += color[channel]
            row.append(tuple(value // (samples * samples) for value in totals))
        pixels.append(row)
    return pixels


def chunk(tag, data):
    body = tag + data
    crc = zlib.crc32(body) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + body + struct.pack(">I", crc)


def write_png(path, pixels):
    size = len(pixels)
    raw = b""
    for row in pixels:
        raw += b"\x00" + b"".join(struct.pack("4B", *color) for color in row)

    data = b"\x89PNG\r\n\x1a\n"
    data += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9))
    data += chunk(b"IEND", b"")

    try:
        with open(path, "wb") as handle:
            handle.write(data)
    except OSError as error:
        raise SystemExit(f"could not write {path}: {error}") from error


def main():
    write_png(ASSETS_DIR / "pi-icon.png", render(512, 2))
    write_png(ASSETS_DIR / "pi-icon-128.png", render(128, 4))
    print(f"wrote {ASSETS_DIR / 'pi-icon.png'} and {ASSETS_DIR / 'pi-icon-128.png'}")


if __name__ == "__main__":
    main()
