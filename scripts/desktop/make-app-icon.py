#!/usr/bin/env python3
"""生成应用源图标（1024×1024 PNG）。

为什么用脚本画而不是丢一张图进仓库：
- 图标是产品的一部分，改了要能 diff、要能重来；一张二进制图做不到这两点；
- 没有外部依赖（只用标准库 zlib/struct），任何机器上都能重新生成。

形状是纯几何 + SDF（有向距离场）抗锯齿，没有字体依赖 ——
换机器不会因为字体不同画出不一样的东西。

用法：
    python scripts/desktop/make-app-icon.py src-tauri/icons/app-icon.png
然后：
    npx tauri icon src-tauri/icons/app-icon.png      # 生成 .ico / .icns / 各尺寸 PNG
"""

import math
import struct
import sys
import zlib

SIZE = 1024

# ── 配色 ──────────────────────────────────────────────────────────────
# 墨蓝底 + 米白纸 + 绯红书签：远看是"一本书插着书签"，16px 下也认得出。
BG_TOP = (0x26, 0x33, 0x52)
BG_BOTTOM = (0x14, 0x1D, 0x31)
SHADOW = (0x06, 0x0A, 0x14)
PAPER = (0xF6, 0xF2, 0xE7)
INK_LINE = (0x9B, 0xA4, 0xB9)
RIBBON = (0xC0, 0x4A, 0x3E)

# ── 几何（都在 1024 坐标系里） ────────────────────────────────────────
BG_RADIUS = 190

PAGE = (300.0, 212.0, 724.0, 812.0)   # x0, y0, x1, y1
PAGE_RADIUS = 34.0

RIBBON_X0, RIBBON_X1 = 456.0, 568.0
RIBBON_Y0, RIBBON_Y1 = 158.0, 404.0
NOTCH_R = 56.0                        # 书签下端的 V 形缺口

# 正文行。书签占住页面上部，正文从它下面开始，整页铺满 ——
# 之前把行都堆在上半部分，缩到 16px 会变成一个"上重下空"的色块。
LINES = [
    (352.0, 448.0, 672.0, 478.0),
    (352.0, 530.0, 672.0, 560.0),
    (352.0, 612.0, 672.0, 642.0),
    (352.0, 694.0, 560.0, 724.0),     # 最后一行短一点，像写到一半
]


def round_rect(px, py, x0, y0, x1, y1, r):
    """圆角矩形有向距离：<0 在内部，>0 在外部，数值约等于到边的像素距离。"""
    cx, cy = (x0 + x1) * 0.5, (y0 + y1) * 0.5
    hx, hy = (x1 - x0) * 0.5 - r, (y1 - y0) * 0.5 - r
    dx = abs(px - cx) - hx
    dy = abs(py - cy) - hy
    ax, ay = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ax, ay) + min(max(dx, dy), 0.0) - r


def diamond(px, py, cx, cy, r):
    """菱形距离（L1 球）。用来在书签下端挖出 V 形缺口。"""
    return abs(px - cx) + abs(py - cy) - r


def cov(sdf):
    """1 像素宽的抗锯齿覆盖率。"""
    return min(1.0, max(0.0, 0.5 - sdf))


def over(dst, src, alpha):
    """sRGB 空间的普通 alpha 合成（这个尺寸下够用，不值得上线性空间）。"""
    if alpha <= 0.0:
        return dst
    a = min(1.0, alpha)
    return tuple(dst[i] * (1.0 - a) + src[i] * a for i in range(3))


def render():
    px = bytearray(SIZE * SIZE * 4)
    for y in range(SIZE):
        sy = y + 0.5
        # 背景渐变，整幅图共用，先算一遍
        t = sy / SIZE
        bg = tuple(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t for i in range(3))
        row = y * SIZE * 4
        for x in range(SIZE):
            sx = x + 0.5

            # 圆角方形之外的像素保持透明
            a_bg = cov(round_rect(sx, sy, 0.0, 0.0, SIZE * 1.0, SIZE * 1.0, BG_RADIUS))
            if a_bg <= 0.0:
                continue

            c = bg

            # 纸片投影：同一个矩形下移一些、放大一些、边缘拉软
            s_shadow = round_rect(sx, sy - 20.0, *PAGE, PAGE_RADIUS + 16.0)
            c = over(c, SHADOW, min(1.0, max(0.0, 0.5 - s_shadow / 34.0)) * 0.5)

            # 纸
            c = over(c, PAPER, cov(round_rect(sx, sy, *PAGE, PAGE_RADIUS)))

            # 正文行
            for (lx0, ly0, lx1, ly1) in LINES:
                a = cov(round_rect(sx, sy, lx0, ly0, lx1, ly1, (ly1 - ly0) * 0.5))
                if a > 0.0:
                    c = over(c, INK_LINE, a)

            # 书签：矩形挖掉下端一个菱形，得到 V 形尾巴
            s_rib = round_rect(sx, sy, RIBBON_X0, RIBBON_Y0, RIBBON_X1, RIBBON_Y1, 8.0)
            s_rib = max(s_rib, -diamond(sx, sy, (RIBBON_X0 + RIBBON_X1) * 0.5, RIBBON_Y1, NOTCH_R))
            a_rib = cov(s_rib)
            if a_rib > 0.0:
                c = over(c, RIBBON, a_rib)

            o = row + x * 4
            px[o] = int(c[0] + 0.5)
            px[o + 1] = int(c[1] + 0.5)
            px[o + 2] = int(c[2] + 0.5)
            px[o + 3] = int(a_bg * 255.0 + 0.5)
    return px


def write_png(path, w, h, rgba):
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0 (None)
        raw.extend(rgba[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8bit RGBA
    blob = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(blob)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "src-tauri/icons/app-icon.png"
    write_png(out, SIZE, SIZE, render())
    print(f"已写出 {out}（{SIZE}x{SIZE}）")


if __name__ == "__main__":
    main()
